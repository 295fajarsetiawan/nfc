const electron = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");

const SERVER_URL = "http://localhost:43125";
const { app, BrowserWindow } =
  typeof electron === "string" ? {} : electron;

if (!app || !BrowserWindow) {
  throw new Error(
    "Electron API is unavailable. This usually means ELECTRON_RUN_AS_NODE is set. Clear that environment variable, then run npm start again."
  );
}

function writeLog(message) {
  const logPath = path.join(app.getPath("userData"), "app.log");
  const time = new Date().toISOString();
  fs.appendFileSync(logPath, `[${time}] ${message}\n`);
}

async function waitForServerReady(url, timeoutMs = 20000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await new Promise((resolve, reject) => {
        const request = http.get(`${url}/health`, res => {
          res.resume();
          resolve(res);
        });

        request.on("error", reject);
      });

      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
        return;
      }
    } catch (err) {
      writeLog(`Waiting for server: ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

app.whenReady().then(async () => {
  writeLog("App started");

  try {
    const server = require("./index.js");
    server.startServer();
    writeLog("Server starting...");

    const win = new BrowserWindow({
      width: 1000,
      height: 700
    });

    await win.loadURL("data:text/html,<h2>Starting NFC Agent...</h2>");
    await waitForServerReady(SERVER_URL);
    await win.loadURL(SERVER_URL);
    writeLog("Server loaded in window");
  } catch (err) {
    writeLog("ERROR: " + err.stack);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.loadURL(
        `data:text/html,${encodeURIComponent(`<h2>NFC Agent gagal start</h2><pre>${err.message}</pre>`)}`
      );
    }
  }
});
