const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

function writeLog(message) {
  const logPath = path.join(app.getPath("userData"), "app.log");
  const time = new Date().toISOString();
  fs.appendFileSync(logPath, `[${time}] ${message}\n`);
}

app.whenReady().then(() => {
  writeLog("App started");

  try {
    const server = require("./index.js");

    // 🔥 start server
    server.startServer();
    writeLog("Server starting...");

    const win = new BrowserWindow({
      width: 1000,
      height: 700
    });

    // loading dulu biar tidak blank
    win.loadURL("data:text/html,<h2>Starting NFC Agent...</h2>");

    // kasih delay biar server ready
    setTimeout(() => {
      win.loadURL("http://localhost:43125");
      writeLog("Server loaded in window");
    }, 1500);

  } catch (err) {
    writeLog("ERROR: " + err.stack);
  }
});
