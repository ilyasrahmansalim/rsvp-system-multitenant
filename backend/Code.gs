/**
 * RSVP Event Multi-Tenant — Google Apps Script backend
 * ----------------------------------------------------
 * Satu script melayani banyak event. Setiap request POST membawa `spreadsheet_id`
 * (dari file .toml event), sehingga data tiap event masuk ke Google Sheet-nya sendiri.
 *
 * Request  : POST (Content-Type: text/plain;charset=utf-8, body JSON)
 *   { action, spreadsheet_id, event_id, has_assignment, token?, data? }
 * Response : { ok: true, data } atau { ok: false, error }
 *
 * Action   : register | login | me | submit_assignment | logout
 *
 * Sheet yang dibuat otomatis di tiap spreadsheet event:
 *   Users    -> data peserta, status, penugasan, kode tiket
 *   Sessions -> token sesi (hanya disimpan dalam bentuk hash)
 *   Config   -> (opsional, buat manual) override aturan server, lihat README
 *
 * Script Properties (Project Settings -> Script properties):
 *   ALLOWED_SPREADSHEET_IDS = id1,id2,id3   (SANGAT DISARANKAN, lihat README)
 */

var SHEET_USERS = 'Users';
var SHEET_SESSIONS = 'Sessions';
var SHEET_CONFIG = 'Config';

var USER_HEADERS = [
  'id', 'event_id', 'name', 'email', 'phone', 'password_hash', 'salt', 'status',
  'created_at', 'assignment_url', 'assignment_name', 'assignment_note',
  'assignment_submitted_at', 'ticket_code'
];
var SESSION_HEADERS = ['token_hash', 'user_id', 'expires_at', 'created_at'];

var SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari
var MAX_FILE_BYTES = 5 * 1024 * 1024;         // 5 MB
var ALLOWED_EXT = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'zip', 'png', 'jpg', 'jpeg'];
var ASSIGNMENT_ROOT_FOLDER = 'RSVP Assignments';

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({ ok: true, data: { message: 'RSVP backend aktif. Gunakan POST.' } });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var req = parseBody_(e);
    var action = String(req.action || '');
    var spreadsheetId = String(req.spreadsheet_id || '').trim();

    assertSpreadsheetAllowed_(spreadsheetId);
    lock.waitLock(20000);

    var ctx = buildContext_(req, spreadsheetId);
    var data = req.data || {};
    var result;

    switch (action) {
      case 'register':          result = register_(ctx, data); break;
      case 'login':             result = login_(ctx, data); break;
      case 'me':                result = me_(ctx, req.token); break;
      case 'submit_assignment': result = submitAssignment_(ctx, req.token, data); break;
      case 'logout':            result = logout_(ctx, req.token); break;
      default: throw new Error('Action tidak dikenal: ' + action);
    }
    return json_({ ok: true, data: result });
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: (err && err.message) ? err.message : String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* ------------------------------------------------------------------ */
/* Action handlers                                                     */
/* ------------------------------------------------------------------ */

function register_(ctx, data) {
  var name = clean_(data.name);
  var email = normalizeEmail_(data.email);
  var phone = clean_(data.phone);
  var password = String(data.password || '');

  if (name.length < 2) throw new Error('Nama minimal 2 karakter.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Format email tidak valid.');
  if (password.length < 8) throw new Error('Password minimal 8 karakter.');
  if (findUserByEmail_(ctx, email)) throw new Error('Email sudah terdaftar. Silakan masuk.');

  var salt = randomHex_(16);
  var now = new Date().toISOString();
  var user = {
    id: Utilities.getUuid(),
    event_id: ctx.eventId,
    name: safeCell_(name),
    email: email,
    phone: safeCell_(phone),
    password_hash: hashPassword_(password, salt),
    salt: salt,
    status: 'registered',
    created_at: now,
    assignment_url: '',
    assignment_name: '',
    assignment_note: '',
    assignment_submitted_at: '',
    ticket_code: 'TKT-' + randomHex_(4).toUpperCase()
  };
  ctx.users.appendRow(objToRow_(USER_HEADERS, user));

  return { token: createSession_(ctx, user.id), user: publicUser_(ctx, user) };
}

function login_(ctx, data) {
  var email = normalizeEmail_(data.email);
  var password = String(data.password || '');
  var found = findUserByEmail_(ctx, email);

  // Pesan sama untuk email salah / password salah (hindari user enumeration).
  var invalid = new Error('Email atau password salah.');
  if (!found) throw invalid;
  if (hashPassword_(password, found.user.salt) !== found.user.password_hash) throw invalid;

  return { token: createSession_(ctx, found.user.id), user: publicUser_(ctx, found.user) };
}

function me_(ctx, token) {
  var found = requireUser_(ctx, token);
  return { user: publicUser_(ctx, found.user) };
}

function submitAssignment_(ctx, token, data) {
  var found = requireUser_(ctx, token);
  if (!requiresAssignment_(ctx)) throw new Error('Event ini tidak memerlukan penugasan.');

  var filename = clean_(data.filename);
  var ext = (filename.split('.').pop() || '').toLowerCase();
  if (!filename || ALLOWED_EXT.indexOf(ext) === -1) {
    throw new Error('Tipe file tidak diizinkan. Gunakan: ' + ALLOWED_EXT.join(', ') + '.');
  }
  if (!data.base64) throw new Error('File kosong.');

  var bytes = Utilities.base64Decode(String(data.base64));
  if (bytes.length > MAX_FILE_BYTES) throw new Error('Ukuran file maksimal 5 MB.');

  var safeName = found.user.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'peserta';
  var blob = Utilities.newBlob(bytes, String(data.mime_type || 'application/octet-stream'),
    safeName + '_' + String(found.user.id).substring(0, 8) + '_' + filename.replace(/[^\w.\-]+/g, '_'));
  var file = getEventFolder_(ctx.eventId).createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // Domain Workspace bisa melarang berbagi publik; link tetap bisa dibuka oleh panitia (pemilik).
  }

  var u = found.user;
  u.assignment_url = file.getUrl();
  u.assignment_name = safeCell_(filename);
  u.assignment_note = safeCell_(clean_(data.note).substring(0, 500));
  u.assignment_submitted_at = new Date().toISOString();
  if (u.status === 'registered') u.status = 'assignment_submitted';
  saveUser_(ctx, found.row, u);

  return { user: publicUser_(ctx, u) };
}

function logout_(ctx, token) {
  if (token) {
    var hash = sha256Hex_(String(token));
    var values = ctx.sessions.getDataRange().getValues();
    for (var i = values.length - 1; i >= 1; i--) {
      if (values[i][0] === hash) ctx.sessions.deleteRow(i + 1);
    }
  }
  return { loggedOut: true };
}

/* ------------------------------------------------------------------ */
/* Context, access control, config                                     */
/* ------------------------------------------------------------------ */

function buildContext_(req, spreadsheetId) {
  var eventId = clean_(req.event_id);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(eventId)) throw new Error('event_id tidak valid.');

  var ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (e) {
    throw new Error('Spreadsheet tidak ditemukan atau script tidak punya akses ke sheet tersebut.');
  }
  return {
    ss: ss,
    eventId: eventId,
    payloadHasAssignment: req.has_assignment === true,
    users: ensureSheet_(ss, SHEET_USERS, USER_HEADERS),
    sessions: ensureSheet_(ss, SHEET_SESSIONS, SESSION_HEADERS)
  };
}

function assertSpreadsheetAllowed_(spreadsheetId) {
  if (!spreadsheetId) throw new Error('spreadsheet_id wajib diisi.');
  var raw = PropertiesService.getScriptProperties().getProperty('ALLOWED_SPREADSHEET_IDS');
  if (!raw) return; // tidak ada allowlist -> semua ID diterima (kurang aman)
  var allowed = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (allowed.indexOf(spreadsheetId) === -1) throw new Error('Spreadsheet tidak diizinkan.');
}

/**
 * Apakah tiket butuh penugasan? Jika tab "Config" punya baris `has_assignment`
 * (kolom A = key, kolom B = true/false), nilai itu menang atas data dari frontend,
 * sehingga aturan tidak bisa dimanipulasi dari browser.
 */
function requiresAssignment_(ctx) {
  var sheet = ctx.ss.getSheetByName(SHEET_CONFIG);
  if (sheet && sheet.getLastRow() > 0) {
    var rows = sheet.getDataRange().getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0]).trim() === 'has_assignment') {
        return String(rows[i][1]).trim().toLowerCase() === 'true';
      }
    }
  }
  return ctx.payloadHasAssignment;
}

function publicUser_(ctx, u) {
  var unlocked = !requiresAssignment_(ctx) || !!u.assignment_submitted_at;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    status: u.status,
    created_at: u.created_at,
    assignment_url: u.assignment_url || '',
    assignment_name: u.assignment_name || '',
    assignment_submitted_at: u.assignment_submitted_at || '',
    ticket_unlocked: unlocked,
    ticket_code: unlocked ? u.ticket_code : '' // kode tiket tidak dikirim selama terkunci
  };
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

function createSession_(ctx, userId) {
  pruneSessions_(ctx);
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  var now = Date.now();
  ctx.sessions.appendRow([sha256Hex_(token), userId, now + SESSION_TTL_MS, now]);
  return token;
}

function requireUser_(ctx, token) {
  if (!token) throw new Error('Sesi tidak ditemukan. Silakan masuk kembali.');
  var hash = sha256Hex_(String(token));
  var values = ctx.sessions.getDataRange().getValues();
  var userId = null;
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === hash) {
      if (Number(values[i][2]) < Date.now()) throw new Error('Sesi berakhir. Silakan masuk kembali.');
      userId = values[i][1];
      break;
    }
  }
  if (!userId) throw new Error('Sesi tidak valid. Silakan masuk kembali.');

  var users = readUsers_(ctx);
  for (var j = 0; j < users.length; j++) {
    if (users[j].user.id === userId) return users[j];
  }
  throw new Error('Akun tidak ditemukan.');
}

function pruneSessions_(ctx) {
  var values = ctx.sessions.getDataRange().getValues();
  var now = Date.now();
  for (var i = values.length - 1; i >= 1; i--) {
    if (Number(values[i][2]) < now) ctx.sessions.deleteRow(i + 1);
  }
}

/* ------------------------------------------------------------------ */
/* Sheet helpers                                                       */
/* ------------------------------------------------------------------ */

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readUsers_(ctx) {
  var values = ctx.users.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var user = rowToObj_(USER_HEADERS, values[i]);
    if (user.event_id === ctx.eventId) out.push({ row: i + 1, user: user });
  }
  return out;
}

function findUserByEmail_(ctx, email) {
  var users = readUsers_(ctx);
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].user.email).toLowerCase() === email) return users[i];
  }
  return null;
}

function saveUser_(ctx, rowIndex, user) {
  ctx.users.getRange(rowIndex, 1, 1, USER_HEADERS.length).setValues([objToRow_(USER_HEADERS, user)]);
}

function rowToObj_(headers, row) {
  var obj = {};
  for (var i = 0; i < headers.length; i++) obj[headers[i]] = row[i] === undefined ? '' : row[i];
  return obj;
}

function objToRow_(headers, obj) {
  return headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; });
}

function getEventFolder_(eventId) {
  var root = getOrCreateFolder_(DriveApp.getRootFolder(), ASSIGNMENT_ROOT_FOLDER);
  return getOrCreateFolder_(root, eventId);
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ------------------------------------------------------------------ */
/* Utils                                                               */
/* ------------------------------------------------------------------ */

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error('Body request kosong.');
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error('Body request bukan JSON yang valid.');
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function clean_(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}

function normalizeEmail_(v) {
  return clean_(v).toLowerCase();
}

/** Cegah formula injection di Google Sheets (=, +, -, @ di awal sel). */
function safeCell_(v) {
  var s = clean_(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function randomHex_(bytes) {
  var out = '';
  while (out.length < bytes * 2) out += Utilities.getUuid().replace(/-/g, '');
  return out.substring(0, bytes * 2);
}

function toHex_(byteArray) {
  return byteArray.map(function (b) {
    var v = b < 0 ? b + 256 : b;
    return (v < 16 ? '0' : '') + v.toString(16);
  }).join('');
}

function sha256Hex_(text) {
  return toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}

function hashPassword_(password, salt) {
  var h = salt + ':' + password;
  for (var i = 0; i < 1000; i++) h = sha256Hex_(h + salt);
  return h;
}

/* ------------------------------------------------------------------ */
/* Dijalankan manual dari editor Apps Script (opsional)                */
/* ------------------------------------------------------------------ */

/** Jalankan sekali untuk membatasi spreadsheet yang boleh diakses backend ini. */
function setAllowedSpreadsheets() {
  var ids = [
    'GANTI_DENGAN_ID_SHEET_DEMO_EVENT',
    'GANTI_DENGAN_ID_SHEET_SIMPLE_EVENT'
  ];
  PropertiesService.getScriptProperties().setProperty('ALLOWED_SPREADSHEET_IDS', ids.join(','));
}
