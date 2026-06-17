import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startSquirlServer } from '../web/server.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let closeServer: (() => Promise<void>) | null = null;

async function createWindow(): Promise<void> {
  const api = await startSquirlServer({
    port: Number(process.env.SQUIRL_WEB_PORT ?? 4174),
    staticDir: resolve(__dirname, '../../dist-web'),
  });
  closeServer = api.close;

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: 'squirl',
    backgroundColor: '#101418',
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadURL(process.env.SQUIRL_ELECTRON_DEV_URL ?? api.url);
}

ipcMain.handle('squirl:version', () => app.getVersion());
ipcMain.handle('squirl:select-path', async (_event, options?: { directories?: boolean }) => {
  const result = await dialog.showOpenDialog({
    properties: options?.directories ? ['openDirectory'] : ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

app.whenReady().then(() => {
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
