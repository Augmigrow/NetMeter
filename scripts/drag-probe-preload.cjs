const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('netmeterDesktop', {
  resizeWidget: layout => ipcRenderer.invoke('probe:resize', layout),
  moveWindow: (x, y) => ipcRenderer.invoke('probe:move', { x, y }),
  moveWindowFast: (x, y) => ipcRenderer.send('probe:move-fast', { x, y }),
  windowPosition: () => ipcRenderer.invoke('probe:position'),
  historyOpen: () => {},
  openSettings: () => {},
  settingsSaved: () => {}
});
