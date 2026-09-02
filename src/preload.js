'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('dulse', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  send: (text) => ipcRenderer.invoke('chat:send', text),
  stop: () => ipcRenderer.send('chat:stop'),
  reset: () => ipcRenderer.send('chat:reset'),
  respondConfirm: (id, approved) => ipcRenderer.send('chat:confirm-response', { id, approved }),
  copy: (text) => ipcRenderer.send('clipboard:write', text),

  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  setApiKey: (provider, key) => ipcRenderer.invoke('config:set-key', { provider, key }),
  setVaults: (vaults) => ipcRenderer.invoke('config:set-vaults', vaults),
  reindex: () => ipcRenderer.invoke('vault:reindex'),
  revealNote: (vault, notePath) => ipcRenderer.invoke('vault:reveal', { vault, notePath }),

  collapse: () => ipcRenderer.invoke('win:collapse'),
  expand: () => ipcRenderer.invoke('win:expand'),
  hide: () => ipcRenderer.invoke('win:hide'),
  quit: () => ipcRenderer.invoke('win:quit'),
  getBounds: () => ipcRenderer.invoke('win:get-bounds'),
  setPosition: (x, y) => ipcRenderer.invoke('win:set-position', { x, y }),
  center: () => ipcRenderer.invoke('win:center'),
  setSize: (width, height) => ipcRenderer.invoke('win:set-size', { width, height }),

  onChatEvent: (handler) => on('chat:event', handler),
  onWindowState: (handler) => on('win:state', handler),
  onVaultState: (handler) => on('vault:state', handler),
  onReset: (handler) => on('chat:reset', handler),
  onFocusInput: (handler) => on('ui:focus-input', handler),
});
