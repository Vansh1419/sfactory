'use strict';

// Grades the tray and background running (PLAN.md step 4.4). "Done when: with the window closed, a Telegram approval still resolves."
//   src/background.js     createBackground({ app, Tray, Menu, nativeImage, createWindow, argv?, platform? })
//     .start()            makes the tray and, unless the app was started hidden, the window
//     .attach(win)        closing the window HIDES it (the runtime, the bot and the autoscaler keep going); a real quit lets it close
//     .showWindow()       shows the window, making a new one if it was destroyed
//     .quit()             the only way out besides the system's own quit: marks quitting, then app.quit()
//     .markQuitting()     called when the app is really quitting (Cmd+Q, the tray's Quit, a shutdown)
//     .windowsClosed()    what `window-all-closed` does: stay running while the tray exists
//     .state()            -> { quitting, hasTray, startHidden, loginItem: { available, enabled } }
//     iconBitmap(size)    -> the tray icon's pixels (no image file is needed)
//   src/main.js           uses it
//
// Electron is a stand-in here (a window, a tray, a menu and an app that record what they are asked to do), because the tests must not open a window. The runtime
// is the real one: a real Postgres with the real migrations, the real decisions service and Telegram bot and poller, with a fake Telegram.
//
//   - the done-when: with the window closed (hidden) a card still reaches the phone and one tap on it approves it, exactly as with the window open
//   - closing the window never quits the app and never stops the runtime; quitting for real still closes it, and the runtime is stopped by main.js on quit
//   - the tray offers: open the window, start at login, quit; a click on it opens the window; the window is made again if it was destroyed
//   - start at login works only in the installed app (`app.isPackaged`), starts hidden (`--hidden`), and says plainly when it is not available
//   - the runtime still never imports electron, so it can run headless on a server later

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FOUNDER = 424242;
const TELEGRAM_TOKEN = `123456789:${'B'.repeat(35)}`;

/** Stand-ins for what Electron gives main.js. Each records what it was asked to do. */
function electron({ packaged = true, platform = 'linux', loginOpen = false, argv = ['electron', '.'] } = {}) {
  const log = [];
  const windows = [];
  const makeWindow = () => {
    const handlers = {};
    const win = {
      destroyed: false, visible: false, minimized: false,
      on(event, fn) { (handlers[event] ??= []).push(fn); return win; },
      once(event, fn) { (handlers[event] ??= []).push(fn); return win; },
      emit(event, e = {}) { for (const fn of handlers[event] ?? []) fn(e); return e; },
      hide() { win.visible = false; log.push('hide'); },
      show() { win.visible = true; log.push('show'); },
      focus() { log.push('focus'); },
      restore() { win.minimized = false; log.push('restore'); },
      isDestroyed: () => win.destroyed,
      isVisible: () => win.visible,
      isMinimized: () => win.minimized,
      destroy() { win.destroyed = true; win.emit('closed'); },
    };
    windows.push(win);
    return win;
  };
  let login = { openAtLogin: loginOpen };
  const app = {
    isPackaged: packaged,
    quitCalls: 0,
    quit() { app.quitCalls += 1; log.push('quit'); },
    getLoginItemSettings: () => login,
    setLoginItemSettings(settings) { login = { openAtLogin: Boolean(settings.openAtLogin) }; log.push(['login', settings]); },
    dock: platform === 'darwin' ? { show() {}, hide() {} } : undefined,
  };
  const trays = [];
  class Tray {
    constructor(image) { this.image = image; this.menu = null; this.tooltip = ''; this.handlers = {}; trays.push(this); }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; }
    on(event, fn) { this.handlers[event] = fn; }
    click() { this.handlers.click?.(); }
  }
  const Menu = { buildFromTemplate: (template) => ({ template }) };
  const images = [];
  const nativeImage = { createFromBitmap: (buffer, options) => { const img = { buffer, options, template: false, setTemplateImage(v) { img.template = v; } }; images.push(img); return img; } };
  const item = (name) => trays.at(-1)?.menu?.template?.find((i) => i.label === name || (typeof i.label === 'string' && i.label.startsWith(name)));
  return { app, Tray, Menu, nativeImage, makeWindow, windows, trays, images, log, item, argv, platform };
}

function background(e, extra = {}) {
  const { createBackground } = loadSubject('src/background.js');
  return createBackground({ app: e.app, Tray: e.Tray, Menu: e.Menu, nativeImage: e.nativeImage, createWindow: () => e.makeWindow(), argv: e.argv, platform: e.platform, ...extra });
}

const cases = [
  {
    id: 'a-closing-the-window-hides-it-and-never-quits-or-destroys-it-and-a-real-quit-lets-it-close',
    async check() {
      const e = electron();
      const b = background(e);
      b.start();
      const win = e.windows[0];
      win.emit('ready-to-show');
      const first = win.emit('close', { prevented: false, preventDefault() { this.prevented = true; } });
      const afterFirst = { prevented: first.prevented, visible: win.isVisible(), destroyed: win.isDestroyed(), quits: e.app.quitCalls };
      win.show();
      const second = win.emit('close', { prevented: false, preventDefault() { this.prevented = true; } });
      b.markQuitting();
      const real = win.emit('close', { prevented: false, preventDefault() { this.prevented = true; } });
      return verdict(afterFirst.prevented && afterFirst.visible === false && afterFirst.destroyed === false && afterFirst.quits === 0 && second.prevented && win.isVisible() === false && real.prevented === false && b.state().quitting === true,
        `after the first close ${json(afterFirst)}; second prevented ${second.prevented}; while quitting prevented ${real.prevented}`);
    },
  },
  {
    id: 'b-the-tray-offers-open-start-at-login-and-quit-and-a-click-opens-the-window-which-is-made-again-if-it-was-destroyed',
    async check() {
      const e = electron();
      const b = background(e);
      b.start();
      b.start(); // a second start makes no second tray
      const tray = e.trays[0];
      const labels = tray.menu.template.filter((i) => i.label).map((i) => i.label);
      const login = tray.menu.template.find((i) => /login/i.test(i.label ?? ''));
      e.windows[0].emit('ready-to-show');
      e.windows[0].emit('close', { preventDefault() {} }); // hidden
      tray.click();
      const shown = e.windows[0].isVisible();
      e.windows[0].destroy();
      tray.menu.template.find((i) => i.label === 'Open sfactory').click();
      const remade = e.windows.length === 2 && e.windows[1].isVisible() === false; // made, shown when ready
      e.windows[1].emit('ready-to-show');
      tray.menu.template.find((i) => i.label === 'Quit sfactory').click();
      const stayed = b.windowsClosed();
      return verdict(e.trays.length === 1 && labels.includes('Open sfactory') && labels.includes('Quit sfactory') && login && login.type === 'checkbox' && /tooltip|sfactory/i.test(tray.tooltip) && e.images.length >= 1 && shown && remade && e.windows[1].isVisible()
        && b.state().quitting === true && e.app.quitCalls === 1 && stayed === undefined,
        `trays ${e.trays.length}; labels ${json(labels)}; shown by a click ${shown}; made again ${remade}; quit calls ${e.app.quitCalls}; tooltip ${tray.tooltip}`);
    },
  },
  {
    id: 'c-all-windows-closed-keeps-the-app-running-while-the-tray-exists-and-quits-only-when-there-is-none',
    async check() {
      const withTray = electron();
      const a = background(withTray);
      a.start();
      a.windowsClosed();
      const kept = withTray.app.quitCalls === 0;
      const noTray = electron();
      const b = background(noTray, { Tray: undefined });
      b.windowsClosed();
      const darwin = electron({ platform: 'darwin' });
      const c = background(darwin, { Tray: undefined });
      c.windowsClosed();
      return verdict(kept && noTray.app.quitCalls === 1 && darwin.app.quitCalls === 0, `with a tray quits ${withTray.app.quitCalls}; without ${noTray.app.quitCalls}; on a Mac without ${darwin.app.quitCalls}`);
    },
  },
  {
    id: 'd-start-at-login-works-in-the-installed-app-starts-hidden-and-says-so-when-it-is-not-available',
    async check() {
      const packaged = electron({ packaged: true });
      const a = background(packaged);
      a.start();
      const item = packaged.item('Start at login');
      item.click({ checked: true });
      const on = packaged.log.find((l) => Array.isArray(l) && l[0] === 'login')?.[1];
      const rebuilt = packaged.item('Start at login');
      const enabled = a.state().loginItem;
      item.click({ checked: false });
      const off = packaged.log.filter((l) => Array.isArray(l) && l[0] === 'login').at(-1)?.[1];

      const dev = electron({ packaged: false });
      const b = background(dev);
      b.start();
      const devItem = dev.item('Start at login');
      devItem.click?.({ checked: true });
      const devCalls = dev.log.filter((l) => Array.isArray(l) && l[0] === 'login').length;

      // Started by the system at login: only the tray, no window until asked.
      const hidden = electron({ argv: ['app', '--hidden'] });
      const c = background(hidden);
      c.start();
      const noWindow = hidden.windows.length === 0 && hidden.trays.length === 1 && c.state().startHidden === true;
      hidden.trays[0].click();
      const opened = hidden.windows.length === 1;
      hidden.windows[0].emit('ready-to-show');
      const visible = hidden.windows[0].isVisible();
      const normal = electron();
      background(normal).start();
      return verdict(on?.openAtLogin === true && Array.isArray(on.args) && on.args.includes('--hidden') && off?.openAtLogin === false && !(off.args ?? []).includes('--hidden') && enabled.available === true && rebuilt
        && devCalls === 0 && /installed app|not available/i.test(devItem.label) && devItem.enabled === false && dev.app.quitCalls === 0 && b.state().loginItem.available === false
        && noWindow && opened && visible && normal.windows.length === 1,
        `on ${json(on)}; off ${json(off)}; unpackaged label ${devItem.label} enabled ${devItem.enabled} calls ${devCalls}; hidden start windows ${hidden.windows.length}`);
    },
  },
  {
    id: 'e-the-tray-icon-is-drawn-in-code-with-a-solid-centre-clear-corners-and-the-right-size-and-is-a-template-on-a-mac',
    async check() {
      const { iconBitmap } = loadSubject('src/background.js');
      const e = electron({ platform: 'darwin' });
      background(e).start();
      const small = iconBitmap(16);
      const px = (buf, size, x, y) => buf[(y * size + x) * 4 + 3];
      const img = e.images.at(-1);
      return verdict(Buffer.isBuffer(small) && small.length === 16 * 16 * 4 && px(small, 16, 8, 8) === 255 && px(small, 16, 0, 0) === 0 && px(small, 16, 15, 15) === 0 && img && img.options.width >= 16 && img.options.height === img.options.width && img.template === true,
        `size ${small.length}; centre ${px(small, 16, 8, 8)}; corner ${px(small, 16, 0, 0)}; image ${json(img?.options)}; template ${img?.template}`);
    },
  },
  {
    id: 'f-done-when-with-the-window-closed-a-card-still-reaches-the-phone-and-one-tap-approves-it',
    async check() {
      const path2 = require('node:path');
      const { startFakeSupabase } = require(path2.join(ROOT, 'scripts/fake-supabase'));
      const { createApp } = require(path2.join(ROOT, 'src/runtime'));
      const fake = await startFakeSupabase();
      const sent = [];
      const answers = [];
      const queue = [];
      let updateId = 1000;
      let messageId = 1;
      const telegram = async (method, body) => {
        if (method === 'getUpdates') {
          if (body.offset === -1) return [];
          if (queue.length > 0) return queue.splice(0, queue.length);
          await sleep(25);
          return [];
        }
        if (method === 'sendMessage') { messageId += 1; sent.push({ ...body, messageId }); return { message_id: messageId }; }
        if (method === 'answerCallbackQuery') { answers.push(body); return true; }
        return true;
      };
      const fetchImpl = async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith(fake.url)) return fetch(url, init);
        const tg = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(target);
        if (tg && tg[1] === TELEGRAM_TOKEN) return new Response(JSON.stringify({ ok: true, result: await telegram(tg[2], JSON.parse(init.body)) }), { status: 200, headers: { 'content-type': 'application/json' } });
        throw new Error('no network in this test');
      };
      const app = createApp({ env: { SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: fake.serviceKey, TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN, TELEGRAM_FOUNDER_CHAT_ID: String(FOUNDER), DIGEST_TIME_IST: 'off', AUTOSCALE_EVERY_SECONDS: 'off' }, fetchImpl, version: 'tray-test', skillsDir: path.join(ROOT, '.claude', 'skills'), toolConfigDir: path.join(ROOT, 'config', 'mcp') });
      try {
        await app.start();
        await sleep(100);
        const e = electron();
        const b = background(e);
        b.start();
        e.windows[0].emit('ready-to-show');
        e.windows[0].emit('close', { preventDefault() {} }); // the founder closes the window
        const hidden = e.windows[0].isVisible() === false && e.windows[0].isDestroyed() === false && e.app.quitCalls === 0;

        const card = await app.decisions.create({
          action: { tool: 'namecheap.purchase_domain', access: 'write', args: { domain: 'acme-shoes.example', years: 1 } },
          card: { decide: 'Buy the web address acme-shoes.example for one year?', why_now: 'The new landing page needs its own address.', if_yes: 'The address is bought and the page can use it.', if_no: 'Nothing is bought.', cost: '₹1,000 ($12)', risk: { level: 'Low', reason: 'It is a small yearly cost.' }, recommendation: 'Yes.' },
        });
        const arrived = await (async () => { for (let i = 0; i < 400; i += 1) { if (sent.some((m) => typeof m.text === 'string' && m.text.includes('acme-shoes.example'))) return true; await sleep(25); } return false; })();
        const message = sent.find((m) => typeof m.text === 'string' && m.text.includes('acme-shoes.example'));
        queue.push({ update_id: (updateId += 1), callback_query: { id: 'tap-1', from: { id: FOUNDER }, message: { message_id: message?.messageId ?? 0, chat: { id: FOUNDER } }, data: `d:a:${card.id}` } });
        const resolved = await (async () => { for (let i = 0; i < 400; i += 1) { const [row] = await app.store.select('decisions', { where: { id: card.id }, limit: 1 }); if (row?.status === 'approved') return row; await sleep(25); } return null; })();
        for (let i = 0; i < 200 && answers.length === 0; i += 1) await sleep(25); // the bot's reply to the tap comes a moment after the answer is saved
        const status = await app.runtime.invoke('runtime.status', {});
        return verdict(hidden && arrived && message?.chat_id === FOUNDER && resolved && resolved.status === 'approved' && resolved.resolved_via === 'telegram' && answers.length >= 1 && e.windows[0].isVisible() === false && e.app.quitCalls === 0 && status.ok && status.data.ready === true,
          `window hidden ${hidden}; card reached the phone ${arrived}; decision ${json(resolved && [resolved.status, resolved.resolved_via])}; window still hidden ${e.windows[0].isVisible() === false}; quits ${e.app.quitCalls}; runtime ${json(status.data)}`);
      } finally {
        await app.stop();
        await fake.close();
      }
    },
  },
  {
    id: 'g-main-uses-it-for-the-window-the-quit-and-all-windows-closed-and-the-runtime-still-never-imports-electron',
    check() {
      const main = read('src/main.js');
      const bg = fs.existsSync(path.join(ROOT, 'src/background.js')) ? read('src/background.js') : '';
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
      const offenders = walk(path.join(ROOT, 'src', 'runtime')).filter((f) => /\.(c|m)?jsx?$/.test(f) && /require\(\s*['"]electron['"]\s*\)|from\s+['"]electron['"]/.test(fs.readFileSync(f, 'utf8')));
      const problems = [
        ...(/createBackground\(/.test(main) ? [] : ['main.js does not create the background controller']),
        ...(/background\.start\(\)/.test(main) ? [] : ['main.js does not start it']),
        ...(/background\??\.markQuitting\(\)/.test(main) ? [] : ['main.js does not tell it when the app is quitting']),
        ...(/window-all-closed['"][\s\S]{0,120}background\??\.windowsClosed\(\)/.test(main) ? [] : ['window-all-closed does not go through the controller']),
        ...(/app\.quit\(\)/.test(main.replace(/app\.on\('before-quit'[\s\S]*?\n\}\);/, '')) ? ['main.js quits directly outside the quit handler'] : []),
        ...(/require\(\s*['"]electron['"]\s*\)/.test(bg) ? ['background.js imports electron itself: it must be handed it, so it can be tested'] : []),
        ...(offenders.length > 0 ? [`the runtime imports electron: ${offenders.join(', ')}`] : []),
      ];
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
];

module.exports = {
  name: 'tray-background',
  description: 'The tray and background running (step 4.4): closing the window hides it, the runtime and the Telegram bot keep working, start at login in the installed app',
  threshold: 1.0,
  cases: () => cases,
  async run(c) {
    return c.check();
  },
};
