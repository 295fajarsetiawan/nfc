# Dokumentasi `index.js`

`index.js` adalah service Node.js berbasis Express untuk berinteraksi dengan kartu NFC melalui library `nfc-pcsc`. Service ini mendeteksi reader NFC, membaca data URL dari kartu, menulis URL ke kartu, dan menyediakan endpoint untuk mengganti key akses sector yang dipakai.

## Ringkasan Fungsi

Service ini menyediakan 4 endpoint HTTP:

- `POST /set-key` untuk mengganti key sector 1 dari default key ke custom key
- `POST /write` untuk menulis URL ke kartu NFC
- `GET /read` untuk membaca URL dari kartu NFC
- `GET /health` untuk mengecek status service dan koneksi reader

Service berjalan di:

```text
http://localhost:43125
```

## Dependency Utama

- `express` untuk HTTP server
- `nfc-pcsc` untuk komunikasi dengan NFC reader melalui PC/SC

## Cara Kerja

### Inisialisasi Service

Saat aplikasi dijalankan:

- Express dibuat dan JSON body parser diaktifkan
- port service diset ke `43125`
- instance `NFC` dibuat dari `nfc-pcsc`
- reader aktif yang terdeteksi disimpan di variabel `readerDevice`

### Deteksi Reader dan Card

Saat reader terhubung:

- nama reader dicetak ke console
- reader disimpan ke `readerDevice`
- saat kartu ditempelkan, UID kartu dicetak ke console
- error dari reader akan dicetak ke console

Jika ada error pada instance NFC utama, error juga dicetak ke console.

### Mekanisme Key

Implementasi sekarang memakai dua key:

- `DEFAULT_KEY = FFFFFFFFFFFF`
- `CUSTOM_KEY = A1B2C3D4E5F6`

Alurnya:

1. kartu baru biasanya masih memakai `DEFAULT_KEY`
2. endpoint `POST /set-key` dipakai untuk mengganti key sector 1 ke `CUSTOM_KEY`
3. setelah key diganti, endpoint `POST /write` dan `GET /read` akan mengakses sector yang sama memakai `CUSTOM_KEY`

## Helper Function

### `toBlocks(text)`

Fungsi ini:

- mengubah string menjadi `Buffer` UTF-8
- membaginya menjadi blok berukuran 16 byte
- menambahkan padding null byte jika blok terakhir kurang dari 16 byte

### `fromBlocks(blocks)`

Fungsi ini:

- menggabungkan semua blok menjadi satu `Buffer`
- mengubah buffer kembali menjadi string UTF-8
- menghapus karakter null (`\0`) dari hasil padding

## Struktur Penyimpanan

Service memakai sector 1 pada kartu MIFARE Classic:

- block `4` untuk data
- block `5` untuk data
- block `6` untuk data
- block `7` untuk sector trailer

Block `7` tidak dipakai untuk data biasa karena berisi:

- Key A
- access bits
- Key B

Kapasitas efektif data saat ini:

```text
3 block x 16 byte = 48 byte
```

Artinya URL yang lebih panjang dari 48 byte tidak akan tersimpan penuh.

## Detail Endpoint

### `POST /set-key`

Mengganti key sector 1 dari default key ke custom key.

Endpoint ini:

- mengautentikasi block `4` dengan `DEFAULT_KEY`
- membuat trailer block baru untuk block `7`
- menulis `CUSTOM_KEY` sebagai Key A dan Key B
- memakai access bits `FF078069`

#### Response Sukses

```json
{
  "success": true,
  "message": "Key updated safely"
}
```

#### Catatan

- endpoint ini umumnya dijalankan sekali untuk kartu yang masih memakai default key
- jika key kartu sudah berubah ke custom key, autentikasi dengan `DEFAULT_KEY` akan gagal

### `POST /write`

Menulis URL ke block data pada sector 1.

#### Request Body

```json
{
  "url": "https://example.com"
}
```

#### Alur Proses

1. memastikan reader sudah terhubung
2. memastikan field `url` tersedia
3. mengautentikasi block `4` memakai `CUSTOM_KEY`
4. mengubah URL menjadi blok 16 byte
5. menulis data ke block `4`, `5`, dan `6`
6. melewati block `7` karena itu sector trailer

#### Response Sukses

```json
{
  "success": true
}
```

#### Response Error Umum

Reader belum terhubung:

```json
{
  "error": "Reader not connected"
}
```

URL tidak dikirim:

```json
{
  "error": "URL required"
}
```

### `GET /read`

Membaca URL dari block `4-6` pada sector 1.

#### Alur Proses

1. memastikan reader sudah terhubung
2. mengautentikasi block `4` memakai `CUSTOM_KEY`
3. membaca block `4`, `5`, dan `6`
4. menggabungkan semua block menjadi string URL

#### Response Sukses

```json
{
  "success": true,
  "url": "https://example.com"
}
```

### `GET /health`

Endpoint untuk mengecek status service.

#### Response

```json
{
  "ok": true,
  "readerConnected": true
}
```

## Urutan Pemakaian yang Disarankan

Untuk kartu yang masih memakai default key:

1. jalankan service
2. tempelkan kartu ke reader
3. panggil `POST /set-key`
4. panggil `POST /write`
5. panggil `GET /read` untuk verifikasi

Untuk kartu yang sudah memakai custom key:

1. jalankan service
2. tempelkan kartu ke reader
3. langsung gunakan `POST /write` atau `GET /read`

## Cara Menjalankan

Install dependency:

```bash
npm install
```

Menjalankan server langsung:

```bash
node index.js
```

Menjalankan lewat Electron:

```bash
npm start
```

`main.js` akan memuat `index.js`, lalu menjalankan proses Electron.

Jika service berhasil aktif, console akan menampilkan:

```text
NFC Agent running on http://localhost:43125
```

## Contoh Request

Set custom key pada kartu:

```bash
curl -X POST http://localhost:43125/set-key
```

Tulis URL ke kartu:

```bash
curl -X POST http://localhost:43125/write \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

Baca isi kartu:

```bash
curl http://localhost:43125/read
```

Cek status service:

```bash
curl http://localhost:43125/health
```

## Keterbatasan Implementasi Saat Ini

- hanya menyimpan 1 reader aktif terakhir di `readerDevice`
- data disimpan sebagai raw UTF-8, bukan NDEF
- kapasitas data dibatasi ke 48 byte
- belum ada validasi panjang URL sebelum proses write
- belum ada endpoint untuk memilih reader tertentu jika lebih dari satu reader terhubung
- belum ada mekanisme reset key kembali ke default key
- `POST /set-key` mengasumsikan kartu masih memakai `DEFAULT_KEY`

## Saran Pengembangan

Beberapa peningkatan yang bisa ditambahkan:

- validasi panjang maksimum URL sebelum write
- dukungan format NDEF agar lebih kompatibel dengan aplikasi NFC umum
- endpoint daftar reader dan pemilihan reader aktif
- penanganan reader disconnect yang lebih eksplisit
- endpoint untuk rotasi atau reset key
- logging yang lebih detail untuk debugging
