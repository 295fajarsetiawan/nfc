const { WebSocketServer } = require("ws");

function attachSocketServer(server, options) {
  const {
    allowedOrigins,
    getHealthSnapshot,
    getReaderDevice,
    inspectCard,
    resetCard,
    writeUrlToCard
  } = options;

  const wss = new WebSocketServer({ server });
  const clients = new Set();

  function sendJson(target, payload) {
    if (target.readyState === target.OPEN) {
      target.send(JSON.stringify(payload));
    }
  }

  function broadcast(payload) {
    const message = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  }

  async function withReader(action) {
    const reader = getReaderDevice();
    if (!reader) {
      throw new Error("Reader not connected");
    }

    return action(reader);
  }

  function buildCheckPayload(inspection) {
    return {
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
    };
  }

  function isOriginAllowed(origin) {
    return !origin || allowedOrigins.has(origin);
  }

  server.on("upgrade", (request, socket) => {
    if (!isOriginAllowed(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on("connection", socket => {
    clients.add(socket);
    sendJson(socket, {
      type: "nfc:health",
      data: getHealthSnapshot()
    });

    socket.on("message", async rawMessage => {
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
      } catch (err) {
        sendJson(socket, {
          type: "error",
          error: "Invalid JSON payload"
        });
        return;
      }

      const requestId = message?.id || null;
      const reply = payload => {
        sendJson(socket, {
          id: requestId,
          ...payload
        });
      };

      try {
        switch (message?.type) {
          case "health:get":
            reply({
              type: "health:result",
              success: true,
              data: getHealthSnapshot()
            });
            break;

          case "nfc:check": {
            const inspection = await withReader(reader => inspectCard(reader));
            reply({
              type: "nfc:check:result",
              ...buildCheckPayload(inspection)
            });
            break;
          }

          case "nfc:read": {
            const inspection = await withReader(reader => inspectCard(reader));
            reply({
              type: "nfc:read:result",
              ...(inspection.url
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
                  })
            });
            break;
          }

          case "nfc:write": {
            const result = await withReader(reader => writeUrlToCard(reader, message?.payload?.url));
            reply({
              type: "nfc:write:result",
              success: true,
              message: `URL written as NDEF: ${result.url}`,
              url: result.url,
              nfcSectorCount: result.nfcSectorCount,
              mad: result.mad,
              ndefMessageHex: result.ndefMessageHex,
              tlvHex: result.tlvHex
            });
            break;
          }

          case "nfc:reset":
            await withReader(reader => resetCard(reader));
            reply({
              type: "nfc:reset:result",
              success: true,
              message:
                "Card reset to transport layout. Sector 0 MAD cleared, sectors 1-15 blank, default keys/access bits restored."
            });
            break;

          default:
            reply({
              type: "error",
              success: false,
              error: `Unknown message type: ${message?.type || "undefined"}`
            });
        }
      } catch (err) {
        reply({
          type: `${message?.type || "unknown"}:result`,
          success: false,
          error: err.message
        });
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  return {
    broadcastStatus() {
      broadcast({
        type: "nfc:health",
        data: getHealthSnapshot()
      });
    },
    broadcastEvent(eventName, payload) {
      broadcast({
        type: eventName,
        data: payload
      });
    }
  };
}

module.exports = {
  attachSocketServer
};
