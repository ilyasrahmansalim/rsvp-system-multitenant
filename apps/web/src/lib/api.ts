/**
 * Klien API untuk backend Google Apps Script.
 * Jika PUBLIC_GAS_URL kosong -> MODE DEMO: semua data disimpan di localStorage browser
 * sehingga alur register -> login -> penugasan -> tiket bisa dicoba tanpa backend.
 */
import {
  ACTIONS,
  MAX_ASSIGNMENT_BYTES,
  type Action,
  type ApiRequest,
  type ApiResponse,
  type AssignmentPayload,
  type AuthResult,
  type RsvpUser,
} from '@rsvp/shared';

export interface EventCtx {
  eventId: string;
  spreadsheetId: string;
  hasAssignment: boolean;
}

const GAS_URL = (import.meta.env.PUBLIC_GAS_URL ?? '').trim();
export const isDemoMode = GAS_URL === '';

export class ApiError extends Error {}

/* ---------------------------- sesi (localStorage) ---------------------------- */

const tokenKey = (ctx: EventCtx) => `rsvp:${ctx.eventId}:token`;

export function getToken(ctx: EventCtx): string | null {
  try {
    return localStorage.getItem(tokenKey(ctx));
  } catch {
    return null;
  }
}
function setToken(ctx: EventCtx, token: string) {
  localStorage.setItem(tokenKey(ctx), token);
}
function clearToken(ctx: EventCtx) {
  localStorage.removeItem(tokenKey(ctx));
}

/* --------------------------------- API publik --------------------------------- */

export async function register(
  ctx: EventCtx,
  data: { name: string; email: string; phone: string; password: string },
): Promise<RsvpUser> {
  const res = await call<AuthResult>(ctx, ACTIONS.REGISTER, data);
  setToken(ctx, res.token);
  return res.user;
}

export async function login(ctx: EventCtx, data: { email: string; password: string }): Promise<RsvpUser> {
  const res = await call<AuthResult>(ctx, ACTIONS.LOGIN, data);
  setToken(ctx, res.token);
  return res.user;
}

/** Mengembalikan null jika belum login / sesi kedaluwarsa. */
export async function fetchMe(ctx: EventCtx): Promise<RsvpUser | null> {
  const token = getToken(ctx);
  if (!token) return null;
  try {
    const res = await call<{ user: RsvpUser }>(ctx, ACTIONS.ME, undefined, token);
    return res.user;
  } catch (err) {
    if (err instanceof ApiError && /sesi/i.test(err.message)) {
      clearToken(ctx);
      return null;
    }
    throw err;
  }
}

export async function submitAssignment(ctx: EventCtx, file: File, note: string): Promise<RsvpUser> {
  if (file.size > MAX_ASSIGNMENT_BYTES) throw new ApiError('Ukuran file maksimal 5 MB.');
  const payload: AssignmentPayload = {
    filename: file.name,
    mime_type: file.type || 'application/octet-stream',
    base64: await fileToBase64(file),
    note,
  };
  const res = await call<{ user: RsvpUser }>(ctx, ACTIONS.SUBMIT_ASSIGNMENT, payload, getToken(ctx) ?? undefined);
  return res.user;
}

export async function logout(ctx: EventCtx): Promise<void> {
  const token = getToken(ctx);
  clearToken(ctx);
  if (!token) return;
  try {
    await call(ctx, ACTIONS.LOGOUT, undefined, token);
  } catch {
    /* sesi lokal sudah dihapus; abaikan error jaringan */
  }
}

/* ------------------------------- transport nyata ------------------------------- */

async function call<T>(ctx: EventCtx, action: Action, data?: unknown, token?: string): Promise<T> {
  if (isDemoMode) return demoCall<T>(ctx, action, data as Record<string, any> | undefined, token);

  const body: ApiRequest = {
    action,
    spreadsheet_id: ctx.spreadsheetId,
    event_id: ctx.eventId,
    has_assignment: ctx.hasAssignment,
    token,
    data: data as Record<string, unknown> | undefined,
  };

  let res: Response;
  try {
    // text/plain menghindari preflight CORS, yang tidak didukung Apps Script.
    res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
    });
  } catch {
    throw new ApiError('Tidak dapat terhubung ke server. Periksa koneksi internet Anda.');
  }

  let json: ApiResponse<T>;
  try {
    json = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError('Respons server tidak valid. Pastikan Web App Apps Script di-deploy dengan akses "Anyone".');
  }
  if (!json.ok) throw new ApiError(json.error || 'Terjadi kesalahan pada server.');
  return json.data as T;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new ApiError('Gagal membaca file.'));
    reader.readAsDataURL(file);
  });
}

/* --------------------------- backend tiruan (mode demo) --------------------------- */

interface DemoUser extends RsvpUser {
  password_hash: string;
  ticket_secret: string;
}
interface DemoDb {
  users: DemoUser[];
  sessions: Record<string, string>;
}

const dbKey = (ctx: EventCtx) => `rsvp-demo:${ctx.eventId}`;
const loadDb = (ctx: EventCtx): DemoDb => {
  try {
    return JSON.parse(localStorage.getItem(dbKey(ctx)) ?? '') as DemoDb;
  } catch {
    return { users: [], sessions: {} };
  }
};
const saveDb = (ctx: EventCtx, db: DemoDb) => localStorage.setItem(dbKey(ctx), JSON.stringify(db));

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function demoPublic(ctx: EventCtx, u: DemoUser): RsvpUser {
  const unlocked = !ctx.hasAssignment || !!u.assignment_submitted_at;
  const { password_hash, ticket_secret, ...rest } = u;
  return { ...rest, ticket_unlocked: unlocked, ticket_code: unlocked ? ticket_secret : '' };
}

async function demoCall<T>(
  ctx: EventCtx,
  action: Action,
  data: Record<string, any> = {},
  token?: string,
): Promise<T> {
  await new Promise((r) => setTimeout(r, 350)); // simulasi latensi jaringan
  const db = loadDb(ctx);
  const userOf = () => {
    const id = token ? db.sessions[token] : undefined;
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new ApiError('Sesi tidak valid. Silakan masuk kembali.');
    return u;
  };
  const newSession = (u: DemoUser) => {
    const t = crypto.randomUUID();
    db.sessions[t] = u.id;
    return t;
  };

  switch (action) {
    case ACTIONS.REGISTER: {
      const email = String(data.email ?? '').trim().toLowerCase();
      if (String(data.name ?? '').trim().length < 2) throw new ApiError('Nama minimal 2 karakter.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError('Format email tidak valid.');
      if (String(data.password ?? '').length < 8) throw new ApiError('Password minimal 8 karakter.');
      if (db.users.some((u) => u.email === email)) throw new ApiError('Email sudah terdaftar. Silakan masuk.');
      const u: DemoUser = {
        id: crypto.randomUUID(),
        name: String(data.name).trim(),
        email,
        phone: String(data.phone ?? '').trim(),
        status: 'registered',
        created_at: new Date().toISOString(),
        assignment_url: '',
        assignment_name: '',
        assignment_submitted_at: '',
        ticket_code: '',
        ticket_unlocked: false,
        password_hash: await sha256(String(data.password)),
        ticket_secret: 'TKT-' + crypto.randomUUID().slice(0, 8).toUpperCase(),
      };
      db.users.push(u);
      const t = newSession(u);
      saveDb(ctx, db);
      return { token: t, user: demoPublic(ctx, u) } as T;
    }
    case ACTIONS.LOGIN: {
      const email = String(data.email ?? '').trim().toLowerCase();
      const u = db.users.find((x) => x.email === email);
      if (!u || u.password_hash !== (await sha256(String(data.password ?? '')))) {
        throw new ApiError('Email atau password salah.');
      }
      const t = newSession(u);
      saveDb(ctx, db);
      return { token: t, user: demoPublic(ctx, u) } as T;
    }
    case ACTIONS.ME:
      return { user: demoPublic(ctx, userOf()) } as T;
    case ACTIONS.SUBMIT_ASSIGNMENT: {
      const u = userOf();
      if (!ctx.hasAssignment) throw new ApiError('Event ini tidak memerlukan penugasan.');
      u.assignment_name = String(data.filename ?? '');
      u.assignment_url = '';
      u.assignment_submitted_at = new Date().toISOString();
      if (u.status === 'registered') u.status = 'assignment_submitted';
      saveDb(ctx, db);
      return { user: demoPublic(ctx, u) } as T;
    }
    case ACTIONS.LOGOUT:
      if (token) delete db.sessions[token];
      saveDb(ctx, db);
      return { loggedOut: true } as T;
  }
}
