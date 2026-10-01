'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a fixed API, never raw ipcRenderer or a caller-selected channel.
contextBridge.exposeInMainWorld('terminalAPI', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('terminal:bootstrap'),
  createSession: cwd => ipcRenderer.invoke('terminal:create-session', cwd),
  closeSession: id => ipcRenderer.invoke('terminal:close-session', id),
  write: (id, data, submittedCommand) => ipcRenderer.send('terminal:write', id, data, submittedCommand),
  resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
  changeDirectory: (id, directory) => ipcRenderer.invoke('terminal:change-directory', id, directory),
  listDirectory: (directory, showHidden) => ipcRenderer.invoke('terminal:list-directory', directory, showHidden),
  completions: (id, line) => ipcRenderer.invoke('terminal:completions', id, line),
  recordCommand: (command, cwd) => ipcRenderer.invoke('terminal:record-command', command, cwd),
  pinCommand: (command, pinned) => ipcRenderer.invoke('terminal:pin-command', command, pinned),
  clearHistory: () => ipcRenderer.invoke('terminal:clear-history'),
  saveSettings: settings => ipcRenderer.invoke('terminal:save-settings', settings),
  chooseDirectory: () => ipcRenderer.invoke('terminal:choose-directory'),
  openFile: file => ipcRenderer.invoke('terminal:open-file', file),
  openDirectory: directory => ipcRenderer.invoke('terminal:open-directory', directory),
  projectEditors: (id, refresh) => ipcRenderer.invoke('terminal:project-editors', id, refresh),
  openEditor: (id, editorId) => ipcRenderer.invoke('terminal:open-editor', id, editorId),
  copyText: text => ipcRenderer.invoke('terminal:copy-text', text),
  readText: () => ipcRenderer.invoke('terminal:read-text'),
  windowAction: action => ipcRenderer.send('terminal:window-action', action),
  onEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected an event callback.');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('terminal:event', listener);
    return () => ipcRenderer.removeListener('terminal:event', listener);
  },
}));
