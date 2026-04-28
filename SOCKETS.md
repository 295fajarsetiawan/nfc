# NFC Socket API

Dokumen ini menjelaskan channel Socket.IO lokal yang berjalan di app NFC Agent.

## Ringkasan

Server lokal berjalan di:

```text
https://localhost:43125
```

Endpoint Socket.IO:

```text
https://localhost:43125/socket.io/
```

Socket server dipasang di [socket-server.js](c:/Users/waney/source/repos/next/nfc/socket-server.js) dan diaktifkan dari [index.js](c:/Users/waney/source/repos/next/nfc/index.js).

## Tujuan

Socket dipakai agar frontend tidak perlu polling `fetch` terus-menerus ke endpoint seperti `/health`, `/read`, atau `/check`.

Manfaat utama:

- status NFC bisa dipush real-time
- perubahan reader dan kartu bisa langsung diterima client
- operasi tulis/baca/reset bisa dipanggil lewat event

## Koneksi Client

Contoh browser:

```html
<script src="https://127.0.0.1:43125/socket.io/socket.io.js"></script>
<script>
  const socket = io("https://127.0.0.1:43125", {
    transports: ["websocket", "polling"]
  });

  socket.on("connect", () => {
    console.log("connected", socket.id);
  });
</script>
```

Contoh lengkap ada di [socket-client-example.html](c:/Users/waney/source/repos/next/nfc/socket-client-example.html).

## Event Request/Response

Semua event request menggunakan callback acknowledgement.

### `health:get`

Request:

```js
socket.emit("health:get", response => {
  console.log(response);
});
```

Response:

```json
{
  "ok": true,
  "nfcState": "ready",
  "nfcError": null,
  "readerConnected": true,
  "readerName": "ACS ACR122U PICC Interface 0"
}
```

### `nfc:read`

Request:

```js
socket.emit("nfc:read", response => {
  console.log(response);
});
```

Response sukses:

```json
{
  "success": true,
  "strategy": "mad",
  "url": "https://example.com/",
  "mad": {},
  "tlvHex": "...",
  "ndefMessageHex": "..."
}
```

Response gagal:

```json
{
  "success": false,
  "message": "No valid NDEF URL found"
}
```

### `nfc:check`

Request:

```js
socket.emit("nfc:check", response => {
  console.log(response);
});
```

Response:

```json
{
  "success": true,
  "readerName": "ACS ACR122U PICC Interface 0",
  "strategy": "mad",
  "url": "https://example.com/",
  "mad": {},
  "sector0": {},
  "readyForAndroid": true,
  "note": "Agar Android mengenali URL, kartu harus benar-benar terformat NDEF MIFARE Classic dan ponsel juga harus mendukung MIFARE Classic."
}
```

### `nfc:write`

Request:

```js
socket.emit("nfc:write", { url: "https://peradipro.com" }, response => {
  console.log(response);
});
```

Response:

```json
{
  "success": true,
  "message": "URL written as NDEF: https://peradipro.com/",
  "url": "https://peradipro.com/",
  "nfcSectorCount": 1,
  "mad": {},
  "ndefMessageHex": "...",
  "tlvHex": "..."
}
```

### `nfc:reset`

Request:

```js
socket.emit("nfc:reset", response => {
  console.log(response);
});
```

Response:

```json
{
  "success": true,
  "message": "Card reset to transport layout. Sector 0 MAD cleared, sectors 1-15 blank, default keys/access bits restored."
}
```

## Event Broadcast

Event ini dikirim server tanpa perlu request dari client.

### `nfc:health`

Dikirim saat:

- client baru connect
- status NFC berubah
- reader connect/disconnect
- inisialisasi NFC gagal

Payload:

```json
{
  "ok": true,
  "nfcState": "ready",
  "nfcError": null,
  "readerConnected": true,
  "readerName": "ACS ACR122U PICC Interface 0"
}
```

### `nfc:reader`

Payload saat reader terhubung:

```json
{
  "connected": true,
  "readerName": "ACS ACR122U PICC Interface 0"
}
```

Payload saat reader dilepas:

```json
{
  "connected": false,
  "readerName": "ACS ACR122U PICC Interface 0"
}
```

### `nfc:card`

Payload saat kartu ditempel:

```json
{
  "present": true,
  "uid": "12345678",
  "readerName": "ACS ACR122U PICC Interface 0"
}
```

Payload saat kartu dilepas:

```json
{
  "present": false,
  "uid": "12345678",
  "readerName": "ACS ACR122U PICC Interface 0"
}
```

## Error Handling

Jika operasi gagal, callback biasanya akan menerima bentuk seperti ini:

```json
{
  "success": false,
  "error": "Reader not connected"
}
```

Penyebab umum:

- NFC reader belum terhubung
- kartu belum ditempel
- URL tidak valid
- modul `nfc-pcsc` gagal load

## Batasan Browser

Jika client berasal dari website publik seperti `https://peradiprof.or.id` lalu mencoba connect ke `https://127.0.0.1:43125`, browser modern masih bisa memblokir akses karena kebijakan Local Network Access / Private Network Access.

Jadi socket membantu mengurangi polling HTTP, tetapi tidak selalu menghilangkan pembatasan browser untuk akses dari website publik ke loopback lokal.

Jika memungkinkan:

- gunakan `localhost` secara konsisten
- utamakan `websocket`
- hindari terlalu bergantung pada fallback polling jika browser environment sangat ketat

## Saran Integrasi Next.js

Jika dipakai di Next.js atau frontend modern, lebih aman pakai client library resmi:

```bash
npm install socket.io-client
```

Contoh:

```js
import { io } from "socket.io-client";

const socket = io("https://127.0.0.1:43125", {
  transports: ["websocket", "polling"]
});

socket.on("nfc:health", payload => {
  console.log(payload);
});

socket.emit("nfc:write", { url: "https://peradipro.com" }, response => {
  console.log(response);
});
```
