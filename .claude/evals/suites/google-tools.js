'use strict';

// Grades the Gmail and Drive tools (PLAN.md step 2.3: "Gmail and Drive"; the founder chose "drafts only, no send yet"):
//   src/runtime/tools/google.js   createGoogleTools({ clientId, clientSecret, refreshToken, fetchImpl, now }) ->
//     [gmail.search, gmail.create_draft, drive.list_files, drive.save_file]
//
//   - without all three settings there are no tools; the read tools are tagged read and the others write, each with a built-in rule
//   - the access token is fetched from Google's token address with the refresh token, kept until it is about to end, and sent in
//     ONE header; requests go only to Google's own three addresses and a redirect is never followed
//   - NOTHING SENDS MAIL: no call ever goes to a send address, and the source has no send call at all. A draft is checked like any
//     client email first (one address, one-line subject, no key, no [placeholders]) and only fills the Drafts folder
//   - a file name is plain, text is cut to a limit, and a search word with quotes cannot break out of the Drive query
//   - an error is one plain sentence: never a token, Google's own message or the system's error text

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/tools/google.js';
const LOADER = 'src/runtime/tools/index.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const CLIENT_ID = 'client-id-123.apps.example';
const CLIENT_SECRET = 'GOCSPX-client-secret-ABCDEFGH';
const REFRESH = '1//refresh-token-ABCDEFGHIJKLMNOP';
const ACCESS = 'ya29.access-token-ABCDEFGHIJKLMNOP';
const ALL_SECRETS = [CLIENT_SECRET, REFRESH, ACCESS];
const HOSTS = ['oauth2.googleapis.com', 'gmail.googleapis.com', 'www.googleapis.com'];

/** A Google stand-in. `answer(url, init)` returns the JSON body for a non-token request (or an Error / { ok: false }). */
function fakeGoogle(answer = () => ({})) {
  const calls = [];
  let tokens = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    let r;
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      tokens += 1;
      r = typeof answer.token === 'function' ? answer.token() : { access_token: ACCESS, expires_in: 3600 };
    } else {
      r = answer(String(url), init);
    }
    if (r instanceof Error) throw r;
    if (r && r.ok === false) return { ok: false, status: r.status ?? 400, text: async () => String(r.body ?? '') };
    return { ok: true, status: 200, text: async () => (typeof r === 'string' ? r : JSON.stringify(r)) };
  };
  return { calls, fetchImpl, get tokens() { return tokens; } };
}

function toolsFor(net, over = {}) {
  return loadSubject(SUBJECT).createGoogleTools({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH, fetchImpl: net.fetchImpl, ...over });
}
async function use(net, tool, access, args, over) {
  const loader = loadSubject(LOADER).createToolLoader({ tools: toolsFor(net, over), hasRule: async () => true });
  await loader.load();
  try {
    const out = await loader.run({ action: { tool, access, args }, key: 'k' });
    return { ok: true, text: out.text };
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return { ok: false, message: err.message };
  }
}

const GOOD_MAIL = { to: 'ann@acme.example', subject: 'Your proposal', body: 'Hello Ann,\n\nHere is the proposal we discussed. Please tell me if you have questions.\n\nBest wishes,\nsfactory' };

const cases = [
  {
    id: 'there-are-four-tools-with-the-right-tags-and-policy-rules-and-none-unless-all-three-settings-are-given',
    check() {
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const net = fakeGoogle();
      const tools = toolsFor(net);
      const tags = Object.fromEntries(tools.map((t) => [t.name, t.access]));
      const want = { 'gmail.search': 'read', 'gmail.create_draft': 'write', 'drive.list_files': 'read', 'drive.save_file': 'write' };
      const lib = loadSubject(SUBJECT);
      const missing = [{ clientId: '' }, { clientSecret: undefined }, { refreshToken: '  ' }, { clientId: 5 }].map((over) => toolsFor(net, over).length);
      const bare = lib.createGoogleTools().length;
      const ruled = Object.entries(want).every(([name, access]) => policy.isBuiltIn(name) && policy.checkAction({ tool: name, access, args: {} }).allowed === true);
      return verdict(json(tags) === json(want) && missing.every((n) => n === 0) && bare === 0 && ruled && tools.every((t) => t.summary.length > 10 && t.args.length > 10), json({ tags, missing, bare, ruled }));
    },
  },
  {
    id: 'the-token-is-fetched-with-the-refresh-token-kept-until-it-is-about-to-end-and-then-fetched-again',
    async check() {
      let clock = 1_000_000;
      const over = { now: () => clock };
      const net = fakeGoogle(() => ({ files: [] }));
      const [, , list] = toolsFor(net, over);
      await list.run({ args: {} });
      await list.run({ args: {} });
      const cachedTokens = net.tokens;
      clock += 3_600_000 - 30_000; // inside the one-minute margin before the token ends
      await list.run({ args: {} });
      const t = net.calls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/token'));
      const form = new URLSearchParams(String(t.init.body));
      return verdict(cachedTokens === 1 && net.tokens === 2 && t.init.method === 'POST' && form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === REFRESH && form.get('client_id') === CLIENT_ID && form.get('client_secret') === CLIENT_SECRET, json({ cachedTokens, now: net.tokens, form: [...form.keys()] }));
    },
  },
  {
    id: 'every-request-goes-to-one-of-googles-three-addresses-with-the-token-in-one-header-and-no-redirects',
    async check() {
      const net = fakeGoogle((url) => (url.includes('/messages?') ? { messages: [{ id: 'm1' }] } : url.includes('/messages/m1') ? { snippet: 's', payload: { headers: [] } } : url.includes('/drafts') || url.includes('/upload/') ? { id: 'd1' } : { files: [] }));
      await use(net, 'gmail.search', 'read', { query: 'from:ann' });
      await use(net, 'gmail.create_draft', 'write', GOOD_MAIL);
      await use(net, 'drive.list_files', 'read', { name: 'proposal' });
      await use(net, 'drive.save_file', 'write', { name: 'Acme proposal.txt', content: 'Text.' });
      const apiCalls = net.calls.filter((c) => !c.url.startsWith('https://oauth2.googleapis.com/token'));
      const okHost = net.calls.every((c) => HOSTS.includes(new URL(c.url).host) && new URL(c.url).protocol === 'https:');
      const headers = apiCalls.every((c) => c.init.headers.Authorization === `Bearer ${ACCESS}` && c.init.redirect === 'manual');
      const noSecretInUrl = net.calls.every((c) => ALL_SECRETS.every((s) => !c.url.includes(s)));
      return verdict(apiCalls.length >= 5 && okHost && headers && noSecretInUrl, json({ n: apiCalls.length, hosts: [...new Set(net.calls.map((c) => new URL(c.url).host))], okHost, headers, noSecretInUrl }));
    },
  },
  {
    id: 'gmail-search-lists-then-reads-each-message-header-and-gives-one-plain-line-per-message',
    async check() {
      const net = fakeGoogle((url) => {
        if (url.includes('/messages?')) return { messages: [{ id: 'm1' }, { id: '../evil' }, { id: 'm2' }] };
        if (url.includes('/messages/m1')) return { snippet: 'Hello\nthere', payload: { headers: [{ name: 'From', value: 'Ann <ann@acme.example>' }, { name: 'Subject', value: 'Quote' }, { name: 'Date', value: 'Mon, 24 Nov 2026' }] } };
        return { snippet: 'second', payload: { headers: [] } };
      });
      const r = await use(net, 'gmail.search', 'read', { query: 'from:ann', count: 3 });
      const lines = (r.text ?? '').split('\n');
      const list = net.calls.find((c) => c.url.includes('/messages?'));
      const empty = await use(fakeGoogle(() => ({})), 'gmail.search', 'read', { query: 'nothing' });
      return verdict(r.ok && lines.length === 2 && lines[0] === 'Mon, 24 Nov 2026 | Ann <ann@acme.example> | Quote | Hello there' && new URL(list.url).searchParams.get('q') === 'from:ann' && new URL(list.url).searchParams.get('maxResults') === '3' && !net.calls.some((c) => c.url.includes('evil')) && empty.text === 'No messages found.', json({ r, list: list.url, empty }));
    },
  },
  {
    id: 'a-draft-is-made-in-the-drafts-folder-from-the-checked-message-and-is-never-sent',
    async check() {
      const net = fakeGoogle((url) => (url.includes('/drafts') ? { id: 'd1' } : {}));
      const r = await use(net, 'gmail.create_draft', 'write', GOOD_MAIL);
      const call = net.calls.find((c) => c.url.includes('/drafts'));
      const raw = Buffer.from(JSON.parse(call.init.body).message.raw, 'base64url').toString('utf8');
      const [head, bodyPart] = raw.split('\r\n\r\n');
      const subject = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(head)?.[1];
      const body = Buffer.from(bodyPart.replace(/\s/g, ''), 'base64').toString('utf8');
      const sendCalls = net.calls.filter((c) => /send/i.test(new URL(c.url).pathname));
      return verdict(r.ok && /not been sent/i.test(r.text) && call.init.method === 'POST' && new URL(call.url).pathname === '/gmail/v1/users/me/drafts' && /^To: ann@acme\.example$/m.test(head) && Buffer.from(subject, 'base64').toString('utf8') === GOOD_MAIL.subject && body === GOOD_MAIL.body && sendCalls.length === 0, json({ r, head, calls: net.calls.map((c) => c.url) }));
    },
  },
  {
    id: 'a-draft-that-would-be-refused-as-a-client-email-is-refused-and-causes-no-request',
    async check() {
      const bad = [{ to: 'a@x.co, b@x.co' }, { to: 'nope' }, { subject: 'Hi\r\nBcc: x@y.co' }, { subject: '' }, { body: `key ${REFRESH} sb_secret_ABCDEFGHIJKLMNOP` }, { body: 'Dear [Name], hello' }, { body: '' }, { extra: 1 }];
      for (const over of bad) {
        const net = fakeGoogle();
        const r = await use(net, 'gmail.create_draft', 'write', { ...GOOD_MAIL, ...over });
        if (r.ok || net.calls.length !== 0) return verdict(false, `${json(over)} -> ${json(r)} calls ${net.calls.length}`);
      }
      for (const args of [{}, null, 'x', { to: 5, subject: 's', body: 'b' }]) {
        const net = fakeGoogle();
        const r = await use(net, 'gmail.create_draft', 'write', args);
        if (r.ok || net.calls.length !== 0) return verdict(false, `${json(args)} accepted`);
      }
      return verdict(true);
    },
  },
  {
    id: 'nothing-in-the-source-can-send-mail',
    check() {
      const source = fs.readFileSync(path.join(ROOT, SUBJECT), 'utf8');
      const sendish = source.match(/(messages|drafts)\/send|[:/]send\b|\.send\(|sendMessage|sendmail|nodemailer|smtp/gi) ?? [];
      return verdict(sendish.length === 0, json(sendish));
    },
  },
  {
    id: 'drive-list-escapes-quotes-in-the-search-word-and-shows-name-id-and-time',
    async check() {
      const net = fakeGoogle(() => ({ files: [{ id: 'f1', name: 'Acme proposal.txt', modifiedTime: '2026-11-25T10:00:00Z' }, { id: 'f2', name: 'Other\nfile', modifiedTime: '2026-11-24T10:00:00Z' }] }));
      const r = await use(net, 'drive.list_files', 'read', { name: "x' or name contains '", count: 2 });
      const call = net.calls.find((c) => c.url.startsWith('https://www.googleapis.com/drive/v3/files?'));
      const q = new URL(call.url).searchParams.get('q');
      const plain = await use(fakeGoogle(() => ({ files: [] })), 'drive.list_files', 'read', {});
      return verdict(r.ok && q === "trashed = false and name contains 'x\\' or name contains \\''" && r.text.split('\n')[0] === 'Acme proposal.txt | f1 | 2026-11-25T10:00:00Z' && r.text.split('\n').length === 2 && plain.text === 'No files found.', json({ q, r, plain }));
    },
  },
  {
    id: 'drive-save-sends-one-private-multipart-upload-with-a-plain-name-and-the-text',
    async check() {
      const net = fakeGoogle(() => ({ id: 'file1' }));
      const content = 'Proposal for Acme.\n"Quotes" and ünïcode are fine.';
      const r = await use(net, 'drive.save_file', 'write', { name: 'Acme proposal (v1).txt', content });
      const call = net.calls.find((c) => c.url.includes('/upload/'));
      const boundary = /boundary=(\S+)/.exec(call.init.headers['Content-Type'])?.[1];
      const parts = String(call.init.body).split(`--${boundary}`);
      return verdict(r.ok && /Saved "Acme proposal \(v1\)\.txt"/.test(r.text) && call.init.method === 'POST' && /^multipart\/related; boundary=\S+$/.test(call.init.headers['Content-Type']) && new URL(call.url).searchParams.get('uploadType') === 'multipart' && parts.length === 4 && JSON.parse(parts[1].split('\r\n\r\n')[1]).name === 'Acme proposal (v1).txt' && parts[2].split('\r\n\r\n')[1].replace(/\r\n$/, '') === content && !String(call.init.body).includes('permissions') && !call.url.includes('share'), json({ r, call: call.url, parts: parts.length }));
    },
  },
  {
    id: 'a-bad-file-name-or-text-or-search-is-refused-and-causes-no-request',
    async check() {
      const bad = [
        ['drive.save_file', 'write', { name: '../secret.txt', content: 'x' }], ['drive.save_file', 'write', { name: 'a/b.txt', content: 'x' }], ['drive.save_file', 'write', { name: '.env', content: 'x' }],
        ['drive.save_file', 'write', { name: 'a\\b.txt', content: 'x' }], ['drive.save_file', 'write', { name: '', content: 'x' }], ['drive.save_file', 'write', { name: 'ok.txt', content: '' }],
        ['drive.save_file', 'write', { name: 'ok.txt', content: 'x'.repeat(100_001) }], ['drive.save_file', 'write', { name: 'ok.txt', content: 'x', share: 'anyone' }], ['drive.save_file', 'write', { name: 5, content: 'x' }],
        ['drive.list_files', 'read', { count: 0 }], ['drive.list_files', 'read', { count: 11 }], ['drive.list_files', 'read', { name: 'a\nb' }], ['drive.list_files', 'read', { q: 'x' }],
        ['gmail.search', 'read', {}], ['gmail.search', 'read', { query: '' }], ['gmail.search', 'read', { query: 'x'.repeat(201) }], ['gmail.search', 'read', { query: 'ok', count: 99 }], ['gmail.search', 'read', { query: 'ok', userId: 'someone' }],
      ];
      for (const [tool, access, args] of bad) {
        const net = fakeGoogle();
        const r = await use(net, tool, access, args);
        if (r.ok || net.calls.length !== 0) return verdict(false, `${tool} ${json(args).slice(0, 80)} -> ${json(r)} calls ${net.calls.length}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'a-failure-is-one-plain-sentence-that-never-shows-a-token-googles-text-or-the-systems-text',
    async check() {
      const leaky = `denied ${ACCESS} ${REFRESH} ${CLIENT_SECRET} at https://internal.example/x`;
      const scenarios = [
        { label: 'token refused', answer: Object.assign(() => ({ files: [] }), { token: () => ({ ok: false, status: 400, body: leaky }) }) },
        { label: 'token reply without a token', answer: Object.assign(() => ({ files: [] }), { token: () => ({ nothing: 1 }) }) },
        { label: 'api refused', answer: () => ({ ok: false, status: 403, body: leaky }) },
        { label: 'network down', answer: () => new Error(`connect ECONNREFUSED 10.0.0.5 ${leaky}`) },
        { label: 'not json', answer: () => 'not json at all' },
      ];
      for (const s of scenarios) {
        const net = fakeGoogle(s.answer);
        const [, , list] = toolsFor(net);
        const direct = await list.run({ args: {} }).then(() => 'no error', (err) => err.message);
        const through = await use(fakeGoogle(s.answer), 'drive.list_files', 'read', {});
        const shown = `${direct} ${through.message}`;
        if (direct !== 'Google did not accept that request.' || through.ok || ALL_SECRETS.some((x) => shown.includes(x)) || /internal\.example|ECONN/.test(shown)) return verdict(false, `${s.label}: ${shown}`);
      }
      return verdict(true);
    },
  },
];

module.exports = {
  name: 'google-tools',
  description: 'Gmail and Drive tools: read mail, make drafts (never send), list and save files; fixed Google addresses, token in one header, checked drafts, plain errors',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
