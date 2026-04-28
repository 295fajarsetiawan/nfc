if (!Object.hasOwn) {
  Object.hasOwn = (target, property) =>
    Object.prototype.hasOwnProperty.call(Object(target), property);
}

const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawnSync } = require("child_process");
const express = require("express");
const cors = require("cors");
const ndef = require("ndef");
const { attachSocketServer } = require("./socket-server");

const app = express();
const ALLOWED_CORS_ORIGINS = new Set([
  "https://peradiprof.or.id",
  "https://www.peradiprof.or.id",
  "https://localhost:43125",
  "https://127.0.0.1:43125"
]);

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_CORS_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "Content-Type"
  );

  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

app.use((req, res, next) => {
  applyCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_CORS_ORIGINS.has(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Origin not allowed: ${origin}`));
  }
}));
app.use(express.json());

const PORT = 43125;
const CERT_DIR = path.join(__dirname, ".cert");
const HTTPS_PFX_PATH = path.join(CERT_DIR, "localhost-dev.pfx");
const HTTPS_CER_PATH = path.join(CERT_DIR, "localhost-dev.cer");
const HTTPS_PASSPHRASE = process.env.NFC_HTTPS_PASSPHRASE || "nfc-localhost-dev";
const HTTPS_CERT_FRIENDLY_NAME = "NFC Agent Localhost Dev";

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NFC Agent</title>
    <style>
      body {
        font-family: "Segoe UI", sans-serif;
        margin: 0;
        padding: 32px;
        background: #f5f7fb;
        color: #1f2937;
      }
      main {
        max-width: 720px;
        margin: 0 auto;
        background: #ffffff;
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
      }
      h1 {
        margin-top: 0;
      }
      code {
        background: #eef2ff;
        padding: 2px 6px;
        border-radius: 6px;
      }
      ul {
        padding-left: 20px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>NFC Agent</h1>
      <p>Server is running on port ${PORT}.</p>
      <p>Available endpoints:</p>
      <ul>
        <li><code>GET /health</code></li>
        <li><code>POST /write</code></li>
        <li><code>GET /read</code></li>
        <li><code>GET /check</code></li>
        <li><code>GET /fix-trailer</code></li>
        <li><code>GET /reset</code></li>
      </ul>
    </main>
  </body>
</html>`);
});

const BLOCK_SIZE = 16;
const BLOCKS_PER_SECTOR = 4;
const DATA_BLOCKS_PER_SECTOR = 3;
const DATA_BYTES_PER_SECTOR = BLOCK_SIZE * DATA_BLOCKS_PER_SECTOR;
const MAX_NFC_SECTORS_1K = 15;

const KEY_TYPE_A = 0x60;
const KEY_TYPE_B = 0x61;

const TRANSPORT_KEY = Buffer.from("FFFFFFFFFFFF", "hex");
const MAD_PUBLIC_KEY_A = Buffer.from("A0A1A2A3A4A5", "hex");
const NFC_PUBLIC_KEY_A = Buffer.from("D3F7D3F7D3F7", "hex");
const SECRET_KEY_B = Buffer.from(
  (process.env.NFC_SECRET_KEY_B || "FFFFFFFFFFFF").replace(/[^0-9a-f]/gi, ""),
  "hex"
);

const MAD_TRAILER = buildSectorTrailer(
  MAD_PUBLIC_KEY_A,
  Buffer.from("787788", "hex"),
  0xc1,
  SECRET_KEY_B
);

const NFC_TRAILER = buildSectorTrailer(
  NFC_PUBLIC_KEY_A,
  Buffer.from("7F0788", "hex"),
  0x40,
  SECRET_KEY_B
);

const TRANSPORT_TRAILER = buildSectorTrailer(
  TRANSPORT_KEY,
  Buffer.from("FF0780", "hex"),
  0x69,
  TRANSPORT_KEY
);

const NFC_AID = Buffer.from([0x03, 0xe1]);
const FREE_AID = Buffer.from([0x00, 0x00]);

const MAD_READ_AUTH = [
  { keyType: KEY_TYPE_A, key: MAD_PUBLIC_KEY_A, label: "MAD public key A" },
  { keyType: KEY_TYPE_B, key: SECRET_KEY_B, label: "secret key B" },
  { keyType: KEY_TYPE_A, key: TRANSPORT_KEY, label: "transport key A" },
  { keyType: KEY_TYPE_B, key: TRANSPORT_KEY, label: "transport key B" }
];

const MAD_WRITE_AUTH = [
  { keyType: KEY_TYPE_B, key: SECRET_KEY_B, label: "secret key B" },
  { keyType: KEY_TYPE_A, key: TRANSPORT_KEY, label: "transport key A" },
  { keyType: KEY_TYPE_B, key: TRANSPORT_KEY, label: "transport key B" }
];

const NFC_DATA_AUTH = [
  { keyType: KEY_TYPE_A, key: NFC_PUBLIC_KEY_A, label: "NFC public key A" },
  { keyType: KEY_TYPE_B, key: SECRET_KEY_B, label: "secret key B" },
  { keyType: KEY_TYPE_A, key: TRANSPORT_KEY, label: "transport key A" },
  { keyType: KEY_TYPE_B, key: TRANSPORT_KEY, label: "transport key B" }
];

let readerDevice = null;
let nfc = null;
let nfcInitialized = false;
let nfcInitStarted = false;
let nfcStatus = {
  state: "idle",
  error: null
};
let socketBridge = null;

function buildSectorTrailer(keyA, accessBits, gpb, keyB) {
  return Buffer.concat([keyA, accessBits, Buffer.from([gpb]), keyB]);
}

function getHealthSnapshot() {
  return {
    ok: true,
    nfcState: nfcStatus.state,
    nfcError: nfcStatus.error,
    readerConnected: !!readerDevice,
    readerName: readerDevice ? readerDevice.name : null
  };
}

function emitSocketStatus() {
  socketBridge?.broadcastStatus();
}

function emitSocketEvent(eventName, payload) {
  socketBridge?.broadcastEvent(eventName, payload);
}

function ensureNfcInitialized() {
  if (nfcInitialized) {
    return nfc;
  }

  if (nfcInitStarted) {
    return nfc;
  }

  nfcInitStarted = true;
  nfcStatus = {
    state: "initializing",
    error: null
  };
  emitSocketStatus();

  let NFC;
  try {
    ({ NFC } = require("nfc-pcsc"));
  } catch (err) {
    nfcStatus = {
      state: "error",
      error: err.message
    };
    emitSocketStatus();
    if (err.code === "ERR_DLOPEN_FAILED") {
      throw new Error(
        `Failed to load nfc-pcsc native module. Current Node runtime is ${process.arch} on ${process.platform}. Rebuild/install the addon for this architecture.`
      );
    }
    throw err;
  }

  console.log("[NFC] Initializing PC/SC context...");
  nfc = new NFC();
  console.log("[NFC] PC/SC context created");

  nfc.on("reader", reader => {
    console.log("Reader detected:", reader.name);
    readerDevice = reader;
    nfcStatus = {
      state: "ready",
      error: null
    };
    emitSocketStatus();
    emitSocketEvent("nfc:reader", { connected: true, readerName: reader.name });

    reader.on("card", card => {
      console.log("Card detected:", card.uid);
      emitSocketEvent("nfc:card", {
        present: true,
        uid: card.uid,
        readerName: reader.name
      });
    });

    reader.on("card.off", card => {
      console.log("Card removed:", card.uid);
      emitSocketEvent("nfc:card", {
        present: false,
        uid: card.uid,
        readerName: reader.name
      });
    });

    reader.on("end", () => {
      if (readerDevice === reader) {
        readerDevice = null;
      }
      console.log("Reader removed:", reader.name);
      emitSocketStatus();
      emitSocketEvent("nfc:reader", { connected: false, readerName: reader.name });
    });

    reader.on("error", err => console.error("Reader error", err));
  });

  nfc.on("error", err => {
    nfcStatus = {
      state: "error",
      error: err.message
    };
    emitSocketStatus();
    console.error("NFC error", err);
  });
  nfcInitialized = true;
  nfcStatus = {
    state: "ready",
    error: null
  };
  emitSocketStatus();

  return nfc;
}

function sectorDataBlocks(sector) {
  const base = sector * BLOCKS_PER_SECTOR;
  return [base, base + 1, base + 2];
}

function sectorTrailerBlock(sector) {
  return sector * BLOCKS_PER_SECTOR + 3;
}

function normalizeUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("URL required");
  }

  const trimmed = url.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch (err) {
    throw new Error("Invalid URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http:// or https:// URLs are supported");
  }

  return parsed.toString();
}

function createNdefMessage(url) {
  const normalizedUrl = normalizeUrl(url);
  const records = [ndef.uriRecord(normalizedUrl)];
  return {
    normalizedUrl,
    ndefMessage: Buffer.from(ndef.encodeMessage(records))
  };
}

function ensureLocalhostCertificate() {
  fs.mkdirSync(CERT_DIR, { recursive: true });

  const psScript = `
$ErrorActionPreference = 'Stop'
$certPath = '${HTTPS_PFX_PATH.replace(/'/g, "''")}'
$cerPath = '${HTTPS_CER_PATH.replace(/'/g, "''")}'
$password = ConvertTo-SecureString '${HTTPS_PASSPHRASE.replace(/'/g, "''")}' -AsPlainText -Force
$existing = Get-ChildItem Cert:\\CurrentUser\\My |
  Where-Object { $_.FriendlyName -eq '${HTTPS_CERT_FRIENDLY_NAME.replace(/'/g, "''")}' } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1
if (-not $existing) {
  $existing = New-SelfSignedCertificate -Subject 'CN=localhost' -CertStoreLocation 'Cert:\\CurrentUser\\My' -FriendlyName '${HTTPS_CERT_FRIENDLY_NAME.replace(/'/g, "''")}' -TextExtension @('2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1')
}
Export-PfxCertificate -Cert $existing.PSPath -FilePath $certPath -Password $password | Out-Null
Export-Certificate -Cert $existing.PSPath -FilePath $cerPath -Type CERT | Out-Null
$trusted = Get-ChildItem Cert:\\CurrentUser\\Root |
  Where-Object { $_.Thumbprint -eq $existing.Thumbprint } |
  Select-Object -First 1
if (-not $trusted) {
  Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\\CurrentUser\\Root' | Out-Null
}
`;

  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript], {
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status !== 0 || !fs.existsSync(HTTPS_PFX_PATH)) {
    throw new Error(
      `Failed to create localhost HTTPS certificate.${result.stderr ? ` ${result.stderr.trim()}` : ""}`
    );
  }
}

function createHttpsServer() {
  ensureLocalhostCertificate();

  return https.createServer(
    {
      pfx: fs.readFileSync(HTTPS_PFX_PATH),
      passphrase: HTTPS_PASSPHRASE
    },
    app
  );
}

function createTlv(ndefMessage) {
  if (ndefMessage.length <= 0xfe) {
    return Buffer.concat([
      Buffer.from([0x03, ndefMessage.length]),
      ndefMessage,
      Buffer.from([0xfe])
    ]);
  }

  return Buffer.concat([
    Buffer.from([0x03, 0xff, (ndefMessage.length >> 8) & 0xff, ndefMessage.length & 0xff]),
    ndefMessage,
    Buffer.from([0xfe])
  ]);
}

function splitToSectorPayloads(data) {
  const sectors = [];

  for (let offset = 0; offset < data.length; offset += DATA_BYTES_PER_SECTOR) {
    const chunk = Buffer.alloc(DATA_BYTES_PER_SECTOR);
    data.slice(offset, offset + DATA_BYTES_PER_SECTOR).copy(chunk);
    sectors.push(chunk);
  }

  return sectors;
}

function chunkToBlocks(chunk) {
  return [
    chunk.slice(0, 16),
    chunk.slice(16, 32),
    chunk.slice(32, 48)
  ];
}

function crc8Mad(data) {
  let crc = 0xc7;

  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const msb = crc & 0x80;
      crc = (crc << 1) & 0xff;
      if (msb) {
        crc ^= 0x1d;
      }
    }
  }

  return crc;
}

function buildMadDirectory(ndefSectorCount) {
  const aidBytes = Buffer.alloc(MAX_NFC_SECTORS_1K * 2);

  for (let sector = 1; sector <= MAX_NFC_SECTORS_1K; sector++) {
    const offset = (sector - 1) * 2;
    (sector <= ndefSectorCount ? NFC_AID : FREE_AID).copy(aidBytes, offset);
  }

  const infoByte = 0x00;
  const crc = crc8Mad(Buffer.concat([Buffer.from([infoByte]), aidBytes]));

  const block1 = Buffer.alloc(16);
  block1[0] = crc;
  block1[1] = infoByte;
  aidBytes.slice(0, 14).copy(block1, 2);

  const block2 = Buffer.alloc(16);
  aidBytes.slice(14, 30).copy(block2, 0);

  return { block1, block2, crc, infoByte, aidBytes };
}

async function authenticateWithAny(reader, blockNumber, candidates) {
  let lastError = null;

  for (const candidate of candidates) {
    try {
      await reader.authenticate(blockNumber, candidate.keyType, candidate.key);
      return candidate;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `Authentication failed for block ${blockNumber}${lastError ? `: ${lastError.message}` : ""}`
  );
}

async function readBlock(reader, blockNumber, authCandidates) {
  await authenticateWithAny(reader, blockNumber, authCandidates);
  return reader.read(blockNumber, BLOCK_SIZE, BLOCK_SIZE);
}

async function writeBlock(reader, blockNumber, data, authCandidates) {
  await authenticateWithAny(reader, blockNumber, authCandidates);
  await reader.write(blockNumber, data, BLOCK_SIZE);
}

async function writeMadSector(reader, ndefSectorCount) {
  const { block1, block2, crc, infoByte, aidBytes } = buildMadDirectory(ndefSectorCount);

  await writeBlock(reader, 1, block1, MAD_WRITE_AUTH);
  await writeBlock(reader, 2, block2, MAD_WRITE_AUTH);
  await writeBlock(reader, 3, MAD_TRAILER, MAD_WRITE_AUTH);

  return {
    crc,
    infoByte,
    aidBytesHex: aidBytes.toString("hex"),
    block1Hex: block1.toString("hex"),
    block2Hex: block2.toString("hex"),
    trailerHex: MAD_TRAILER.toString("hex")
  };
}

async function writeNfcSectors(reader, sectorPayloads) {
  const sectorsUsed = [];

  for (let index = 0; index < sectorPayloads.length; index++) {
    const sector = index + 1;
    const blocks = chunkToBlocks(sectorPayloads[index]);
    const [block0, block1, block2] = sectorDataBlocks(sector);

    await writeBlock(reader, block0, blocks[0], NFC_DATA_AUTH);
    await writeBlock(reader, block1, blocks[1], NFC_DATA_AUTH);
    await writeBlock(reader, block2, blocks[2], NFC_DATA_AUTH);
    await writeBlock(reader, sectorTrailerBlock(sector), NFC_TRAILER, MAD_WRITE_AUTH);

    sectorsUsed.push({
      sector,
      blocks: {
        [block0]: blocks[0].toString("hex"),
        [block1]: blocks[1].toString("hex"),
        [block2]: blocks[2].toString("hex")
      }
    });
  }

  return sectorsUsed;
}

async function writeUrlToCard(reader, url) {
  const { normalizedUrl, ndefMessage } = createNdefMessage(url);
  const tlv = createTlv(ndefMessage);
  const sectorPayloads = splitToSectorPayloads(tlv);

  if (sectorPayloads.length > MAX_NFC_SECTORS_1K) {
    throw new Error("URL is too long for a MIFARE Classic 1K NDEF tag");
  }

  const mad = await writeMadSector(reader, sectorPayloads.length);
  const sectors = await writeNfcSectors(reader, sectorPayloads);

  return {
    url: normalizedUrl,
    ndefMessageHex: ndefMessage.toString("hex"),
    tlvHex: tlv.toString("hex"),
    nfcSectorCount: sectorPayloads.length,
    mad,
    sectors
  };
}

function parseMadDirectory(block1, block2) {
  const infoByte = block1[1];
  const storedCrc = block1[0];
  const aidBytes = Buffer.concat([block1.slice(2), block2]);
  const expectedCrc = crc8Mad(Buffer.concat([Buffer.from([infoByte]), aidBytes]));

  const ndefSectors = [];
  for (let sector = 1; sector <= MAX_NFC_SECTORS_1K; sector++) {
    const offset = (sector - 1) * 2;
    if (aidBytes[offset] === NFC_AID[0] && aidBytes[offset + 1] === NFC_AID[1]) {
      ndefSectors.push(sector);
    }
  }

  return {
    infoByte,
    storedCrc,
    expectedCrc,
    crcValid: storedCrc === expectedCrc,
    aidBytesHex: aidBytes.toString("hex"),
    ndefSectors
  };
}

function extractNdefFromTlv(data) {
  let offset = 0;

  while (offset < data.length) {
    const tag = data[offset];

    if (tag === 0x00) {
      offset += 1;
      continue;
    }

    if (tag === 0xfe) {
      return null;
    }

    if (tag === 0x03) {
      if (offset + 1 >= data.length) {
        return null;
      }

      let length;
      let headerLength;

      if (data[offset + 1] === 0xff) {
        if (offset + 3 >= data.length) {
          return null;
        }
        length = (data[offset + 2] << 8) | data[offset + 3];
        headerLength = 4;
      } else {
        length = data[offset + 1];
        headerLength = 2;
      }

      const valueStart = offset + headerLength;
      const valueEnd = valueStart + length;

      if (valueEnd > data.length) {
        return null;
      }

      let tlvEnd = valueEnd;
      if (tlvEnd < data.length && data[tlvEnd] === 0xfe) {
        tlvEnd += 1;
      }

      return {
        tlvHex: data.slice(offset, tlvEnd).toString("hex"),
        ndefMessage: data.slice(valueStart, valueEnd)
      };
    }

    break;
  }

  return null;
}

function decodeUrlFromNdefMessage(ndefMessage) {
  try {
    const records = ndef.decodeMessage(Array.from(ndefMessage));
    const record = records.find(item => typeof item.value === "string" && /^https?:\/\//i.test(item.value));
    return record ? record.value : null;
  } catch (err) {
    return null;
  }
}

async function readSectorPayload(reader, sector) {
  const blocks = [];

  for (const blockNumber of sectorDataBlocks(sector)) {
    blocks.push(await readBlock(reader, blockNumber, NFC_DATA_AUTH));
  }

  return Buffer.concat(blocks);
}

async function tryReadMappedNdef(reader) {
  const block1 = await readBlock(reader, 1, MAD_READ_AUTH);
  const block2 = await readBlock(reader, 2, MAD_READ_AUTH);
  const trailer = await readBlock(reader, 3, MAD_READ_AUTH);
  const mad = parseMadDirectory(block1, block2);

  if (!mad.ndefSectors.length) {
    return {
      strategy: "mad",
      mad,
      sector0: {
        block1Hex: block1.toString("hex"),
        block2Hex: block2.toString("hex"),
        trailerHex: trailer.toString("hex")
      },
      rawPayloadHex: null,
      tlvHex: null,
      ndefMessageHex: null,
      url: null
    };
  }

  const payloadChunks = [];
  for (const sector of mad.ndefSectors) {
    payloadChunks.push(await readSectorPayload(reader, sector));
  }

  const rawPayload = Buffer.concat(payloadChunks);
  const extracted = extractNdefFromTlv(rawPayload);

  return {
    strategy: "mad",
    mad,
    sector0: {
      block1Hex: block1.toString("hex"),
      block2Hex: block2.toString("hex"),
      trailerHex: trailer.toString("hex")
    },
    rawPayloadHex: rawPayload.toString("hex"),
    tlvHex: extracted ? extracted.tlvHex : null,
    ndefMessageHex: extracted ? extracted.ndefMessage.toString("hex") : null,
    url: extracted ? decodeUrlFromNdefMessage(extracted.ndefMessage) : null
  };
}

async function tryReadFallbackSector(reader, sector, strategy) {
  const rawPayload = await readSectorPayload(reader, sector);
  const extracted = extractNdefFromTlv(rawPayload);

  if (!extracted) {
    return null;
  }

  const url = decodeUrlFromNdefMessage(extracted.ndefMessage);
  if (!url) {
    return null;
  }

  return {
    strategy,
    mad: null,
    sector0: null,
    rawPayloadHex: rawPayload.toString("hex"),
    tlvHex: extracted.tlvHex,
    ndefMessageHex: extracted.ndefMessage.toString("hex"),
    url,
    fallbackSector: sector
  };
}

async function tryReadLegacySector0(reader) {
  const blocks = [];

  for (const blockNumber of [0, 1, 2]) {
    blocks.push(await readBlock(reader, blockNumber, [...MAD_READ_AUTH, ...NFC_DATA_AUTH]));
  }

  const raw = Buffer.concat(blocks);
  const extracted = extractNdefFromTlv(raw);
  if (!extracted) {
    return null;
  }

  const url = decodeUrlFromNdefMessage(extracted.ndefMessage);
  if (!url) {
    return null;
  }

  return {
    strategy: "legacy-sector0",
    mad: null,
    sector0: {
      block0Hex: blocks[0].toString("hex"),
      block1Hex: blocks[1].toString("hex"),
      block2Hex: blocks[2].toString("hex")
    },
    rawPayloadHex: raw.toString("hex"),
    tlvHex: extracted.tlvHex,
    ndefMessageHex: extracted.ndefMessage.toString("hex"),
    url
  };
}

async function inspectCard(reader) {
  const mapped = await tryReadMappedNdef(reader).catch(err => ({
    strategy: "mad",
    error: err.message,
    mad: null,
    sector0: null,
    rawPayloadHex: null,
    tlvHex: null,
    ndefMessageHex: null,
    url: null
  }));

  if (mapped.url) {
    return mapped;
  }

  const fallbackSector1 = await tryReadFallbackSector(reader, 1, "sector1-fallback").catch(() => null);
  if (fallbackSector1) {
    return fallbackSector1;
  }

  const legacy = await tryReadLegacySector0(reader).catch(() => null);
  if (legacy) {
    return legacy;
  }

  return mapped;
}

async function resetCard(reader) {
  await writeBlock(reader, 1, Buffer.alloc(16), MAD_WRITE_AUTH);
  await writeBlock(reader, 2, Buffer.alloc(16), MAD_WRITE_AUTH);
  await writeBlock(reader, 3, TRANSPORT_TRAILER, MAD_WRITE_AUTH);

  for (let sector = 1; sector <= MAX_NFC_SECTORS_1K; sector++) {
    const [block0, block1, block2] = sectorDataBlocks(sector);

    await writeBlock(reader, block0, Buffer.alloc(16), NFC_DATA_AUTH);
    await writeBlock(reader, block1, Buffer.alloc(16), NFC_DATA_AUTH);
    await writeBlock(reader, block2, Buffer.alloc(16), NFC_DATA_AUTH);
    await writeBlock(reader, sectorTrailerBlock(sector), TRANSPORT_TRAILER, MAD_WRITE_AUTH);
  }
}

app.post("/write", async (req, res) => {
  try {
    if (!readerDevice) {
      return res.status(400).json({ error: "Reader not connected" });
    }

    const result = await writeUrlToCard(readerDevice, req.body.url);

    console.log(`✅ URL written as proper MIFARE Classic NDEF: ${result.url}`);
    console.log("Tap the card to an Android phone that supports MIFARE Classic.");

    res.json({
      success: true,
      message: `URL written as NDEF: ${result.url}`,
      url: result.url,
      nfcSectorCount: result.nfcSectorCount,
      mad: result.mad,
      ndefMessageHex: result.ndefMessageHex,
      tlvHex: result.tlvHex,
      note:
        "Android decides whether to open the default browser directly or show a chooser. ACR122U only writes the tag."
    });
  } catch (err) {
    console.error("Write error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/write-sector1", async (req, res) => {
  try {
    if (!readerDevice) {
      return res.status(400).json({ error: "Reader not connected" });
    }

    const result = await writeUrlToCard(readerDevice, req.body.url);

    res.json({
      success: true,
      message: `URL written as NDEF starting at sector 1: ${result.url}`,
      url: result.url,
      nfcSectorCount: result.nfcSectorCount,
      note:
        "/write-sector1 sekarang menjadi alias ke format NDEF yang benar untuk MIFARE Classic 1K."
    });
  } catch (err) {
    console.error("Write-sector1 error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/read", async (req, res) => {
  try {
    if (!readerDevice) {
      return res.status(400).json({ error: "Reader not connected" });
    }

    const inspection = await inspectCard(readerDevice);

    if (!inspection.url) {
      return res.json({
        success: false,
        message: "No valid NDEF URL found",
        strategy: inspection.strategy,
        mad: inspection.mad,
        sector0: inspection.sector0,
        rawPayloadHex: inspection.rawPayloadHex
      });
    }

    res.json({
      success: true,
      strategy: inspection.strategy,
      url: inspection.url,
      mad: inspection.mad,
      tlvHex: inspection.tlvHex,
      ndefMessageHex: inspection.ndefMessageHex
    });
  } catch (err) {
    console.error("Read error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/check", async (req, res) => {
  try {
    if (!readerDevice) {
      return res.status(400).json({ error: "Reader not connected" });
    }

    const inspection = await inspectCard(readerDevice);

    res.json({
      success: true,
      readerName: readerDevice.name,
      strategy: inspection.strategy,
      url: inspection.url,
      mad: inspection.mad,
      sector0: inspection.sector0,
      readyForAndroid: Boolean(
        inspection.url &&
          inspection.strategy === "mad" &&
          inspection.mad &&
          inspection.mad.crcValid &&
          inspection.mad.ndefSectors.length > 0
      ),
      note:
        "Agar Android mengenali URL, kartu harus benar-benar terformat NDEF MIFARE Classic dan ponsel juga harus mendukung MIFARE Classic."
    });
  } catch (err) {
    console.error("Check error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/fix-trailer", async (req, res) => {
  try {
    if (!readerDevice) {
      return res.status(400).json({ error: "Reader not connected" });
    }

    const inspection = await inspectCard(readerDevice);
    if (!inspection.url) {
      return res.status(400).json({
        error: "No URL found to rewrite. Use POST /write with a URL."
      });
    }

    const result = await writeUrlToCard(readerDevice, inspection.url);

    res.json({
      success: true,
      message: "MIFARE Classic NDEF layout repaired and URL rewritten",
      url: result.url,
      mad: result.mad
    });
  } catch (err) {
    console.error("Fix-trailer error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/reset", async (req, res) => {
  try {
    if (!readerDevice) {
      return res.status(400).json({ error: "Reader not connected" });
    }

    await resetCard(readerDevice);

    res.json({
      success: true,
      message:
        "Card reset to transport layout. Sector 0 MAD cleared, sectors 1-15 blank, default keys/access bits restored."
    });
  } catch (err) {
    console.error("Reset error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json(getHealthSnapshot());
});

function startServer() {
  const server = createHttpsServer();
  socketBridge = attachSocketServer(server, {
    allowedOrigins: ALLOWED_CORS_ORIGINS,
    getHealthSnapshot,
    getReaderDevice: () => readerDevice,
    getNfcStatus: () => nfcStatus,
    inspectCard,
    resetCard,
    writeUrlToCard
  });

  server.listen(PORT, () => {
    console.log(`\n✅ NFC Agent Running on http://localhost:${PORT}`);
    console.log(`\n📌 MIFARE Classic 1K NDEF endpoints`);
    console.log(`   POST /write         - Format card correctly and write URL as NDEF`);
    console.log(`   GET  /read          - Read NDEF URL`);
    console.log(`   GET  /check         - Inspect MAD + NDEF mapping`);
    console.log(`   GET  /fix-trailer   - Rewrite current URL using proper NDEF layout`);
    console.log(`   GET  /reset         - Reset card to transport/default layout`);
    console.log(`\n🚀 Test with:`);
    console.log(
      `   curl -k -X POST https://localhost:${PORT}/write -H "Content-Type: application/json" -d '{"url":"https://peradipro.com"}'`
    );
    console.log(`   curl -k https://localhost:${PORT}/read`);
    console.log(`   curl -k https://localhost:${PORT}/check`);
    console.log(`   socket.io https://localhost:${PORT}/socket.io/`);
    console.log(`\nℹ️  Browser chooser/open is decided by Android, not by the ACR122U writer.`);
  });

  setImmediate(() => {
    try {
      ensureNfcInitialized();
    } catch (err) {
      nfcStatus = {
        state: "error",
        error: err.message
      };
      emitSocketStatus();
      console.error("[NFC] Initialization failed:", err.message);
    }
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  createNdefMessage,
  createTlv,
  buildMadDirectory,
  crc8Mad,
  inspectCard,
  normalizeUrl,
  startServer,
  writeUrlToCard
};
