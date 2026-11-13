const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('native', {
  open: () => ipcRenderer.invoke('open'),
  save: (name, ext, data) => ipcRenderer.invoke('save', name, ext, data),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, f) => cb(f)),
  info: () => ipcRenderer.invoke('app-info'),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  downloadUpdate: () => ipcRenderer.invoke('update-download'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  quit: () => ipcRenderer.invoke('quit'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
});
