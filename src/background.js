'use strict';

// The tray and background running (PLAN.md step 4.4). Graded by the `tray-background` eval.
//
//   createBackground({ app, Tray, Menu, nativeImage, createWindow, argv?, platform? })
//     .start()            makes the tray and, unless the system started the app hidden at login, the window
//     .attach(win)        closing the window HIDES it; a real quit lets it close
//     .showWindow()       shows the window, making a new one if it was destroyed
//     .quit()             marks quitting, then app.quit()
//     .markQuitting()     the app is really quitting (the tray's Quit, Cmd+Q, a shutdown)
//     .windowsClosed()    what `window-all-closed` does: nothing while the tray exists
//     .state()            -> { quitting, hasTray, startHidden, loginItem: { available, enabled } }
//   iconBitmap(size)      the tray icon's pixels, drawn in code (a solid dot), so no image file has to be shipped
//
// The point: the runtime, the Telegram bot, the morning digest and the autoscaler live in this process, not in the window. Closing the window must not stop
// them, so a card on the phone can still be approved with the window closed. The window is only hidden; "Quit sfactory" in the tray (or the system's own
// quit) is what really ends the app, and main.js stops the runtime then.
//
// This file never requires `electron`: main.js hands it the app, the tray, the menu and the image maker, so it can be tested with stand-ins and the runtime
// stays free of Electron. "Start at login" works only in the installed app (`app.isPackaged`): in a development run the menu item says so and does nothing.
// A login start passes `--hidden`, so only the tray appears until the founder opens the window.

const HIDDEN_FLAG = '--hidden';
const ICON_SIZE = 16;

/** BGRA pixels of a solid dot on a clear background: opaque in the middle, fully clear in the corners. */
function iconBitmap(size = ICON_SIZE) {
  const buffer = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size * 0.4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inside = Math.hypot(x - centre, y - centre) <= radius;
      const at = (y * size + x) * 4;
      buffer[at] = 0; // blue
      buffer[at + 1] = 0; // green
      buffer[at + 2] = 0; // red: black, so a Mac can tint it as a template image
      buffer[at + 3] = inside ? 255 : 0;
    }
  }
  return buffer;
}

function createBackground({ app, Tray, Menu, nativeImage, createWindow, argv = process.argv, platform = process.platform } = {}) {
  const startHidden = Array.isArray(argv) && argv.includes(HIDDEN_FLAG);
  let tray = null;
  let win = null;
  let quitting = false;

  const packaged = () => app.isPackaged === true;
  const loginEnabled = () => {
    try {
      return packaged() && Boolean(app.getLoginItemSettings().openAtLogin);
    } catch {
      return false;
    }
  };

  function attach(window) {
    win = window;
    window.on('ready-to-show', () => window.show());
    window.on('close', (event) => {
      if (quitting) return; // a real quit lets it close
      event.preventDefault();
      window.hide(); // the runtime goes on in the background
    });
    window.on('closed', () => {
      if (win === window) win = null;
    });
  }

  function showWindow() {
    if (!win || win.isDestroyed()) {
      win = createWindow();
      attach(win);
      return;
    }
    if (win.isMinimized?.()) win.restore();
    win.show();
    win.focus();
  }

  function quit() {
    quitting = true;
    app.quit();
  }

  function setLoginItem(on) {
    if (!packaged()) return; // only the installed app can start at login
    app.setLoginItemSettings({ openAtLogin: Boolean(on), args: on ? [HIDDEN_FLAG] : [] });
    buildMenu();
  }

  function buildMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open sfactory', click: () => showWindow() },
      { type: 'separator' },
      packaged()
        ? { label: 'Start at login', type: 'checkbox', checked: loginEnabled(), click: (item) => setLoginItem(item?.checked) }
        : { label: 'Start at login (only in the installed app)', type: 'checkbox', checked: false, enabled: false },
      { type: 'separator' },
      { label: 'Quit sfactory', click: () => quit() },
    ]));
  }

  function start() {
    if (Tray && !tray) {
      const image = nativeImage.createFromBitmap(iconBitmap(ICON_SIZE * 2), { width: ICON_SIZE * 2, height: ICON_SIZE * 2, scaleFactor: 2 });
      if (platform === 'darwin') image.setTemplateImage(true);
      tray = new Tray(image);
      tray.setToolTip('sfactory is running. Open it, or quit it, from here.');
      tray.on('click', () => showWindow());
      buildMenu();
    }
    if (!startHidden) showWindow();
  }

  return {
    start,
    attach,
    showWindow,
    quit,
    markQuitting() {
      quitting = true;
    },
    /** `window-all-closed`: stay running while the tray is there to bring the window back; with no tray, quit (except on a Mac, which stays running). */
    windowsClosed() {
      if (tray || platform === 'darwin') return;
      app.quit();
    },
    state: () => ({ quitting, hasTray: tray !== null, startHidden, loginItem: { available: packaged(), enabled: loginEnabled() } }),
  };
}

module.exports = { createBackground, iconBitmap, HIDDEN_FLAG };
