# Deploy Bitpixe-Mail ke Cloudflare (akun baru)

Target:

- Web/API: `https://mail.bitpixe.com`
- Alamat inbox: `@bitpixe.com`
- Worker: `bitpixe-tempmail`
- D1: `bitpixe-tempmail-db`
- Cloudflare account: **akun baru, terpisah dari Halfeast**

Clone ini adalah salinan bersih Halfeast. Jangan deploy dari folder
`platotempmail` (itu production Halfeast).

---

## 0. Yang harus disiapkan

- Domain `bitpixe.com` sudah dibeli di GoDaddy.
- Akses ke akun Cloudflare baru.
- Email tujuan reset password (bukan `@bitpixe.com` kalau catch-all dipakai
  untuk Worker). Contoh: email pribadi/client.
- Password owner untuk aplikasi.

Jangan menaruh API token, password, atau `AUTH_PASSWORD_HASH` di Git/chat.

---

## 1. Masukkan domain ke Cloudflare

1. Cloudflare Dashboard → **Add a site** → `bitpixe.com` → plan **Free**.
2. Cloudflare memberi dua nameserver, contoh:
   `ada.ns.cloudflare.com`, `bob.ns.cloudflare.com`.
3. GoDaddy → **My Products** → domain `bitpixe.com` → **DNS** →
   **Nameservers** → **Change** → **I'll use my own nameservers**.
4. Ganti dengan dua nameserver Cloudflare. Jangan tambahkan nameserver lain.
5. Tunggu status zone **Active** (biasanya menit–24 jam).

Jangan membuat A record `mail` manual. Custom domain Worker akan membuat
record-nya saat deploy.

---

## 2. Aktifkan layanan Cloudflare yang dipakai

Di akun Cloudflare baru:

| Layanan | Status | Fungsi |
|---|---|---|
| Workers & Pages | ON | Menjalankan Worker |
| D1 | ON | Database inbox/pesan |
| Email Routing | ON | Menerima email `@bitpixe.com` |
| Email Workers | ON | Meneruskan email ke Worker |
| Cloudflare Email Sending | ON jika tersedia | Kirim email reset password |
| SSL/TLS | Full (strict) | HTTPS |
| Always Use HTTPS | ON | Redirect HTTP |
| Web Analytics | opsional | Statistik |
| Bot Fight Mode | **jangan dulu** | Bisa memblokir API/klien |

Catatan: **Cloudflare Email Sending** masih beta di sebagian akun. Kalau
tidak tersedia, hapus blok `send_email` dari `wrangler.bitpixe.jsonc`.
Konsekuensinya tombol lupa password tidak bisa mengirim email; reset harus
lewat admin atau nanti diganti provider lain.

---

## 3. Login Wrangler ke akun baru

Pastikan tidak memakai akun Halfeast:

```powershell
npx wrangler logout
npx wrangler login
npx wrangler whoami
```

`whoami` harus menunjukkan akun Cloudflare baru. Kalau memakai API token:

```powershell
$env:CLOUDFLARE_API_TOKEN = "TOKEN_BARU"
$env:CLOUDFLARE_ACCOUNT_ID = "ACCOUNT_ID_BARU"
npx wrangler whoami
```

Jangan memakai token Halfeast.

---

## 4. Buat API token (kalau deploy non-interaktif)

Cloudflare Dashboard → **My Profile** → **API Tokens** → **Create Token** →
**Custom token**.

Permission minimum:

**Account**
- Workers Scripts: **Edit**
- D1: **Edit**
- Account Settings: **Read**
- Workers Tail: **Read** (opsional, untuk log)

**Zone** (`bitpixe.com`)
- Zone: **Read**
- DNS: **Edit**
- Workers Routes: **Edit**
- Email Routing Rules: **Edit** (kalau atur routing via API)
- SSL and Certificates: **Edit** (opsional)

Simpan token hanya di environment/session, jangan commit.

---

## 5. Buat database D1

```powershell
npx wrangler d1 create bitpixe-tempmail-db
```

Salin `database_id` dari output. Edit `wrangler.bitpixe.jsonc`:

```jsonc
"account_id": "ACCOUNT_ID_BARU",
"database_id": "DATABASE_ID_BARU"
```

Ganti juga:

```jsonc
"ADMIN_USERNAME": "admin",          // ganti username owner
"RESET_EMAIL_TO": "email-klien@example.com"
```

`destination_address` di `send_email` juga harus alamat yang terverifikasi
untuk Cloudflare Email Sending.

---

## 6. Isi secret password owner

Generate hash:

```powershell
npm run password:hash
```

Simpan output `pbkdf2-sha256$...` lalu:

```powershell
npx wrangler secret put AUTH_PASSWORD_HASH --config wrangler.bitpixe.jsonc
```

Paste hash saat diminta. Jangan ketik password mentah ke secret.

---

## 7. Jalankan migrasi D1

```powershell
npm run db:remote:bitpixe
```

Atau manual:

```powershell
npx wrangler d1 migrations apply DB --remote --config wrangler.bitpixe.jsonc
```

Cek:

```powershell
npx wrangler d1 migrations list DB --remote --config wrangler.bitpixe.jsonc
```

Harus tidak ada migrasi pending.

---

## 8. Deploy Worker

```powershell
npm run deploy:bitpixe
```

Atau:

```powershell
npx wrangler deploy --config wrangler.bitpixe.jsonc
```

Yang harus muncul:

- Worker `bitpixe-tempmail`
- Custom domain `mail.bitpixe.com`
- D1 binding `DB`
- Assets binding `ASSETS`
- Cron `0 * * * *`

Cek:

```powershell
curl.exe -I https://mail.bitpixe.com/
curl.exe https://mail.bitpixe.com/api/health
```

Harus `200` dan `{"ok":true}`.

Kalau `503 NOT_CONFIGURED`, cek `PUBLIC_ORIGIN` harus tepat
`https://mail.bitpixe.com` tanpa slash/trailing space.

---

## 9. Aktifkan Email Routing

Dashboard → zone `bitpixe.com` → **Email** → **Email Routing** → **Enable**.

Cloudflare akan menawarkan penambahan record MX/SPF. Terima.

Lalu:

1. **Catch-all address** → **Send to a Worker** → pilih `bitpixe-tempmail`.
2. Simpan.
3. Kirim email uji ke alamat inbox yang dibuat dari web.
4. Cek masuk di UI.

Penting:

- Catch-all `@bitpixe.com` mengirim **semua** email ke Worker.
- Kalau `owner@bitpixe.com` mau jadi email manusia, buat **Custom address**
  `owner@bitpixe.com` → forward ke email asli **sebelum** catch-all.
- `RESET_EMAIL_TO` sebaiknya email eksternal, bukan alamat yang jatuh ke
  catch-all Worker.

---

## 10. Verifikasi aplikasi

1. Buka `https://mail.bitpixe.com`.
2. Login dengan `ADMIN_USERNAME` + password yang hash-nya dipasang.
3. Buat inbox.
4. Kirim email dari Gmail/Outlook ke inbox tersebut.
5. Refresh; pastikan muncul.
6. Cek role/user management.
7. Cek `https://mail.bitpixe.com/api/health`.
8. Test lupa password kalau Email Sending aktif.

Test lokal sebelum deploy:

```powershell
npm ci
npm test
npm run test:e2e
npm run test:integration
npm run typecheck
npm run lint
```

---

## 11. Handover ke client

- Ganti `APP_NAME`, logo, favicon, dan teks UI (nanti).
- Ganti `ADMIN_USERNAME` sebelum serah terima.
- Pastikan `AUTH_PASSWORD_HASH` dibuat ulang untuk client.
- Jangan berikan `.dev.vars`, `.wrangler/`, `backups/`, atau API token.
- `wrangler.bitpixe.jsonc` berisi account/database ID, bukan secret, tapi
  tetap jangan dipublikasikan.
- Siapkan privacy policy/terms kalau layanan dipakai publik.
- Catat email routing dan masa retensi 7 hari.

---

## 12. Troubleshooting cepat

| Gejala | Cek |
|---|---|
| `523` / `1016` | Zone belum active, DNS/nameserver belum propagasi |
| `503 NOT_CONFIGURED` | `PUBLIC_ORIGIN`, `MAIL_DOMAIN`, `ADMIN_USERNAME`, `MESSAGE_RETENTION_DAYS` tidak valid |
| Login `401` | `AUTH_PASSWORD_HASH` salah; generate ulang |
| Deploy gagal `send_email` | Akun belum punya Cloudflare Email Sending; hapus blok `send_email` |
| Email tidak masuk | Catch-all belum ke Worker, MX/SPF belum aktif, nama Worker salah |
| `mail.bitpixe.com` 404 | Custom domain belum terpasang; cek route di config |
| API 403 origin | `PUBLIC_ORIGIN` beda dengan origin browser |
| D1 error | `database_id` salah atau migrasi belum jalan |

---

## 13. Catatan keamanan

Clone ini sudah membawa hardening Halfeast:

- CSP/HSTS/XFO/nosniff/referrer policy
- Origin check untuk semua mutasi API
- Session cookie `__Host-`, HttpOnly, SameSite=Strict
- Rate limit login/password/reset
- SSRF guard webhook + `global_fetch_strictly_public`
- D1 query parameterized
- Idempotent migration dan cleanup cron

Yang belum ada dan perlu dipertimbangkan sebelum dijual:

- Alert uptime/error
- Backup D1 otomatis
- Rate limit inbound per-sender
- Kebijakan abuse/blocklist
- Privacy policy/terms
- Branding final (sekarang masih tampilan Halfeast)
