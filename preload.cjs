const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('netmeterDesktop', {
  resizeWidget: layout => ipcRenderer.send('widget:resize', layout),
  moveWindow: (x, y) => ipcRenderer.invoke('widget:move', { x, y }),
  moveWindowFast: (x, y) => ipcRenderer.send('widget:move-fast', { x, y }),
  windowPosition: () => ipcRenderer.invoke('widget:position'),
  writeDragDiagnostics: payload => ipcRenderer.invoke('diag:drag', payload),
  historyOpen: open => ipcRenderer.send('widget:history-open', Boolean(open)),
  openSettings: () => ipcRenderer.send('app:open-settings'),
  settingsSaved: () => ipcRenderer.send('app:settings-saved'),
  setLanguage: language => ipcRenderer.send('app:language', language)
});
