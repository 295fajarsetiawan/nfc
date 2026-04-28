const { app } = require("electron");

// jalankan server Node Anda
require("./index.js");

app.whenReady().then(() => {
  console.log("Electron ready");
});