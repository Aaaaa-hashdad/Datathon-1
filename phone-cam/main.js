// Electron shell: starts the camera server and shows the viewer (live feed + QR code).
const path = require('path');
const { app, BrowserWindow, dialog, shell } = require('electron');
const { start } = require('./server');

let server;

async function createWindow() {
  try {
    server = await start({ certDir: path.join(app.getPath('userData'), 'certs') });
  } catch (e) {
    dialog.showErrorBox('Phone Camera',
      e.code === 'EADDRINUSE'
        ? `Port ${e.port} is already in use. Close the other phone-cam server and try again.`
        : String(e.stack || e));
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Phone Camera',
    backgroundColor: '#111111',
    autoHideMenuBar: true,
  });
  // Open external links in the real browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(server.viewerUrl);
}

// Only one copy of the app: launching again just brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});
