const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
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
  // The renderer cancels `beforeunload` while any document has unsaved changes. Browsers turn that into a prompt,
  // but Electron just silently refuses to close. So the close is held here and the renderer is asked to run the
  // Save / Don't Save / Cancel prompt (it knows which documents are unsaved and how to save them); it calls
  // `quit-confirm` to show the dialog and `quit-force` once it is safe to go.
  win.webContents.on('will-prevent-unload', () => win.webContents.send('quit-requested'));
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

// ---------------------------------------------------------------- updates (Help ▸ Check for Updates…)
// Installed (NSIS) builds update in place from the GitHub Releases of this repo. The portable exe and dev runs can't
// replace themselves, so they just point at the releases page.
const REPO = 'https://github.com/jnstacy98/pixelforge';
const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
const canSelfUpdate = app.isPackaged && !portable;
let updater = null, updateBusy = false;
const sendUpdate = (s) => { if (win && !win.isDestroyed()) win.webContents.send('update-status', s); };

function getUpdater() {
  if (updater) return updater;
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = false;           // always ask first
  updater.autoInstallOnAppQuit = true;    // a downloaded update is applied when the app is next closed
  updater.on('update-available', (i) => sendUpdate({ state: 'available', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : '' }));
  updater.on('update-not-available', () => sendUpdate({ state: 'current' }));
  updater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => sendUpdate({ state: 'ready', version: i.version }));
  updater.on('error', (e) => { updateBusy = false; sendUpdate({ state: 'error', message: String((e && e.message) || e).split('\n')[0] }); });
  return updater;
}

ipcMain.handle('app-info', () => ({
  version: app.getVersion(), canSelfUpdate, portable, packaged: app.isPackaged,
  electron: process.versions.electron, platform: process.platform, arch: process.arch,
}));
ipcMain.handle('update-check', async () => {
  if (!canSelfUpdate) return { state: 'unsupported', portable, packaged: app.isPackaged };
  if (updateBusy) return { state: 'busy' };
  updateBusy = true;
  try { await getUpdater().checkForUpdates(); } catch (e) { sendUpdate({ state: 'error', message: String((e && e.message) || e).split('\n')[0] }); }
  updateBusy = false;
  return { state: 'checking' };
});
ipcMain.handle('update-download', async () => {
  if (!canSelfUpdate) return;
  try { await getUpdater().downloadUpdate(); } catch (e) { sendUpdate({ state: 'error', message: String((e && e.message) || e).split('\n')[0] }); }
});
ipcMain.handle('update-install', () => { if (canSelfUpdate) getUpdater().quitAndInstall(false, true); });
ipcMain.handle('quit', () => { if (win && !win.isDestroyed()) win.close(); }); // same path as the X button
ipcMain.handle('quit-confirm', (_e, names) => {
  const list = Array.isArray(names) ? names.map(String) : [];
  const one = list.length === 1;
  return dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2, noLink: true, title: 'Unsaved Changes',
    message: one ? `Save changes to "${list[0]}" before quitting?` : `Save changes to ${list.length} documents before quitting?`,
    detail: (one ? '' : list.map((n) => '• ' + n).join('\n') + '\n\n') + "Your changes will be lost if you don't save them.",
  }).then((r) => ['save', 'discard', 'cancel'][r.response] || 'cancel');
});
ipcMain.handle('quit-force', () => { if (win && !win.isDestroyed()) win.destroy(); }); // skips beforeunload
ipcMain.handle('open-external', (_e, url) => {
  // only ever open pages of this project, never an arbitrary URL from the renderer
  if (typeof url === 'string' && (url === REPO || url.startsWith(REPO + '/'))) return shell.openExternal(url);
});

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', async (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); const f = fileArg(argv); if (f) win.webContents.send('open-path', await readFile(f)); }
  });
  app.whenReady().then(() => {
    createWindow();
    // quiet check shortly after launch; the user only hears about it if there is something new
    if (canSelfUpdate) win.webContents.once('did-finish-load', () => setTimeout(() => { getUpdater().checkForUpdates().catch(() => {}); }, 8000));
  });
  app.on('window-all-closed', () => app.quit());
}
