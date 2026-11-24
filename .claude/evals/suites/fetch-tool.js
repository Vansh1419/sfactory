'use strict';

// Grades the Fetch tool (PLAN.md step 1.10: "Fetch"):
//   src/runtime/tools/fetch.js
//     createFetchTools({ transport? }) -> [fetch.get]           (the loader's tool shape; read-only)
//     isPublicAddress(ip) -> boolean                              true only for an address on the public internet
//     createGuardedLookup(dnsLookup) -> lookup                    a DNS lookup that refuses non-public answers
//
//   fetch.get { url } -> { text }   the text of one public web page
//
// `transport({ url, timeoutMs, maxBytes })` makes ONE request (no redirects) and resolves to
// { status, headers: { lower-case name: value }, bytes: Uint8Array }. The default one uses node:https with the guarded
// lookup, so the address is checked at the moment of connecting (a name that changes its answer between a check and
// the connection cannot slip through). The cases here use a fake transport, so nothing touches the network; the real
// one was run by hand against example.com and against localhost (see EVALS.md).
//
// What the tool promises (each is a case below):
//   - only https, standard port, no passwords in the address
//   - never a private, loopback, link-local, cloud-metadata or otherwise non-public address, written as a name, as a
//     number in any notation, as IPv6 (including the IPv4-in-IPv6 forms), or reached by a redirect
//   - redirects are followed at most 3 times and every hop is checked again
//   - text only, cut to a limit; HTML is reduced to its text
//   - the request carries no cookie or credential; nothing in an error shows the system's own text

const { loadSubject, ROOT } = require('../lib');
const path = require('node:path');

const SUBJECT = 'src/runtime/tools/fetch.js';
const LOADER = 'src/runtime/tools/index.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const SECRET = 'sb_secret_ABCDEFGHIJKLMNOP';
const enc = (s) => new TextEncoder().encode(s);

const page = (over = {}) => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, bytes: enc('hello'), ...over });

/** A fake transport that answers from a table of url -> response and records every call. */
function fakeTransport(table = {}, fallback = () => page()) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    const answer = table[request.url];
    if (typeof answer === 'function') return answer(request);
    return answer ?? fallback(request);
  };
  transport.calls = calls;
  return transport;
}

const tool = (transport) => loadSubject(SUBJECT).createFetchTools({ transport })[0];

async function viaLoader(transport, url) {
  const loader = loadSubject(LOADER).createToolLoader({ tools: loadSubject(SUBJECT).createFetchTools({ transport }), hasRule: async () => true });
  await loader.load();
  try {
    const out = await loader.run({ action: { tool: 'fetch.get', access: 'read', args: { url } }, key: 'k' });
    return { ok: true, text: out.text };
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return { ok: false, message: err.message };
  }
}

async function direct(transport, url) {
  try {
    return { ok: true, ...(await tool(transport).run({ args: { url }, key: 'k' })) };
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return { ok: false, message: err.message, stack: String(err.stack) };
  }
}

const BLOCKED_URLS = [
  'https://localhost/', 'https://LOCALHOST/', 'https://foo.localhost/', 'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/', 'https://0.0.0.0/',
  'https://[::1]/', 'https://[::]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[0:0:0:0:0:ffff:a00:1]/', 'https://[fe80::1]/', 'https://[fd00::1]/', 'https://[fc00::1]/', 'https://[2002:7f00:1::]/', 'https://[64:ff9b::7f00:1]/',
  'https://10.0.0.1/', 'https://10.255.255.255/', 'https://172.16.0.1/', 'https://172.31.255.255/', 'https://192.168.1.1/', 'https://169.254.169.254/latest/meta-data/', 'https://169.254.0.1/', 'https://100.64.0.1/', 'https://198.18.0.1/', 'https://192.0.2.1/', 'https://224.0.0.1/', 'https://255.255.255.255/',
  'https://intranet/', 'https://printer.local/', 'https://db.internal/', 'https://metadata.google.internal/', 'https://router.home.arpa/', 'https://a.b.localhost/',
];
const ALLOWED_URLS = ['https://example.com/', 'https://example.com/a/b?c=d#e', 'https://sub.example.co.in/page', 'https://93.184.216.34/', 'https://8.8.8.8/', 'https://[2606:2800:220:1:248:1893:25c8:1946]/', 'https://example.com:443/'];

const cases = [
  {
    id: 'the-tool-is-read-only-with-a-summary-and-a-policy-rule',
    check() {
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const tools = loadSubject(SUBJECT).createFetchTools({ transport: fakeTransport() });
      const t = tools[0];
      return verdict(tools.length === 1 && t.name === 'fetch.get' && t.access === 'read' && t.summary.length > 10 && t.args.includes('url') && policy.isBuiltIn('fetch.get') && policy.checkAction({ tool: 'fetch.get', access: 'read', args: { url: 'https://example.com' } }).allowed === true, json(t && t.name));
    },
  },
  {
    id: 'arguments-must-be-one-https-address-with-no-password-and-the-standard-port',
    check() {
      const t = tool(fakeTransport());
      const good = ALLOWED_URLS.map((u) => t.checkArgs({ url: u }));
      const bad = [{}, { url: '' }, { url: '   ' }, { url: 5 }, { url: null }, { url: ['https://example.com'] }, { url: 'example.com' }, { url: '//example.com' }, { url: 'http://example.com' }, { url: 'ftp://example.com' }, { url: 'file:///etc/passwd' }, { url: 'data:text/plain,hi' }, { url: 'javascript:alert(1)' }, { url: 'https://user:pass@example.com/' }, { url: 'https://user@example.com/' }, { url: 'https://example.com:8443/' }, { url: 'https://example.com:80/' }, { url: 'https://exa mple.com/' }, { url: `https://example.com/${'a'.repeat(2100)}` }, { url: 'https://example.com', extra: 1 }, null, 'https://example.com', ['x']].map((a) => t.checkArgs(a));
      return verdict(good.every((g) => g === null) && bad.every((p) => typeof p === 'string' && p.length > 0), json({ good, bad }));
    },
  },
  {
    id: 'private-loopback-and-internal-addresses-are-refused-before-any-request',
    async check() {
      for (const url of BLOCKED_URLS) {
        const transport = fakeTransport();
        const r = await direct(transport, url);
        if (r.ok || transport.calls.length > 0) return verdict(false, `${url} -> ok ${r.ok}, calls ${transport.calls.length}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'public-addresses-are-fetched',
    async check() {
      for (const url of ALLOWED_URLS) {
        const transport = fakeTransport();
        const r = await direct(transport, url);
        if (!r.ok || r.text !== 'hello' || transport.calls.length !== 1) return verdict(false, `${url} -> ${json(r)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'the-address-check-is-right-for-every-kind-of-address',
    check() {
      const { isPublicAddress } = loadSubject(SUBJECT);
      const no = ['0.0.0.0', '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.20.1.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255', '192.0.0.1', '192.0.2.5', '198.51.100.5', '203.0.113.5', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'febf::1', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1', '2002:7f00:1::', '2002:0a00:0001::', '2001:db8::1', '2001:0:1::1', '2001::1', 'not an address', '', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4'];
      const yes = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.255', '2606:2800:220:1:248:1893:25c8:1946', '2a00:1450:4009:81f::200e', '::ffff:8.8.8.8', '::ffff:808:808', '2002:0808:0808::'];
      const wrongNo = no.filter((a) => isPublicAddress(a));
      const wrongYes = yes.filter((a) => !isPublicAddress(a));
      return verdict(wrongNo.length === 0 && wrongYes.length === 0, json({ wrongNo, wrongYes }));
    },
  },
  {
    id: 'the-address-check-never-throws-on-odd-input',
    check() {
      const { isPublicAddress } = loadSubject(SUBJECT);
      for (const v of [undefined, null, 5, {}, [], true, 'a'.repeat(5000), '\u0000', '::ffff:']) {
        try {
          if (isPublicAddress(v) !== false) return verdict(false, `public for ${json(v)}`);
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return verdict(false, `threw on ${json(v)}`);
        }
      }
      return verdict(true);
    },
  },
  {
    id: 'the-guarded-lookup-only-answers-with-public-addresses',
    async check() {
      const { createGuardedLookup } = loadSubject(SUBJECT);
      const dns = (answer) => (_host, _opts, cb) => (answer instanceof Error ? cb(answer) : cb(null, answer));
      const run = (answer, options = {}) => new Promise((resolve) => createGuardedLookup(dns(answer))('example.com', options, (err, address, family) => resolve({ err: err ? String(err.message) : null, address, family })));
      const publicOne = await run([{ address: '93.184.216.34', family: 4 }]);
      const publicAll = await run([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }], { all: true });
      const privateOne = await run([{ address: '127.0.0.1', family: 4 }]);
      const mixed = await run([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
      const mixedAll = await run([{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }], { all: true });
      const none = await run([]);
      const failed = await run(Object.assign(new Error(`getaddrinfo ENOTFOUND ${SECRET}`), { code: 'ENOTFOUND' }));
      const ok = publicOne.err === null && publicOne.address === '93.184.216.34' && publicOne.family === 4
        && publicAll.err === null && Array.isArray(publicAll.address) && publicAll.address.length === 2
        && privateOne.err && mixed.err && mixedAll.err && none.err && failed.err && !failed.err.includes(SECRET) && !failed.err.includes('ENOTFOUND');
      return verdict(ok, json({ publicOne, publicAll, privateOne, mixed, mixedAll, none, failed }));
    },
  },
  {
    id: 'text-is-returned-exactly-and-the-request-carries-no-cookie-or-credential',
    async check() {
      const body = 'Line one\n\tindented\nLine three — ₹500\n';
      const transport = fakeTransport({}, () => page({ bytes: enc(body) }));
      const r = await direct(transport, 'https://example.com/notes.txt');
      const sent = json(transport.calls[0]);
      return verdict(r.ok && r.text === body && transport.calls[0].url === 'https://example.com/notes.txt' && !/cookie|authorization|token|bearer/i.test(sent) && transport.calls[0].maxBytes > 1000 && transport.calls[0].timeoutMs > 0, json({ r, sent }));
    },
  },
  {
    id: 'json-and-xml-are-text-too-and-html-is-reduced-to-its-text',
    async check() {
      const j = await direct(fakeTransport({}, () => page({ headers: { 'content-type': 'application/json' }, bytes: enc('{"a":1}') })), 'https://example.com/a.json');
      const x = await direct(fakeTransport({}, () => page({ headers: { 'content-type': 'application/atom+xml; charset=utf-8' }, bytes: enc('<feed/>') })), 'https://example.com/feed');
      const html = '<html><head><title>T</title><style>p{color:red}</style><script>alert("x")</script></head><body><h1>Hello &amp; welcome</h1><p>Price: &#8377;500 &lt;ok&gt;</p><!-- hidden --><br>Line<script src="x.js"></script></body></html>';
      const h = await direct(fakeTransport({}, () => page({ headers: { 'content-type': 'text/html; charset=utf-8' }, bytes: enc(html) })), 'https://example.com/');
      const ok = j.ok && j.text === '{"a":1}' && x.ok && x.text === '<feed/>' && h.ok && h.text.includes('Hello & welcome') && h.text.includes('Price: ₹500 <ok>') && h.text.includes('Line')
        && !/alert|color:red|<h1>|<script|hidden|<\/?p>/.test(h.text);
      return verdict(ok, json({ j, x, h }));
    },
  },
  {
    id: 'anything-that-is-not-text-is-refused',
    async check() {
      for (const type of ['image/png', 'application/octet-stream', 'application/pdf', 'application/zip', 'video/mp4', 'application/x-msdownload', '']) {
        const r = await direct(fakeTransport({}, () => page({ headers: type === '' ? {} : { 'content-type': type } })), 'https://example.com/x');
        if (r.ok) return verdict(false, `read ${json(type)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'a-large-page-is-cut-and-says-so',
    async check() {
      const transport = fakeTransport({}, () => page({ bytes: enc(`START${'x'.repeat(500_000)}`) }));
      const r = await direct(transport, 'https://example.com/big');
      const loader = await viaLoader(transport, 'https://example.com/big');
      return verdict(r.ok && r.text.startsWith('START') && r.text.length < 20_000 && /cut|shortened|larger/i.test(r.text.slice(-200)) && loader.ok && loader.text.length <= 20_000, `length ${r.text && r.text.length}`);
    },
  },
  {
    id: 'a-redirect-is-followed-and-checked-again-at-every-step',
    async check() {
      const transport = fakeTransport({
        'https://example.com/a': { status: 301, headers: { location: '/b' }, bytes: enc('') },
        'https://example.com/b': { status: 302, headers: { location: 'https://other.example.org/c' }, bytes: enc('') },
        'https://other.example.org/c': page({ bytes: enc('final') }),
      });
      const r = await direct(transport, 'https://example.com/a');
      return verdict(r.ok && r.text === 'final' && transport.calls.map((c) => c.url).join() === 'https://example.com/a,https://example.com/b,https://other.example.org/c', json({ r, calls: transport.calls.map((c) => c.url) }));
    },
  },
  {
    id: 'a-redirect-to-a-private-address-or-a-plain-http-address-is-never-followed',
    async check() {
      const targets = ['http://example.com/', 'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/', 'https://localhost/admin', 'https://[::1]/', 'file:///etc/passwd', 'ftp://example.com/', 'https://user:pw@example.com/', 'https://example.com:8443/', '//127.0.0.1/', 'javascript:alert(1)'];
      for (const location of targets) {
        const transport = fakeTransport({ 'https://example.com/start': { status: 302, headers: { location }, bytes: enc('') } });
        const r = await direct(transport, 'https://example.com/start');
        if (r.ok || transport.calls.length !== 1) return verdict(false, `${location} -> ok ${r.ok}, calls ${transport.calls.map((c) => c.url)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'too-many-redirects-a-loop-or-a-redirect-with-no-place-to-go-is-refused',
    async check() {
      const chain = {};
      for (let i = 0; i < 6; i += 1) chain[`https://example.com/r${i}`] = { status: 302, headers: { location: `/r${i + 1}` }, bytes: enc('') };
      const long = fakeTransport(chain);
      const a = await direct(long, 'https://example.com/r0');
      const loopT = fakeTransport({ 'https://example.com/x': { status: 302, headers: { location: '/x' }, bytes: enc('') } });
      const b = await direct(loopT, 'https://example.com/x');
      const c = await direct(fakeTransport({ 'https://example.com/n': { status: 302, headers: {}, bytes: enc('') } }), 'https://example.com/n');
      const three = fakeTransport({
        'https://example.com/1': { status: 302, headers: { location: '/2' }, bytes: enc('') },
        'https://example.com/2': { status: 302, headers: { location: '/3' }, bytes: enc('') },
        'https://example.com/3': { status: 302, headers: { location: '/4' }, bytes: enc('') },
        'https://example.com/4': page({ bytes: enc('four') }),
      });
      const d = await direct(three, 'https://example.com/1');
      return verdict(a.ok === false && long.calls.length <= 4 && b.ok === false && loopT.calls.length <= 4 && c.ok === false && d.ok && d.text === 'four', json({ a: a.ok, aCalls: long.calls.length, b: b.ok, bCalls: loopT.calls.length, c: c.ok, d }));
    },
  },
  {
    id: 'an-error-status-is-a-failure-with-a-plain-message',
    async check() {
      for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
        const r = await direct(fakeTransport({}, () => page({ status, bytes: enc(`error ${SECRET}`) })), 'https://example.com/x');
        if (r.ok || r.message.includes(SECRET)) return verdict(false, `status ${status}: ${json(r)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'a-failing-request-never-shows-the-systems-own-error-text',
    async check() {
      const failures = [new Error(`connect ECONNREFUSED 10.0.0.5:443 ${SECRET}`), Object.assign(new Error('getaddrinfo ENOTFOUND internal.example'), { code: 'ENOTFOUND' }), new Error('certificate has expired'), 'a string', null, undefined];
      for (const failure of failures) {
        const r = await direct(async () => { throw failure; }, 'https://example.com/x');
        const shown = `${r.message}\n${r.stack}`;
        if (r.ok || !r.message || /ECONN|ENOTFOUND|certificate|10\.0\.0\.5|internal\.example/i.test(shown) || shown.includes(SECRET)) return verdict(false, `leaked: ${shown.slice(0, 200)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'a-reply-that-is-not-a-reply-is-refused-without-throwing-anything-odd',
    async check() {
      for (const reply of [undefined, null, 5, 'x', {}, { status: 'ok' }, { status: 200 }, { status: 200, headers: {} }, { status: 200, headers: { 'content-type': 'text/plain' }, bytes: 'text' }, { status: 200, headers: { 'content-type': 'text/plain' }, bytes: null }]) {
        const r = await direct(async () => reply, 'https://example.com/x');
        if (r.ok) return verdict(false, `accepted ${json(reply)}`);
      }
      return verdict(true);
    },
  },
];

module.exports = {
  name: 'fetch-tool',
  description: 'Fetch tool: https only, never a private/loopback/metadata address in any notation or through a redirect, address checked at connect time, text only and cut, no credentials, no system error text',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
