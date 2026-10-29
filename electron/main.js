'use strict';

/**
 * ReelHouse desktop shell.
 *
 * The same local service used by `npm start` runs inside this process and the
 * window points at it, so the desktop apps need no separate server, no admin
 * rights and no internet connection (metadata needs a TMDB key and network).
 */

const path = require('path');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');

// Keep all user data in the platform-appropriate app folder.
process.env.REELHOUSE_DATA = process.env.REELHOUSE_DATA || path.join(app.getPath('userData'), 'data');

const { start } = require('../server/index');

let mainWindow = null;
let service = null;
let isQuitting = false;

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#08090c',
    title: 'ReelHouse',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 22 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(url);

  // Open any target="_blank" link in the user's browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, target) => {
    try {
      const allowed = new URL(url);
      const next = new URL(target);
      if (next.origin !== allowed.origin) {
        event.preventDefault();
        if (/^https?:/i.test(target)) shell.openExternal(target);
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Rescan Library',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            if (!mainWindow) return;
            mainWindow.webContents
              .executeJavaScript("fetch('/api/scan',{method:'POST'}).then(()=>location.reload())")
              .catch(() => {});
          },
        },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow && mainWindow.webContents.executeJavaScript("location.hash='#/settings'"),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(process.env.NODE_ENV === 'development' ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'TMDB account',
          click: () => shell.openExternal('https://www.themoviedb.org/settings/api'),
        },
        {
          label: 'Open data folder',
          click: () => shell.openPath(process.env.REELHOUSE_DATA),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  try {
    service = await start();
    buildMenu();
    createWindow(service.url);
    console.log(`[ReelHouse] desktop service listening on ${service.url}`);
  } catch (err) {
    console.error('[ReelHouse] failed to start the local service', err);
    dialog.showErrorBox(
      'ReelHouse could not start',
      `The local media service failed to start.\n\n${err.message}\n\nTry quitting ReelHouse and opening it again.`,
    );
    app.quit();
  }
}

// Only one copy of ReelHouse should own the library and the port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a media folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('shell:openDataFolder', async () => {
    await shell.openPath(process.env.REELHOUSE_DATA);
    return true;
  });

  // Open a library folder the user typed into Settings in Finder / Explorer.
  ipcMain.handle('shell:openPath', async (_event, target) => {
    if (typeof target !== 'string' || !target.trim()) return false;
    const resolved = path.resolve(target.trim().replace(/^~(?=\/|$)/, app.getPath('home')));
    const error = await shell.openPath(resolved);
    return error ? error : true;
  });

  app.whenReady().then(boot);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && service) createWindow(service.url);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (service && service.server) {
      try {
        service.server.close();
      } catch {
        /* already closed */
      }
    }
  });
}

process.on('uncaughtException', (err) => {
  console.error('[ReelHouse] uncaught exception', err);
  if (!isQuitting && mainWindow) {
    dialog.showErrorBox('ReelHouse error', String(err && err.message ? err.message : err));
  }
});
