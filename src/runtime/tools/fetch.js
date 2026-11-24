'use strict';

// The Fetch tool (PLAN.md step 1.10): read the text of one public web page. Read-only; `fetch.get` has a built-in
// policy rule in policy.js. Graded by the `fetch-tool` eval.
//
// A tool that makes requests for an agent can be turned against the machine it runs on and the network around it (the
// cloud "metadata" address, a router, a database on localhost). So:
//   - only https, the standard port, no password in the address
//   - never a private, loopback, link-local, cloud-metadata or otherwise non-public address, written as a name, as a
//     number in any notation (the URL parser turns 2130706433 and 0x7f000001 into 127.0.0.1 first), as IPv6 including
//     the IPv4-in-IPv6 forms, or reached by a redirect (at most 3, every hop checked again)
//   - the address is ALSO checked when the connection is made (the guarded lookup), so a name that answers with a public
//     address when checked and a private one when connected cannot slip through
//   - text only and cut to a limit; HTML is reduced to its text; the request carries no cookie or credential
//   - an error is one plain sentence: it never shows the system's own text, which can contain addresses

const dns = require('node:dns');
const https = require('node:https');

const MAX_URL_CHARS = 2000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 200_000;
const MAX_TEXT_CHARS = 19_000; // the loader cuts text at 20,000, so the notice below always fits
const SHORTENED_NOTICE = '\n[Shortened: the page is larger than this.]';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const REFUSED = 'Only public https web addresses can be fetched.';
const FAILED = 'That page could not be fetched.';
const NOT_TEXT = 'That page is not text, so it was not read.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- Which addresses are public -----------------------------------------------------------------------

function parseV4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null; // no leading zeros: "010" is ambiguous
    const n = Number(part);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function v4IsPublic([a, b, c]) {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, including the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** Eight 16-bit groups, or null. Understands "::" and a dotted IPv4 tail. */
function parseV6(text) {
  if (text.length > 45 || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  let body = text;
  let tail = [];
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':');
    const v4 = parseV4(text.slice(cut + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    body = text.slice(0, cut + 1); // keeps the colon that comes before the IPv4 part
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (s) => (s === '' ? [] : s.split(':'));
  const left = groupsOf(halves[0]);
  const right = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (![...left, ...right].every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const known = left.length + right.length + tail.length;
  if (halves.length === 2 ? known > 7 : known !== 8) return null;
  const fill = halves.length === 2 ? new Array(8 - known).fill(0) : [];
  return [...left.map((g) => parseInt(g, 16)), ...fill, ...right.map((g) => parseInt(g, 16)), ...tail];
}

const v4FromGroups = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

function v6IsPublic(g) {
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return v4IsPublic(v4FromGroups(g[6], g[7])); // IPv4 inside IPv6
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4IsPublic(v4FromGroups(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return v4IsPublic(v4FromGroups(g[1], g[2])); // 6to4
  if ((g[0] & 0xe000) !== 0x2000) return false; // only global addresses (2000::/3); drops ::, ::1, fe80::, fc00::, ff00::
  if (g[0] === 0x2001 && g[1] < 0x200) return false; // special-purpose, including Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return true;
}

/** True only for an address on the public internet. Anything that is not an address is not public. */
function isPublicAddress(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  if (value.includes(':')) {
    const groups = parseV6(value);
    return groups !== null && v6IsPublic(groups);
  }
  const v4 = parseV4(value);
  return v4 !== null && v4IsPublic(v4);
}

/** A DNS lookup (the shape https.request wants) that refuses any answer that is not entirely public. */
function createGuardedLookup(dnsLookup = dns.lookup) {
  return function guardedLookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const wanted = typeof options === 'object' && options !== null ? options : {};
    dnsLookup(hostname, { ...wanted, all: true }, (err, addresses) => {
      if (err) return done(new Error('The address could not be resolved.'));
      if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every((a) => isPublicAddress(a?.address))) {
        return done(new Error('The address is not public.'));
      }
      return wanted.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family);
    });
  };
}

// ---- Which addresses may be asked for -------------------------------------------------------------------

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

/** { url: URL } for an address that may be fetched, or { problem }. */
function checkUrl(text) {
  if (typeof text !== 'string' || text === '' || text.length > MAX_URL_CHARS || /[\s\u0000-\u001f\u007f]/.test(text)) return { problem: 'url must be one web address with no spaces' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { problem: 'url is not a web address' };
  }
  if (url.protocol !== 'https:') return { problem: 'only https addresses can be fetched' };
  if (url.username !== '' || url.password !== '') return { problem: 'an address with a password in it cannot be fetched' };
  if (url.port !== '') return { problem: 'only the standard https port can be used' };

  const host = url.hostname.replace(/\.$/, '');
  if (host.startsWith('[')) {
    if (!isPublicAddress(host.slice(1, -1))) return { problem: 'that address is not public' };
  } else if (/^[0-9.]+$/.test(host)) {
    if (!isPublicAddress(host)) return { problem: 'that address is not public' };
  } else if (host === 'localhost' || !host.includes('.') || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return { problem: 'that address is not public' };
  }
  return { url };
}

// ---- Turning a page into text ---------------------------------------------------------------------------

const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const BLOCK_END = /<\/?(?:br|p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol)\b[^>]*>/gi;

function decodeEntities(text) {
  const decoded = text
    .replace(/&#(\d{1,7});/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => (parseInt(h, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(h, 16)) : m))
    .replace(/&(lt|gt|quot|apos|nbsp);/g, (_m, name) => NAMED_ENTITIES[name]);
  return decoded.replace(/&amp;/g, '&'); // last, so "&amp;lt;" stays "&lt;" and is not decoded twice
}

function htmlToText(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(stripped)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mimeOf(headers) {
  const raw = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
  return raw.split(';')[0].trim().toLowerCase();
}
const isTextMime = (mime) => mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || /\+(json|xml)$/.test(mime);
const isHtmlMime = (mime) => mime === 'text/html' || mime === 'application/xhtml+xml';

// ---- The real network request ---------------------------------------------------------------------------

/** ONE https request, no redirects, with the guarded lookup. Resolves to { status, headers, bytes } (cut at maxBytes). */
function httpsTransport({ url, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      {
        method: 'GET',
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: 443,
        path: `${target.pathname}${target.search}`,
        lookup: createGuardedLookup(),
        agent: false,
        headers: { 'user-agent': 'sfactory-fetch/1', accept: 'text/*, application/json, application/xml', 'accept-encoding': 'identity' },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        const finish = () => {
          clearTimeout(deadline);
          const headers = {};
          for (const [name, value] of Object.entries(response.headers)) headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
          resolve({ status: response.statusCode, headers, bytes: new Uint8Array(Buffer.concat(chunks).subarray(0, maxBytes)) });
        };
        response.on('data', (chunk) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= maxBytes) {
            response.destroy();
            finish();
          }
        });
        response.on('end', finish);
        response.on('error', finish);
      },
    );
    const deadline = setTimeout(() => request.destroy(new Error('timed out')), timeoutMs);
    request.on('error', (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    request.end();
  });
}

// ---- The tool -------------------------------------------------------------------------------------------

function isReply(reply) {
  return isObject(reply) && Number.isInteger(reply.status) && isObject(reply.headers) && reply.bytes instanceof Uint8Array;
}

async function getPage(startUrl, transport) {
  let current = startUrl;
  const seen = new Set();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    seen.add(current.href);
    let reply;
    try {
      reply = await transport({ url: current.href, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    } catch {
      throw new Error(FAILED);
    }
    if (!isReply(reply)) throw new Error(FAILED);

    if (REDIRECT_STATUSES.has(reply.status)) {
      const location = reply.headers.location;
      if (typeof location !== 'string' || location === '') throw new Error(FAILED);
      let next;
      try {
        next = checkUrl(new URL(location, current).href);
      } catch {
        throw new Error(REFUSED);
      }
      if (next.problem || seen.has(next.url.href)) throw new Error(REFUSED);
      current = next.url;
      continue;
    }

    if (reply.status < 200 || reply.status > 299) throw new Error(FAILED);
    const mime = mimeOf(reply.headers);
    if (!isTextMime(mime)) throw new Error(NOT_TEXT);

    const cutBytes = reply.bytes.length >= MAX_BYTES;
    const raw = new TextDecoder('utf-8').decode(reply.bytes.subarray(0, MAX_BYTES));
    const text = isHtmlMime(mime) ? htmlToText(raw) : raw;
    return cutBytes || text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}${SHORTENED_NOTICE}` : text;
  }
  throw new Error(REFUSED); // too many redirects
}

/** The Fetch tool. `transport` is for tests; the real one is used otherwise. */
function createFetchTools({ transport = httpsTransport } = {}) {
  return [
    Object.freeze({
      name: 'fetch.get',
      access: 'read',
      summary: 'Reads the text of one public web page (https only) and gives it back. Private and internal addresses are refused.',
      args: '{ "url": the full https address of the page, for example "https://example.com/about" }',
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => k !== 'url');
        if (extra) return `unknown argument: ${extra}`;
        return checkUrl(args.url).problem ?? null;
      },
      async run({ args }) {
        const checked = checkUrl(args.url);
        if (checked.problem) throw new Error(REFUSED);
        return { text: await getPage(checked.url, transport) };
      },
    }),
  ];
}

module.exports = { createFetchTools, isPublicAddress, createGuardedLookup };
