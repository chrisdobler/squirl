import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bin = (name: string) => resolve(projectRoot, 'node_modules', '.bin', name);
const rendererUrl = process.env.SQUIRL_ELECTRON_DEV_URL ?? 'http://127.0.0.1:5173';
const rendererPort = new URL(rendererUrl).port || '5173';
const apiPort = process.env.SQUIRL_API_PORT ?? '4174';
const apiUrl = `http://127.0.0.1:${apiPort}`;
const apiHealthUrl = `http://127.0.0.1:${apiPort}/api/state`;

function runChecked(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
}

function prepareMacDevApp(): string {
  const sourceApp = resolve(projectRoot, 'node_modules/electron/dist/Electron.app');
  const cacheRoot = resolve(projectRoot, 'node_modules/.cache/squirl-electron');
  const devApp = resolve(cacheRoot, 'Squirl.app');
  const iconSource = resolve(projectRoot, 'assets/app-icon.png');
  const markerPath = resolve(cacheRoot, 'build.json');
  const marker = JSON.stringify({
    schema: 1,
    electron: statSync(resolve(sourceApp, 'Contents/Info.plist')).mtimeMs,
    icon: statSync(iconSource).mtimeMs,
  });

  if (existsSync(devApp) && existsSync(markerPath) && readFileSync(markerPath, 'utf8') === marker) {
    return resolve(devApp, 'Contents/MacOS/Electron');
  }

  console.log('[electron-hot] Preparing the cached Squirl.app development bundle.');
  rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(cacheRoot, { recursive: true });
  runChecked('/bin/cp', ['-cR', sourceApp, devApp]);

  const plist = resolve(devApp, 'Contents/Info.plist');
  for (const [key, value] of [
    ['CFBundleName', 'Squirl'],
    ['CFBundleDisplayName', 'Squirl'],
    ['CFBundleIdentifier', 'com.dobsys.squirl.dev'],
    ['CFBundleIconFile', 'squirl.icns'],
  ]) {
    runChecked('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  }

  const iconset = resolve(cacheRoot, 'Squirl.iconset');
  mkdirSync(iconset);
  for (const [name, size] of [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ] as const) {
    runChecked('/usr/bin/sips', ['-z', String(size), String(size), iconSource, '--out', resolve(iconset, name)]);
  }
  runChecked('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', resolve(devApp, 'Contents/Resources/squirl.icns')]);
  rmSync(iconset, { recursive: true, force: true });
  runChecked('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', devApp]);
  writeFileSync(markerPath, marker);
  return resolve(devApp, 'Contents/MacOS/Electron');
}

const electronExecutable = process.platform === 'darwin' ? prepareMacDevApp() : bin('electron');

const children = new Set<ChildProcess>();
let electron: ChildProcess | null = null;
let electronBuild: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let rebuildQueued = false;
let restartingElectron = false;
let shuttingDown = false;
let rendererReady = false;

function run(command: string, args: string[], env = process.env): ChildProcess {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function supervise(child: ChildProcess, name: string): void {
  child.once('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[electron-hot] ${name} exited (${code ?? 0}); shutting down.`);
      shutdown(code ?? 1);
    }
  });
}

function startElectron(): void {
  restartingElectron = false;
  electron = run(electronExecutable, ['dist/electron/main.js'], {
    ...process.env,
    SQUIRL_ELECTRON_DEV_URL: rendererUrl,
  });

  electron.once('exit', (code) => {
    electron = null;
    if (!shuttingDown && !restartingElectron) shutdown(code ?? 0);
  });
}

function restartElectron(): void {
  if (!rendererReady || shuttingDown) return;
  if (!electron) {
    startElectron();
    return;
  }

  restartingElectron = true;
  const current = electron;
  current.once('exit', () => {
    if (!shuttingDown) startElectron();
  });
  current.kill('SIGTERM');
}

function rebuildElectron(): void {
  if (electronBuild) {
    rebuildQueued = true;
    return;
  }

  console.log('[electron-hot] Electron source changed; rebuilding.');
  electronBuild = run(bin('tsc'), ['-p', 'tsconfig.electron.json']);
  electronBuild.once('exit', (code) => {
    electronBuild = null;
    if (code === 0) restartElectron();
    else console.error(`[electron-hot] Electron rebuild failed (${code ?? 1}); keeping the current app open.`);

    if (rebuildQueued && !shuttingDown) {
      rebuildQueued = false;
      rebuildElectron();
    }
  });
}

function scheduleElectronRebuild(filename: string | null): void {
  if (!filename || !filename.endsWith('.ts') || filename === 'dev-hot.ts') return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(rebuildElectron, 150);
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForUrl(url: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(url)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Timed out waiting for ${label} at ${url}`);
}

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  if (restartTimer) clearTimeout(restartTimer);
  electronWatcher.close();
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 100).unref();
}

const electronWatcher = watch(resolve(projectRoot, 'src/electron'), (_event, filename) => {
  scheduleElectronRebuild(filename);
});

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));

try {
  const [rendererRunning, apiRunning] = await Promise.all([
    isReachable(rendererUrl),
    isReachable(apiHealthUrl),
  ]);

  if (rendererRunning && apiRunning) {
    console.log(`[electron-hot] Reusing the web stack at ${rendererUrl} (API ${apiPort}).`);
  } else {
    if (rendererRunning) {
      console.log(`[electron-hot] Reusing Vite at ${rendererUrl}; starting the missing API.`);
    } else {
      const vite = run(bin('vite'), ['--host', '127.0.0.1', '--port', rendererPort, '--strictPort'], {
        ...process.env,
        VITE_SQUIRL_API_BASE: apiUrl,
      });
      supervise(vite, 'Vite');
    }

    if (apiRunning) {
      console.log(`[electron-hot] Reusing the API on port ${apiPort}; starting the missing Vite renderer.`);
    } else {
      const api = run(bin('tsx'), ['watch', 'src/web/dev-api.ts'], {
        ...process.env,
        SQUIRL_API_PORT: apiPort,
        SQUIRL_WEB_DEV_ORIGIN: new URL(rendererUrl).origin,
      });
      supervise(api, 'Squirl API');
    }

    await Promise.all([
      waitForUrl(rendererUrl, 'Vite'),
      waitForUrl(apiHealthUrl, 'the Squirl API'),
    ]);
  }

  rendererReady = true;
  startElectron();
} catch (error) {
  console.error(`[electron-hot] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
}
