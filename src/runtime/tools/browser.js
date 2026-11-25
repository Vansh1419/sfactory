'use strict';

// A browser check of a public web page (PLAN.md step 3.3): `browser.check_page`, built on Playwright when it is installed. Graded by the
// `engineering-tools` eval (with a stand-in browser), and by hand with the real one.
//
//   - the tool exists only when it is given a browser driver; `loadPlaywrightDriver()` makes the real one if the `playwright` package (and its browser)
//     is installed, and gives nothing otherwise, so a machine without it simply has no such tool
//   - the page address must be https, with no login in it, no odd port, and a host that is a public address: the host is looked up and every address
//     must be public, and the browser calls the same check for EVERY request the page makes (a page cannot send the browser to a private address).
//     The check happens just before the browser connects, so a name that changes address in between could still get through: keep it to preview pages
//   - the browser gets no permissions, no downloads and no stored login, and is closed after every visit, whatever happens
//   - only plain facts come back: the status, the final address, the title, the first part of the visible text, and the errors the page showed
//   - an error is one plain sentence, never the browser's own text

const dns = require('node:dns/promises');
const { isPublicAddress } = require('./fetch');

const MAX_URL_CHARS = 500;
const VISIT_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 1500;
const MAX_LISTED = 5;
const FAILED = 'The page could not be checked.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Is this address one the browser may visit? https, no login, the standard port, and a host whose every address is public. */
async function allowedAddress(value, lookup = (host) => dns.lookup(host, { all: true })) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  try {
    const found = await lookup(host);
    return Array.isArray(found) && found.length > 0 && found.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
}

/** The real driver, or null when Playwright is not installed. It opens a fresh browser for each visit and closes it. */
function loadPlaywrightDriver({ launch } = {}) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return null;
  }
  return {
    async visit(url, { allow }) {
      const browser = await (launch ?? (() => chromium.launch({ headless: true })))();
      try {
        const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', permissions: [], javaScriptEnabled: true });
        const page = await context.newPage();
        const consoleErrors = [];
        const failedRequests = [];
        await page.route('**/*', async (route) => ((await allow(route.request().url())) ? route.continue() : route.abort('blockedbyclient')));
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
        page.on('pageerror', (e) => consoleErrors.push(String(e?.message ?? e)));
        page.on('requestfailed', (r) => failedRequests.push(r.url()));
        const response = await page.goto(url, { timeout: VISIT_TIMEOUT_MS, waitUntil: 'load' });
        const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
        return { status: response ? response.status() : 0, finalUrl: page.url(), title: await page.title(), text, consoleErrors, failedRequests };
      } finally {
        await browser.close().catch(() => {});
      }
    },
  };
}

function createBrowserTools({ driver, lookup } = {}) {
  if (!driver || typeof driver.visit !== 'function') return [];
  const allow = (value) => allowedAddress(value, lookup);

  return [
    Object.freeze({
      name: 'browser.check_page',
      access: 'read',
      podAccess: 'neutral', // a public page only: nothing of the company or of any pod
      summary: 'Opens a public web page (https only) in a real browser and reports what happened: the status, the title, the start of the visible text, and any errors the page showed. Use it to check a preview of a site.',
      args: `{ "url": the page's https address (up to ${MAX_URL_CHARS} characters) }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => k !== 'url');
        if (extra) return `unknown argument: ${extra}`;
        return typeof args.url === 'string' && args.url.length <= MAX_URL_CHARS && /^https:\/\/[^\s]+$/.test(args.url) ? null : 'url must be an https web address';
      },
      async run({ args }) {
        if (!(await allow(args.url))) throw new Error(FAILED);
        let seen;
        try {
          seen = await driver.visit(args.url, { allow });
        } catch {
          throw new Error(FAILED);
        }
        if (!isObject(seen)) throw new Error(FAILED);
        const list = (items) => (Array.isArray(items) ? items.slice(0, MAX_LISTED).map((i) => `- ${oneLine(i, 200)}`) : []);
        const errors = Array.isArray(seen.consoleErrors) ? seen.consoleErrors : [];
        const failed = Array.isArray(seen.failedRequests) ? seen.failedRequests : [];
        const lines = [
          `Status: ${Number.isInteger(seen.status) ? seen.status : 'unknown'}`,
          `Final address: ${oneLine(seen.finalUrl, 300)}`,
          `Title: ${oneLine(seen.title, 200) || 'none'}`,
          `Errors the page showed: ${errors.length}`,
          ...list(errors),
          `Requests that failed: ${failed.length}`,
          ...list(failed),
          `Visible text (first ${MAX_TEXT_CHARS} characters): ${oneLine(seen.text, MAX_TEXT_CHARS) || 'none'}`,
        ];
        return { text: lines.join('\n') };
      },
    }),
  ];
}

module.exports = { createBrowserTools, loadPlaywrightDriver, allowedAddress };
