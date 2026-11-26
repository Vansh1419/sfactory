const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createApp } = require('./runtime');
const { setupIpc } = require('./ipc');
const { createBackground } = require('./background');

// electron-vite builds to out/main, out/preload and out/renderer.
const RENDERER_FILE = path.join(__dirname, '../renderer/index.html');

let sfactory; // the runtime and its database connection
let ipc;
let background; // the tray, and what closing the window does

function createWindow() {
  const win = new BrowserWindow({
    show: false, // shown by the background controller when the page is ready (and not at all when the system started the app hidden at login)
    width: 900,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The app never opens extra windows. Links go nowhere.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (process.env.ELECTRON_RENDERER_URL) {
    // `npm run dev`: Vite dev server with hot reload.
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(RENDERER_FILE);
  }
  return win;
}

/** Create the runtime and the IPC bridge. Synchronous, so the bridge exists before the page loads. */
function initRuntime() {
  try {
    // Settings already in the environment win over .env.
    process.loadEnvFile(path.join(app.getAppPath(), '.env'));
  } catch {
    // No .env: the runtime reports exactly what is missing.
  }
  sfactory = createApp({ env: process.env, version: app.getVersion(), filesystemRoot: app.getAppPath(), toolConfigDir: path.join(app.getAppPath(), 'config', 'mcp'), skillsDir: path.join(app.getAppPath(), '.claude', 'skills'), podTemplatesDir: path.join(app.getAppPath(), 'config', 'pods'), podsRoot: path.join(app.getPath('userData'), 'pods') });
  ipc = setupIpc({
    runtime: sfactory.runtime,
    rendererFileUrl: pathToFileURL(RENDERER_FILE).href,
    rendererDevUrl: process.env.ELECTRON_RENDERER_URL,
  });
}

app.whenReady().then(() => {
  initRuntime();
  // The tray (step 4.4): closing the window only hides it, so the runtime, the Telegram bot and the autoscaler keep working in the background.
  // "Quit sfactory" in the tray, or the system's own quit, is what really ends the app.
  background = createBackground({ app, Tray, Menu, nativeImage, createWindow });
  background.start();
  // Records that the runtime started, or blocks it (and says why) if the database is not ready.
  sfactory.start();

  app.on('activate', () => background.showWindow());
});

let quitting = false;
app.on('before-quit', (event) => {
  background?.markQuitting(); // from here the window may really close
  if (quitting || !sfactory) return;
  event.preventDefault();
  quitting = true;
  // Record the stop, but never let a slow database hold the app open.
  Promise.race([sfactory.stop(), new Promise((resolve) => setTimeout(resolve, 2000))]).finally(() => {
    ipc?.dispose();
    app.quit();
  });
});

// With the tray there is always something to bring the window back, so the app keeps running (see background.windowsClosed).
app.on('window-all-closed', () => background?.windowsClosed());
