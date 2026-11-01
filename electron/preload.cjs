const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('native', {
  open: () => ipcRenderer.invoke('open'),
  save: (name, ext, data) => ipcRenderer.invoke('save', name, ext, data),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, f) => cb(f)),
});
