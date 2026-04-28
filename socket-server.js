const { Server } = require("socket.io");

function attachSocketServer(server, options) {
  const {
    allowedOrigins,
    getHealthSnapshot,
    getReaderDevice,
    getNfcStatus,
    inspectCard,
    resetCard,
    writeUrlToCard
  } = options;

  const io = new Server(server, {
    cors: {
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
          return callback(null, true);
        }

        return callback(new Error(`Origin not allowed: ${origin}`));
      },
      methods: ["GET", "POST"]
    }
  });

  async function withReader(action) {
    const reader = getReaderDevice();
    if (!reader) {
      throw new Error("Reader not connected");
    }

    return action(reader);
  }

  io.on("connection", socket => {
    socket.emit("nfc:health", getHealthSnapshot());

    socket.on("health:get", callback => {
      callback?.(getHealthSnapshot());
    });

    socket.on("nfc:check", async callback => {
      try {
        const inspection = await withReader(reader => inspectCard(reader));
        callback?.({
          success: true,
          readerName: getReaderDevice()?.name || null,
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
        callback?.({ success: false, error: err.message });
      }
    });

    socket.on("nfc:read", async callback => {
      try {
        const inspection = await withReader(reader => inspectCard(reader));
        callback?.(
          inspection.url
            ? {
                success: true,
                strategy: inspection.strategy,
                url: inspection.url,
                mad: inspection.mad,
                tlvHex: inspection.tlvHex,
                ndefMessageHex: inspection.ndefMessageHex
              }
            : {
                success: false,
                message: "No valid NDEF URL found",
                strategy: inspection.strategy,
                mad: inspection.mad,
                sector0: inspection.sector0,
                rawPayloadHex: inspection.rawPayloadHex
              }
        );
      } catch (err) {
        callback?.({ success: false, error: err.message });
      }
    });

    socket.on("nfc:write", async (payload, callback) => {
      try {
        const result = await withReader(reader => writeUrlToCard(reader, payload?.url));
        callback?.({
          success: true,
          message: `URL written as NDEF: ${result.url}`,
          url: result.url,
          nfcSectorCount: result.nfcSectorCount,
          mad: result.mad,
          ndefMessageHex: result.ndefMessageHex,
          tlvHex: result.tlvHex
        });
      } catch (err) {
        callback?.({ success: false, error: err.message });
      }
    });

    socket.on("nfc:reset", async callback => {
      try {
        await withReader(reader => resetCard(reader));
        callback?.({
          success: true,
          message:
            "Card reset to transport layout. Sector 0 MAD cleared, sectors 1-15 blank, default keys/access bits restored."
        });
      } catch (err) {
        callback?.({ success: false, error: err.message });
      }
    });
  });

  return {
    io,
    broadcastStatus() {
      io.emit("nfc:health", getHealthSnapshot());
    },
    broadcastEvent(eventName, payload) {
      io.emit(eventName, payload);
    },
    getNfcStatus
  };
}

module.exports = {
  attachSocketServer
};
