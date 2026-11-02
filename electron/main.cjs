const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const dev = process.argv.includes('--dev');
const OPEN_EXTS = ['psd', 'psb', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico', 'svg', 'tif', 'tiff'];
let win;

async function readFile(p) { return { name: path.basename(p), path: p, data: await fs.readFile(p) }; }
const fileArg = (argv) => argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && OPEN_EXTS.includes(path.extname(a).slice(1).toLowerCase()));

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 900, minHeight: 600, backgroundColor: '#1b1b1d', title: 'PixelForge',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null); // the app draws its own menus
  if (dev) win.loadURL('http://localhost:5173'); else win.loadFile(path.join(__dirname, '../dist/index.html'));
  const initial = fileArg(process.argv);
  if (initial) win.webContents.once('did-finish-load', async () => win.webContents.send('open-path', await readFile(initial)));
}

ipcMain.handle('open', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images & PSD', extensions: OPEN_EXTS }, { name: 'All Files', extensions: ['*'] }],
  });
  return r.canceled ? [] : Promise.all(r.filePaths.map(readFile));
});

ipcMain.handle('save', async (_e, name, ext, data) => {
  const labels = { psd: 'Photoshop Document', png: 'PNG', jpg: 'JPEG', webp: 'WebP', bmp: 'Bitmap', tif: 'TIFF' };
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: labels[ext] || ext, extensions: [ext] }] });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, Buffer.from(data));
  return r.filePath;
});

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', async (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); const f = fileArg(argv); if (f) win.webContents.send('open-path', await readFile(f)); }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
