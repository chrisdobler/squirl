import { app, BrowserWindow } from 'electron';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await app.whenReady();

const win = new BrowserWindow({
  show: false,
  width: 1320,
  height: 860,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
  },
});

try {
  await win.loadURL(url);

  let result = null;
  for (let i = 0; i < 50; i++) {
    result = await win.webContents.executeJavaScript(`
      (() => {
        const list = document.querySelector('.messageList');
        const messages = [...document.querySelectorAll('.message')];
        const last = messages.at(-1);
        if (!list || messages.length === 0 || !last) {
          return { ready: false, messageCount: messages.length };
        }
        const distanceFromBottom = Math.round(list.scrollHeight - list.scrollTop - list.clientHeight);
        return {
          ready: true,
          messageCount: messages.length,
          distanceFromBottom,
          atLatest: distanceFromBottom <= 4,
          lastRole: [...last.classList].find((name) => name !== 'message') ?? '',
          lastText: last.textContent?.slice(0, 120) ?? '',
          latestButtonVisible: !!document.querySelector('.latestButton'),
        };
      })()
    `);
    if (result?.ready && result.atLatest) break;
    await wait(100);
  }

  console.log(JSON.stringify(result, null, 2));
  app.exit(result?.ready && result.atLatest ? 0 : 1);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  app.exit(1);
}
