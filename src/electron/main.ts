import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startSquirlServer } from '../web/server.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const appIconPath = resolve(__dirname, '../../assets/app-icon.png');
const appIcon = nativeImage.createFromPath(appIconPath);

app.setName('Squirl');
process.title = 'Squirl';

let closeServer: (() => Promise<void>) | null = null;

async function createWindow(): Promise<void> {
  // Use Vite during development; serve the built renderer locally in production.
  const devUrl = process.env.SQUIRL_ELECTRON_DEV_URL;
  let appUrl = devUrl;

  if (!appUrl) {
    const api = await startSquirlServer({
      port: Number(process.env.SQUIRL_WEB_PORT ?? 4174),
      staticDir: resolve(__dirname, '../../dist-web'),
    });
    closeServer = api.close;
    appUrl = api.url;
  }

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: 'Squirl',
    icon: appIcon,
    backgroundColor: '#101418',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://accounts.google.com/')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  await win.loadURL(appUrl);
}

ipcMain.handle('squirl:version', () => app.getVersion());
ipcMain.handle('squirl:open-external', (_event, url: string) => {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('Only HTTPS external links are allowed.');
  return shell.openExternal(target.toString());
});
ipcMain.handle('squirl:open-path', async (_event, path: string) => {
  const error = await shell.openPath(resolve(path));
  if (error) throw new Error(error);
});
ipcMain.handle('squirl:select-path', async (_event, options?: { directories?: boolean }) => {
  const result = await dialog.showOpenDialog({
    properties: options?.directories ? ['openDirectory'] : ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

app.whenReady().then(() => {
  if (process.platform === 'darwin' && !appIcon.isEmpty()) app.dock?.setIcon(appIcon);
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'Squirl',
        submenu: [
          { role: 'about', label: 'About Squirl' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: 'Hide Squirl' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: 'Quit Squirl' },
        ],
      },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));
  }
  void createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (!closeServer) return;
  event.preventDefault();
  const close = closeServer;
  closeServer = null;
  void close().finally(() => app.exit(0));
});
