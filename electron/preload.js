'use strict';

/**
 * Minimal, explicitly-scoped bridge for the desktop app.
 * The renderer stays sandboxed from Node — only these helpers are exposed.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reelhouseDesktop', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openDataFolder: () => ipcRenderer.invoke('shell:openDataFolder'),
  openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
});
