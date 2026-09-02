const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

let localServer;

// Keep the native traffic lights aligned with the app's 10px outer gutter and
// 48px title-bar spacing.
const MACOS_TRAFFIC_LIGHT_POSITION = { x: 28, y: 28 };

function safeName(value) {
  return path.basename(String(value || 'Portfolio Export.zip')).replace(/[\0\r\n]/g, '') || 'Portfolio Export.zip';
}

ipcMain.handle('portfolio:save-file', async (_event, { name, data }) => {
  const suggestedName = safeName(name);
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export portfolio',
    defaultPath: suggestedName,
    buttonLabel: 'Export',
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (canceled || !filePath) return { canceled: true };
  await fs.promises.writeFile(filePath, Buffer.from(data));
  return { canceled: false, filePath };
});

async function createWindow() {
  const dataDir = app.getPath('userData');
  process.env.PORTFOLIO_DATA_DIR = dataDir;
  process.env.OUTPUT_DIR = path.join(dataDir, 'Generated');
  process.env.SETTINGS_FILE = path.join(dataDir, 'settings.json');
  process.env.NO_OPEN = '1';

  // Release builds carry their own Playwright Chromium under app.asar.unpacked.
  // Point Playwright there before server.js (and therefore capture.js) loads so
  // the desktop app never depends on a browser in the user's cache.
  if (app.isPackaged) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'playwright-core',
      '.local-browsers',
    );
  }

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'build', 'icon-macos.png'));
  }

  const { startServer } = require('./server');
  localServer = startServer({ port: 0, host: '127.0.0.1', shouldOpen: false });
  if (!localServer.listening) await once(localServer, 'listening');
  const port = localServer.address().port;

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#f6f6f8',
    title: 'Portfolio Generator',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' && { trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => win.show());
  await win.loadURL(`http://127.0.0.1:${port}/?desktop=1`);
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('Portfolio Generator could not start', error.message);
  app.quit();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('before-quit', () => localServer && localServer.close());
