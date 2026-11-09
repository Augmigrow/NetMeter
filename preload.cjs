const { contextBridge, ipcRenderer } = require('electron');

// The preload only exposes validated tile and gesture operations. Every call
// is resolved against the sending window in the main process, so a renderer
// can never name an arbitrary sibling as its single drag target.
contextBridge.exposeInMainWorld('netmeterDesktop', {
  dragDown: payload => ipcRenderer.send('tile:drag-down', {
    pointerId: Number(payload?.pointerId),
    gestureId: String(payload?.gestureId || ''),
    ctrl: Boolean(payload?.ctrl),
    screenX: Number(payload?.screenX),
    screenY: Number(payload?.screenY)
  }),
  dragMove: payload => ipcRenderer.send('tile:drag-move', {
    pointerId: Number(payload?.pointerId),
    gestureId: String(payload?.gestureId || ''),
    ctrl: Boolean(payload?.ctrl),
    screenX: Number(payload?.screenX),
    screenY: Number(payload?.screenY)
  }),
  dragUp: payload => ipcRenderer.send('tile:drag-up', {
    pointerId: Number(payload?.pointerId),
    gestureId: String(payload?.gestureId || ''),
    cancelled: Boolean(payload?.cancelled)
  }),
  dragModifier: payload => ipcRenderer.send('tile:drag-modifier', {
    gestureId: String(payload?.gestureId || ''),
    ctrl: Boolean(payload?.ctrl)
  }),
  onDragFeedback: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('tile:drag-feedback', listener);
    return () => ipcRenderer.removeListener('tile:drag-feedback', listener);
  },
  historyOpen: open => ipcRenderer.send('tile:history-open', Boolean(open)),
  openSettings: () => ipcRenderer.send('app:open-settings'),
  sharedState: state => ipcRenderer.send('app:shared-state', state || { entries: [] }),
  setLanguage: language => ipcRenderer.send('app:language', language),
  writeDragDiagnostics: payload => ipcRenderer.invoke('diag:drag', payload)
});
