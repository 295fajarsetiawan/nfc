const { app } = require("electron");
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
    require("./index.js");
    writeLog("Server started successfully");
  } catch (err) {
    writeLog("ERROR: " + err.stack);
  }
});
