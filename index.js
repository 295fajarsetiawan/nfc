if (!Object.hasOwn) {
  Object.hasOwn = (target, property) =>
    Object.prototype.hasOwnProperty.call(Object(target), property);
}

const fs = require("fs");
const http = require("http");
const path = require("path");
const ndef = require("ndef");
const { attachSocketServer } = require("./socket-server");

const PORT = 43125;
const CLIENT_HTML_PATH = path.join(__dirname, "socket-client-example.html");
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const ALLOWED_ORIGINS = new Set([
  "http://peradiprof.or.id",
  "http://www.peradiprof.or.id",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:43125",
  "http://127.0.0.1:43125",
  "https://peradiprof.or.id",
  "https://www.peradiprof.or.id",
  "null"
]);

function isLoopbackOrigin(origin) {
  try {
    const parsed = new URL(origin);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      LOOPBACK_HOSTNAMES.has(parsed.hostname)
    );
  } catch (err) {
    return false;
  }
}

function isOriginAllowed(origin) {
  return !origin || ALLOWED_ORIGINS.has(origin) || isLoopbackOrigin(origin);
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin || !isOriginAllowed(origin)) {
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

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
  if (nfcInitialized || nfcInitStarted) {
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

function createClientPage() {
  return fs.readFileSync(CLIENT_HTML_PATH, "utf8");
}

function createHttpServer() {
  return http.createServer((req, res) => {
    if (!isOriginAllowed(req.headers.origin)) {
      res.writeHead(403);
      res.end("Origin not allowed");
      return;
    }

    applyCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(createClientPage());
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(getHealthSnapshot()));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });
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

function sectorDataBlocks(sector) {
  const base = sector * BLOCKS_PER_SECTOR;
  return [base, base + 1, base + 2];
}

function sectorTrailerBlock(sector) {
  return sector * BLOCKS_PER_SECTOR + 3;
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

function startServer() {
  const server = createHttpServer();
  socketBridge = attachSocketServer(server, {
    allowedOrigins: ALLOWED_ORIGINS,
    isOriginAllowed,
    getHealthSnapshot,
    getReaderDevice: () => readerDevice,
    inspectCard,
    resetCard,
    writeUrlToCard
  });

  server.listen(PORT, () => {
    console.log(`NFC Agent WebSocket running at http://localhost:${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
    console.log("Commands via WebSocket message types: health:get, nfc:write, nfc:read, nfc:check, nfc:reset");
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
  createNdefMessage,
  createTlv,
  buildMadDirectory,
  crc8Mad,
  inspectCard,
  normalizeUrl,
  startServer,
  writeUrlToCard
};
