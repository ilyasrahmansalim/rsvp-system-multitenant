# RSVP Event Multi-Tenant

Astro (static) + Tailwind CSS + DaisyUI + Sveltia CMS + Google Apps Script, dalam satu monorepo pnpm.

```
rsvp-event-monorepo/
├── package.json · pnpm-workspace.yaml
├── packages/shared/src/index.ts          # kontrak API + tipe (dipakai frontend)
├── backend/
│   ├── Code.gs                           # Google Apps Script (backend)
│   └── appsscript.json                   # manifest (scope & web app)
└── apps/web/
    ├── astro.config.mjs · tailwind.config.mjs
    ├── public/admin/{index.html,config.yml}   # Sveltia CMS  -> /admin
    └── src/
        ├── content/config.ts                  # schema + loader .toml
        ├── content/rsvp/{demo-event,simple-event}.toml
        ├── layouts/EventLayout.astro
        ├── lib/api.ts                         # klien GAS + MODE DEMO
        └── pages/
            ├── index.astro                    # daftar event
            └── [nama_event]/{index,auth,dashboard}.astro
```

> Folder route bernama `[nama_event]` (bukan `[nama-event]`) karena Astro tidak mengizinkan tanda hubung
> pada nama parameter. URL tetap `/<nama-event>/...`.

## Menjalankan

```bash
pnpm install
pnpm dev          # http://localhost:4321
```

Tanpa konfigurasi apa pun aplikasi berjalan dalam **mode demo**: register/login/penugasan/tiket disimpan di
`localStorage` browser, jadi seluruh alur bisa dicoba sebelum backend siap.

- `/demo-event`   → `has_assignment = true`  (QR terkunci sampai penugasan diunggah)
- `/simple-event` → `has_assignment = false` (QR langsung muncul setelah login)
- CMS: buka `/admin/index.html` saat dev (di produksi cukup `/admin`)

Build produksi: `pnpm build` (hasil di `apps/web/dist`).

## Menyambungkan backend Google Apps Script

1. Buat satu Google Sheet **per event** (kosong). Salin ID-nya dari URL: `.../d/<ID>/edit`.
   Tempel ke field `spreadsheet_id` di file `.toml` event (atau lewat CMS).
2. Buka <https://script.google.com> → proyek baru → tempel isi `backend/Code.gs`.
   Buka *Project Settings* → centang *Show "appsscript.json" manifest* → isi dengan `backend/appsscript.json`.
   (Alternatif: `clasp`, lihat `backend/package.json`.)
3. **Batasi sheet yang boleh diakses** (sangat disarankan): *Project Settings → Script properties* →
   tambah `ALLOWED_SPREADSHEET_IDS` = `id1,id2` (pisah koma).
   Tanpa ini, siapa pun yang tahu URL web app bisa membuat backend menulis ke sheet mana pun yang bisa Anda akses.
4. *Deploy → New deployment → Web app*: Execute as **Me**, Who has access **Anyone**. Setujui izin Sheets & Drive.
5. Salin URL `/exec` ke `apps/web/.env`:
   ```
   PUBLIC_GAS_URL=https://script.google.com/macros/s/XXXX/exec
   ```
   Setiap mengubah `Code.gs`, buat *New version* pada deployment agar perubahan berlaku.

Sheet `Users` dan `Sessions` dibuat otomatis di tiap spreadsheet event pada request pertama.
File penugasan disimpan di Google Drive Anda: `RSVP Assignments/<event_id>/`.

### Aturan tiket di sisi server
Server tidak mengirim `ticket_code` selama penugasan wajib dan belum diunggah, jadi QR tidak bisa diakali lewat DevTools.
Namun flag `has_assignment` datang dari frontend. Untuk menguncinya di server, buat tab **Config** di sheet event
dengan baris: kolom A `has_assignment`, kolom B `true` atau `false` — nilai itu mengalahkan kiriman frontend.

### Isi QR Code
`RSVP:<event_id>:<ticket_code>`, mis. `RSVP:demo-event:TKT-1A2B3C4D`. Scanner panitia cukup mencocokkan
`ticket_code` di sheet `Users`. Ubah kolom `status` menjadi `checked_in` untuk menandai kehadiran.

## Sveltia CMS (Cloudflare Pages native)

1. Edit `apps/web/public/admin/config.yml` → ganti `repo: USERNAME/NAMA-REPO` dengan repo GitHub Anda.
2. Untuk hosting statis native di Cloudflare Pages, Sveltia CMS tidak memakai Netlify Identity. Jadi yang bisa dipakai adalah:
   - *Sign in with Token* (GitHub PAT, izin *Contents: read & write*) di halaman `/admin`, atau
   - proxy OAuth seperti [sveltia-cms-auth](https://github.com/sveltia/sveltia-cms-auth) jika ingin tombol *Sign in with GitHub* muncul.
3. `site_url` dan `display_url` harus memakai domain Cloudflare Pages Anda, misalnya `https://rsvp-system-multitenant.pages.dev`.
4. Tambah event baru dari CMS → commit → Cloudflare Pages build ulang → halaman `/<event-id>` terbit.
   Nama file mengikuti `event_id`, dan `event_id` wajib sama dengan nama file (divalidasi saat build).

Path di `config.yml` relatif terhadap root repo (`apps/web/src/content/rsvp`) karena ini monorepo.
Tema DaisyUI yang tersedia harus sama di tiga tempat: `tailwind.config.mjs`, `src/content/config.ts`, `config.yml`.

## Deploy ke Cloudflare Pages

| Pengaturan | Nilai |
|---|---|
| Root directory | *(kosong, root repo)* |
| Build command | `pnpm install && pnpm build` |
| Build output directory | `apps/web/dist` |
| Environment variable | `PUBLIC_GAS_URL`, `NODE_VERSION=20` |

Ganti `site` di `apps/web/astro.config.mjs` dan `site_url` di `config.yml` dengan domain Anda.

## Catatan keamanan
- Password di-hash (SHA-256 + salt, 1000 iterasi) dan token sesi hanya disimpan sebagai hash. Cukup untuk acara komunitas,
  tetapi bukan pengganti layanan auth khusus bila datanya sensitif.
- `spreadsheet_id` terlihat di HTML publik (memang dibutuhkan frontend). Keamanannya ada pada izin Google Sheet:
  jangan bagikan sheet ke publik, dan aktifkan `ALLOWED_SPREADSHEET_IDS`.
- Batasan Apps Script: tidak ada rate limiting bawaan; upload dibatasi 5 MB dan tipe file di-whitelist.
