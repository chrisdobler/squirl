const { app, BrowserWindow } = require('electron');

const url = process.argv[2] || 'http://127.0.0.1:5173/';

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: process.env.SHOW_SCROLL_VERIFY === '1',
    width: 1280,
    height: 820,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadURL(url);
  const result = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const started = Date.now();
      const wait = () => {
        const list = document.querySelector('.messageList');
        const messages = document.querySelectorAll('.message');
        if (list && messages.length > 0) {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const last = messages[messages.length - 1];
            const listRect = list.getBoundingClientRect();
            const lastRect = last.getBoundingClientRect();
            const initialDistance = list.scrollHeight - list.scrollTop - list.clientHeight;
            list.scrollTop = Math.max(0, list.scrollTop - 300);
            const afterScrollUpDistance = list.scrollHeight - list.scrollTop - list.clientHeight;
            list.scrollTop = list.scrollHeight;
            resolve({
              viewportHeight: window.innerHeight,
              messageCount: messages.length,
              scrollTop: list.scrollTop,
              scrollHeight: list.scrollHeight,
              clientHeight: list.clientHeight,
              distanceFromBottom: list.scrollHeight - list.scrollTop - list.clientHeight,
              initialDistanceFromBottom: initialDistance,
              afterScrollUpDistance,
              canScrollUp: afterScrollUpDistance > initialDistance,
              lastMessageBottomVisible: lastRect.bottom <= listRect.bottom + 2,
              lastMessagePreview: last.innerText.slice(0, 120)
            });
          }));
          return;
        }
        if (Date.now() - started > 5000) {
          resolve({ messageCount: messages.length, error: 'Timed out waiting for messages' });
          return;
        }
        setTimeout(wait, 50);
      };
      wait();
    })
  `);

  console.log(JSON.stringify(result, null, 2));
  await win.close();
  app.quit();
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
