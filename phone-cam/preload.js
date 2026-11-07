// Small, explicit bridge from the viewer page to the Electron app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phoneCamNative', {
  // windows and screens that can be captured: [{ id, name, thumb (data URL) }]
  screenSources: () => ipcRenderer.invoke('screen-sources'),
  // called with the full path whenever a recording finishes saving
  onSaved: (cb) => ipcRenderer.on('saved', (_e, filePath) => cb(filePath)),
  showFile: (filePath) => ipcRenderer.invoke('show-file', filePath),
  // register / remove this app as an MCP server in Claude Code and Claude Desktop
  claudeStatus: () => ipcRenderer.invoke('claude-status'),
  claudeConnect: () => ipcRenderer.invoke('claude-connect'),
  claudeDisconnect: () => ipcRenderer.invoke('claude-disconnect'),
});
