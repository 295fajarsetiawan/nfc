const { app } = require("electron");

app.whenReady().then(() => {
  console.log("Electron ready");

  // start express server
  require("./index.js");
});