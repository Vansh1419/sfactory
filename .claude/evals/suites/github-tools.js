'use strict';

// Grades the GitHub tools (PLAN.md step 1.10: "GitHub"):
//   src/runtime/tools/github.js   createGitHubTools({ token, repos, fetchImpl? }) -> [tool, tool, tool, tool]
//
//   github.read_file           { repo, path, ref? }                     read   -> { text }
//   github.list_pull_requests  { repo, state? }                         read   -> { text }
//   github.create_pull_request { repo, title, head, base, body? }       write  -> { text }   routine (ships nothing)
//   github.merge_pull_request  { repo, number }                         write  -> { text }   ALWAYS asks the founder
//
// `repo` is "owner/name" and must be one of the repositories the founder named in GITHUB_REPOS; with no token or no
// repositories there are no tools. All requests go to https://api.github.com/repos/<that repository>/ and carry the token
// in one header; the token never appears in a result or an error. Nothing is sent for an argument that is refused.

const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/tools/github.js';
const LOADER = 'src/runtime/tools/index.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);

const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const REPO = 'acme/site';
const OTHER = 'acme/secret-repo';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/** A fake of fetch that answers from `reply(call)` and records every call. */
function fakeFetch(reply = () => ({ status: 200, body: {} })) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body), redirect: init.redirect };
    calls.push(call);
    const r = await reply(call);
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

const make = (fetchImpl, over = {}) => loadSubject(SUBJECT).createGitHubTools({ token: TOKEN, repos: [REPO], fetchImpl, ...over });

async function run(fetchImpl, name, args, over) {
  const tools = make(fetchImpl, over);
  const loader = loadSubject(LOADER).createToolLoader({ tools, hasRule: async () => true });
  await loader.load();
  const access = tools.find((t) => t.name === name)?.access ?? 'read';
  try {
    const out = await loader.run({ action: { tool: name, access, args }, key: 'k' });
    return { ok: true, text: out.text };
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return { ok: false, message: err.message };
  }
}

const cases = [
  // ---- Which tools exist ---------------------------------------------------------------------------
  {
    id: 'no-token-or-no-repositories-means-no-tools',
    check() {
      const none = [{ token: '' }, { token: undefined }, { token: 5 }, { repos: [] }, { repos: undefined }, { repos: 'acme/site' }, { repos: [5, null, 'bad', 'a/b/c', ''] }].map((o) => make(fakeFetch(), o).length);
      return verdict(none.every((n) => n === 0), json(none));
    },
  },
  {
    id: 'four-tools-with-the-right-tags-and-the-merge-always-asks',
    check() {
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const tools = make(fakeFetch());
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      const names = Object.keys(byName).sort().join();
      const ok = names === 'github.create_pull_request,github.list_pull_requests,github.merge_pull_request,github.read_file'
        && byName['github.read_file'].access === 'read' && byName['github.list_pull_requests'].access === 'read'
        && byName['github.create_pull_request'].access === 'write' && byName['github.merge_pull_request'].access === 'write'
        && tools.every((t) => t.summary.length > 10 && t.args.includes('repo') && policy.isBuiltIn(t.name))
        && policy.checkAction({ tool: 'github.merge_pull_request', access: 'write', args: {} }).allowed === false
        && policy.checkAction({ tool: 'github.create_pull_request', access: 'write', args: {} }).allowed === true
        && policy.checkAction({ tool: 'github.read_file', access: 'read', args: {} }).allowed === true;
      return verdict(ok, names);
    },
  },

  // ---- Which repositories ----------------------------------------------------------------------------
  {
    id: 'only-the-named-repositories-can-be-used-and-nothing-is-sent-for-any-other',
    async check() {
      const f = fakeFetch();
      for (const repo of [OTHER, 'acme', 'acme/', '/site', 'acme/site/extra', '../acme/site', 'acme/site?x=1', 'acme/site#x', 'acme/site ', 'acme\\site', '', 5, null, ['acme/site'], 'acme/si\u0000te']) {
        const r = await run(f, 'github.read_file', { repo, path: 'README.md' });
        if (r.ok) return verdict(false, `used ${json(repo)}`);
      }
      return verdict(f.calls.length === 0, `requests: ${f.calls.length}`);
    },
  },
  {
    id: 'the-repository-name-is-matched-without-regard-to-letter-case-and-the-request-uses-the-named-spelling',
    async check() {
      const f = fakeFetch(() => ({ body: { type: 'file', encoding: 'base64', content: b64('hi'), size: 2 } }));
      const r = await run(f, 'github.read_file', { repo: 'ACME/Site', path: 'README.md' });
      return verdict(r.ok && f.calls.length === 1 && f.calls[0].url.startsWith('https://api.github.com/repos/acme/site/contents/'), json({ r, url: f.calls[0] && f.calls[0].url }));
    },
  },

  // ---- Reading a file ------------------------------------------------------------------------------
  {
    id: 'a-file-is-read-with-the-exact-request-and-its-text-decoded',
    async check() {
      const code = 'def add(a, b):\n    return a + b\n— ₹500\n';
      const f = fakeFetch(() => ({ body: { type: 'file', encoding: 'base64', content: b64(code).replace(/(.{20})/g, '$1\n'), size: code.length } }));
      const r = await run(f, 'github.read_file', { repo: REPO, path: 'src/app.py', ref: 'main' });
      const c = f.calls[0];
      return verdict(r.ok && r.text === code && c.method === 'GET' && c.url === 'https://api.github.com/repos/acme/site/contents/src/app.py?ref=main' && c.redirect === 'manual', json({ r, c: c && [c.method, c.url] }));
    },
  },
  {
    id: 'the-token-is-sent-in-one-header-to-github-and-nowhere-else',
    async check() {
      const f = fakeFetch(() => ({ body: { type: 'file', encoding: 'base64', content: b64('x'), size: 1 } }));
      await run(f, 'github.read_file', { repo: REPO, path: 'a.txt' });
      await run(f, 'github.list_pull_requests', { repo: REPO });
      const hosts = f.calls.map((c) => new URL(c.url).host);
      const auth = f.calls.map((c) => Object.entries(c.headers).filter(([k]) => /authorization/i.test(k)).map(([, v]) => v));
      const elsewhere = f.calls.filter((c) => !c.url.startsWith('https://api.github.com/repos/acme/site/')).length;
      return verdict(f.calls.length === 2 && hosts.every((h) => h === 'api.github.com') && auth.every((a) => a.length === 1 && a[0] === `Bearer ${TOKEN}`) && elsewhere === 0, json({ hosts, auth: auth.length }));
    },
  },
  {
    id: 'paths-that-leave-the-repository-or-name-secrets-are-refused-without-a-request',
    async check() {
      const f = fakeFetch();
      for (const p of ['../other/file', 'a/../../b', '/etc/passwd', '.env', 'sub/.env.local', '.git/config', 'node_modules/x/index.js', 'server.pem', 'id_rsa', 'credentials.json', '.ENV', '', '   ', 5, null, 'a\u0000b', 'x'.repeat(301), 'a?b=c', 'a#b', 'a\\b', '%2e%2e/x']) {
        const r = await run(f, 'github.read_file', { repo: REPO, path: p });
        if (r.ok) return verdict(false, `read ${json(p)}`);
      }
      return verdict(f.calls.length === 0, `requests: ${f.calls.length}`);
    },
  },
  {
    id: 'a-folder-a-binary-file-or-a-very-large-file-is-not-read',
    async check() {
      const folder = await run(fakeFetch(() => ({ body: [{ name: 'a', type: 'file' }] })), 'github.read_file', { repo: REPO, path: 'src' });
      const binary = await run(fakeFetch(() => ({ body: { type: 'file', encoding: 'base64', content: Buffer.from([0x50, 0x4b, 0, 3, 4]).toString('base64'), size: 5 } })), 'github.read_file', { repo: REPO, path: 'a.zip' });
      const big = await run(fakeFetch(() => ({ body: { type: 'file', encoding: 'base64', content: '', size: 5_000_000 } })), 'github.read_file', { repo: REPO, path: 'big.txt' });
      const link = await run(fakeFetch(() => ({ body: { type: 'symlink', target: '../x' } })), 'github.read_file', { repo: REPO, path: 'l' });
      return verdict(!folder.ok && !binary.ok && !big.ok && !link.ok, json({ folder, binary, big, link }));
    },
  },
  {
    id: 'long-text-is-cut-and-says-so',
    async check() {
      const text = `START${'x'.repeat(100_000)}`;
      const r = await run(fakeFetch(() => ({ body: { type: 'file', encoding: 'base64', content: b64(text), size: text.length } })), 'github.read_file', { repo: REPO, path: 'long.txt' });
      return verdict(r.ok && r.text.startsWith('START') && r.text.length < 20_000 && /cut|shortened|larger/i.test(r.text.slice(-200)), `length ${r.text && r.text.length}`);
    },
  },

  // ---- Listing pull requests -------------------------------------------------------------------------
  {
    id: 'pull-requests-are-listed-one-per-line-and-the-state-is-checked',
    async check() {
      const prs = [{ number: 7, title: 'Fix login', state: 'open', user: { login: 'dev1' }, html_url: 'https://github.com/acme/site/pull/7' }, { number: 6, title: 'Docs', state: 'closed', user: { login: 'dev2' }, merged_at: '2026-11-20T00:00:00Z' }];
      const f = fakeFetch(() => ({ body: prs }));
      const r = await run(f, 'github.list_pull_requests', { repo: REPO, state: 'all' });
      const lines = r.ok ? r.text.split('\n') : [];
      const url = f.calls[0] && f.calls[0].url;
      const bad = [];
      for (const state of ['bogus', 5, '', 'open&x=1']) bad.push((await run(f, 'github.list_pull_requests', { repo: REPO, state })).ok);
      const def = await run(fakeFetch(() => ({ body: [] })), 'github.list_pull_requests', { repo: REPO });
      return verdict(r.ok && lines.length === 2 && lines[0].includes('#7') && lines[0].includes('Fix login') && lines[0].includes('dev1') && lines[1].includes('#6') && url === 'https://api.github.com/repos/acme/site/pulls?state=all&per_page=20' && bad.every((b) => b === false) && def.ok, json({ r, bad, url }));
    },
  },

  // ---- Opening a pull request ----------------------------------------------------------------------
  {
    id: 'a-pull-request-is-opened-with-exactly-the-given-fields',
    async check() {
      const f = fakeFetch(() => ({ status: 201, body: { number: 12, html_url: 'https://github.com/acme/site/pull/12' } }));
      const r = await run(f, 'github.create_pull_request', { repo: REPO, title: 'Add the login page', head: 'feature/login', base: 'main', body: 'Adds it.' });
      const c = f.calls[0];
      return verdict(r.ok && /12/.test(r.text) && c.method === 'POST' && c.url === 'https://api.github.com/repos/acme/site/pulls' && json(c.body) === json({ title: 'Add the login page', head: 'feature/login', base: 'main', body: 'Adds it.' }), json({ r, c: c && [c.method, c.url, c.body] }));
    },
  },
  {
    id: 'a-pull-request-with-odd-arguments-is-refused-without-a-request',
    async check() {
      const f = fakeFetch();
      const ok = { repo: REPO, title: 'T', head: 'feature/x', base: 'main' };
      const bad = [{ ...ok, title: '' }, { ...ok, title: 'x'.repeat(257) }, { ...ok, head: '' }, { ...ok, head: 'a b' }, { ...ok, head: '../x' }, { ...ok, base: 'main\nx' }, { ...ok, base: 5 }, { ...ok, body: 5 }, { ...ok, body: 'x'.repeat(10_001) }, { ...ok, extra: 1 }, { repo: REPO }, { ...ok, head: 'a'.repeat(101) }];
      for (const args of bad) {
        const r = await run(f, 'github.create_pull_request', args);
        if (r.ok) return verdict(false, `opened with ${json(args)}`);
      }
      return verdict(f.calls.length === 0, `requests: ${f.calls.length}`);
    },
  },

  // ---- Merging ----------------------------------------------------------------------------------------
  {
    id: 'a-merge-sends-one-request-with-the-pull-request-number-only',
    async check() {
      const f = fakeFetch(() => ({ body: { merged: true, message: 'Pull Request successfully merged' } }));
      const r = await run(f, 'github.merge_pull_request', { repo: REPO, number: 12 });
      const c = f.calls[0];
      return verdict(r.ok && /merged/i.test(r.text) && f.calls.length === 1 && c.method === 'PUT' && c.url === 'https://api.github.com/repos/acme/site/pulls/12/merge' && (c.body === undefined || json(c.body) === '{}'), json({ r, c: c && [c.method, c.url, c.body] }));
    },
  },
  {
    id: 'a-merge-with-an-odd-number-is-refused-and-a-merge-that-did-not-happen-is-a-failure',
    async check() {
      const f = fakeFetch();
      for (const number of [0, -1, 1.5, '12', null, undefined, NaN, Infinity, 10 ** 12, [12], { n: 12 }]) {
        const r = await run(f, 'github.merge_pull_request', { repo: REPO, number });
        if (r.ok) return verdict(false, `merged ${json(number)}`);
      }
      const refused = await run(fakeFetch(() => ({ status: 405, body: { message: `not mergeable ${TOKEN}` } })), 'github.merge_pull_request', { repo: REPO, number: 3 });
      const notMerged = await run(fakeFetch(() => ({ body: { merged: false } })), 'github.merge_pull_request', { repo: REPO, number: 3 });
      return verdict(f.calls.length === 0 && !refused.ok && !notMerged.ok, json({ calls: f.calls.length, refused, notMerged }));
    },
  },

  // ---- Errors and safety -------------------------------------------------------------------------------
  {
    id: 'errors-never-show-the-token-githubs-message-or-the-systems-own-text',
    async check() {
      const replies = [
        () => new Error(`connect ECONNREFUSED ${TOKEN}`),
        () => ({ status: 401, body: { message: `Bad credentials ${TOKEN}` } }),
        () => ({ status: 403, body: { message: 'rate limit exceeded' } }),
        () => ({ status: 404, body: { message: 'Not Found' } }),
        () => ({ status: 500, body: 'oops' }),
        () => ({ status: 200, body: 'not json at all' }),
        () => ({ status: 302, headers: { location: 'https://evil.example/steal' }, body: '' }),
      ];
      for (const reply of replies) {
        const f = fakeFetch(reply);
        const r = await run(f, 'github.read_file', { repo: REPO, path: 'a.txt' });
        const shown = json(r);
        if (r.ok || shown.includes(TOKEN) || /ECONN|Bad credentials|rate limit|Not Found/i.test(shown) || f.calls.length !== 1) return verdict(false, `leaked or followed: ${shown.slice(0, 200)}`);
      }
      return verdict(true);
    },
  },
];

module.exports = {
  name: 'github-tools',
  description: 'GitHub tools: only named repositories, token in one header to api.github.com only, read file/list/open PR/merge (merge always asks), odd arguments refused before any request, no token or GitHub text in errors',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
