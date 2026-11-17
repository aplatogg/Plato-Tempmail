# Haldgoff Mail — API untuk bot

Base: `https://mail.haldgoff.com/api/v1`
Auth: `Authorization: Bearer hvk_...` (atau header `X-API-Key: hvk_...`)

## Bikin kunci

1. Login ke `https://mail.haldgoff.com` (akun `plato`).
2. Klik tombol **API** di kanan atas.
3. Isi nama (mis. `bot-telegram`) → **Buat kunci**.
4. Salin `hvk_...` yang muncul — **hanya tampil sekali**.
5. Kunci dicabut lewat tombol **Cabut**, atau otomatis mati kalau kata sandi akun diganti.

Format kunci: `hvk_<12 hex>_<48 hex>` (65 karakter). Yang disimpan server cuma SHA-256-nya.

## Endpoint

| Method | Path | Keterangan |
|---|---|---|
| GET | `/me` | identitas pemilik kunci + `mailDomain` + `retentionDays` |
| GET | `/inboxes` | daftar inbox milik akun |
| POST | `/inboxes` | buat 1 inbox, body `{"localPart": "..."}` (alias `name`, atau `address` lengkap) |
| POST | `/inboxes/bulk` | buat banyak: `{"localParts": ["a","b"]}` **atau** `{"count": 10, "prefix": "budi"}` (maks 50) |
| PATCH | `/inboxes/:id` | `{"favorite": true}` |
| DELETE | `/inboxes/:id` | hapus inbox |
| GET | `/inboxes/:id/messages` | daftar pesan; `?unread=1`, `?cursor=...` |
| GET | `/messages/:id` | isi pesan lengkap (`body`, `html`, `attachments`) |
| PATCH | `/messages/:id` | `{"isRead": true}` |
| DELETE | `/messages/:id` | **hapus satu pesan** (hanya pesan di inbox milik sendiri) |
| POST | `/inboxes/:id/read-all` | tandai semua dibaca |
| DELETE | `/inboxes/:id/messages` | kosongkan inbox |

## Contoh

```bash
export HALDGOFF_KEY="hvk_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# siapa saya
curl -s -H "Authorization: Bearer $HALDGOFF_KEY" \
  https://mail.haldgoff.com/api/v1/me

# alamat persis, tanpa akhiran acak
curl -s -X POST -H "Authorization: Bearer $HALDGOFF_KEY" \
  -H "Content-Type: application/json" \
  -d '{"localParts":["titikwiduri54","kurirpaket55"]}' \
  https://mail.haldgoff.com/api/v1/inboxes/bulk

# dibuatkan otomatis: nama ala manusia (kata + angka), atau prefix + angka
curl -s -X POST -H "Authorization: Bearer $HALDGOFF_KEY" \
  -H "Content-Type: application/json" -d '{"count":5}' \
  https://mail.haldgoff.com/api/v1/inboxes/bulk
# -> titikwiduri54@…, kurirpaket55@…, umarsantoso24@…

# baca pesan belum dibaca
curl -s -H "Authorization: Bearer $HALDGOFF_KEY" \
  "https://mail.haldgoff.com/api/v1/inboxes/<id>/messages?unread=1"

# isi satu pesan
curl -s -H "Authorization: Bearer $HALDGOFF_KEY" \
  https://mail.haldgoff.com/api/v1/messages/<message-id>
```

`/inboxes/bulk` mengembalikan `{created: [{inbox:{id,address}}...], failed: [{address,status,error}]}`.

Dua mode, tidak boleh dicampur:

- **`localParts`** — daftar alamat persis (1–50). Tidak ada akhiran yang ditambahkan.
  Kalau satu alamat sudah dipakai, item itu masuk `failed` dan tidak diganti nama.
- **`count`** (+ `prefix` opsional) — server membuat nama. Tanpa `prefix` hasilnya
  nama ala manusia: dua kata + angka (`titikwiduri54`). Dengan `prefix`, hasilnya
  `prefix` + 2–3 angka (`budi12`). **Tidak pernah** memakai `-`, `_`, atau kode hex.
- Semua nama tetap divalidasi: 1–32 karakter `a-z 0-9 . _ -`, nama reserved hanya
  untuk Celestial.
Kalau kuota atau batas 100 inbox kena, loop berhenti lebih awal (403/409).

## Aturan yang berlaku (sama dengan aplikasi)

- Quota per peran (Voyager 6 inbox, dst.) dan batas global **100 inbox** per akun.
- Retensi pesan per paket: **Celestial / Cosmos / Astral 30 hari**, **Stardust 14 hari**, **Voyager / Quark 7 hari** (dihapus cron tiap jam).
- Alamat: 1–32 karakter `a-z 0-9 . _ -`; nama yang dicadangkan ditolak.
- Kunci tidak punya masa berlaku, tapi mati kalau: dicabut, kata sandi akun berubah, atau peran akun berubah.
- Maksimum 20 kunci aktif per akun.
- **Voyager dan Quark tidak boleh punya kunci API** (403 `API_KEY_FORBIDDEN`); tombol API juga disembunyikan untuk mereka.
- Semua respons error berbentuk `{"error":{"code":"...","message":"..."}}`.

## Catatan integrasi bot

- Simpan kunci di secret manager bot, jangan di repo.
- Endpoint `/api/v1/*` tidak butuh header `Origin` dan tidak memakai cookie — aman dipanggil dari skrip/server apa pun.
- Polling disarankan 10–30 detik per inbox; `last_used_at` di-throttle ke 1 tulis/jam per kunci.
- Untuk daftar akun massal, pakai `/inboxes/bulk` (maks 50 per panggilan).