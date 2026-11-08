// Electron shell: starts the camera server and shows the viewer (live feed + QR code).
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, shell, ipcMain, desktopCapturer } = require('electron');
const { start } = require('./server');

// WebRTC normally hides this PC's local IP behind a random ".local" name, which many
// Wi-Fi networks can't resolve. This app only talks to a phone on the same network, so
// let it use the real local address for a direct connection.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

let server;
let win;

async function createWindow() {
  try {
    server = await start({
      certDir: path.join(app.getPath('userData'), 'certs'),
      testsetDir: path.join(app.getPath('videos'), 'phone-cam', 'testset'),
      motionLogDir: path.join(app.getPath('videos'), 'phone-cam', 'motion-logs'),
    });
  } catch (e) {
    dialog.showErrorBox('Phone Camera',
      e.code === 'EADDRINUSE'
        ? `Port ${e.port} is already in use. Close the other phone-cam server and try again.`
        : String(e.stack || e));
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Phone Camera',
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,      // keep tracking at full speed when the window isn't focused
    },
  });
  // Open external links in the real browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // Recordings: save straight to Videos\phone-cam instead of asking every time.
  win.webContents.session.on('will-download', (_e, item) => {
    const dir = path.join(app.getPath('videos'), 'phone-cam');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, item.getFilename());
    item.setSavePath(filePath);
    item.once('done', (_e2, state) => { if (state === 'completed' && !win.isDestroyed()) win.webContents.send('saved', filePath); });
  });

  win.loadURL(server.viewerUrl);
}

// Windows and screens the viewer can capture for testing (minus this app's own window).
ipcMain.handle('screen-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } });
  return sources
    .filter((s) => s.name !== 'Phone Camera')
    .map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
});
ipcMain.handle('show-file', (_e, filePath) => shell.showItemInFolder(filePath));

// "Connect to Claude": register this app's MCP server with Claude Code / Claude Desktop.
const claude = require('./connect-claude');
ipcMain.handle('claude-status', () => claude.status());
ipcMain.handle('claude-connect', () => claude.connect({
  url: `${server.viewerUrl}mcp`,
  bridgeSource: path.join(__dirname, 'mcp-stdio-bridge.js'),
  bridgeDir: app.getPath('userData'),
  exePath: process.execPath,
}));
ipcMain.handle('claude-disconnect', () => claude.disconnect());

// Only one copy of the app: launching again just brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});
