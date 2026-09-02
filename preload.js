const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portfolioDesktop', {
  saveFile: async (name, arrayBuffer) => ipcRenderer.invoke('portfolio:save-file', {
    name,
    data: new Uint8Array(arrayBuffer),
  }),
  platform: process.platform,
});
