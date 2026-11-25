'use strict';

// Grades the web search tool (PLAN.md step 2.3: "one search tool"):
//   src/runtime/tools/search.js   createSearchTools({ apiKey, fetchImpl }) -> [search.web]
//
//   search.web { query, count? } -> { text }   one result per line: "title | address | description"
//
//   - without a key there is no tool, and the tool is read-only with a built-in policy rule
//   - the address is fixed (Tavily's search address) and the request is a POST; the agent chooses only the words and a capped count
//   - the key travels in ONE header and never in an address, the body holds only the fixed settings, a redirect is never followed,
//     and an odd argument never causes a request
//   - results are plain one-line text (no markup), only http(s) addresses, cut to a limit; Tavily's own answer and page text are not asked for
//   - an error is one plain sentence: never the key, the service's own message or the system's error text

const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/tools/search.js';
const LOADER = 'src/runtime/tools/index.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const KEY = 'tvly-test-key-ABCDEFGHIJKLMNOP';

/** A network stand-in that records every request and answers with `reply`. */
function fakeNet(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = typeof reply === 'function' ? reply(url, init) : reply;
    if (r instanceof Error) throw r;
    return { ok: r.ok !== false, status: r.status ?? 200, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { calls, fetchImpl };
}

const OK = { body: { query: 'acme', results: [{ title: 'Acme <b>Shop</b>', url: 'https://acme.example/', content: 'We sell\n shoes.', score: 0.9 }, { title: 'Bad', url: 'javascript:alert(1)', content: 'x' }, { title: 'Acme about', url: 'https://acme.example/about', content: 'About us' }] } };

async function run(net, args, apiKey = KEY) {
  const tools = loadSubject(SUBJECT).createSearchTools({ apiKey, fetchImpl: net.fetchImpl });
  const loader = loadSubject(LOADER).createToolLoader({ tools, hasRule: async () => true });
  await loader.load();
  try {
    const out = await loader.run({ action: { tool: 'search.web', access: 'read', args }, key: 'k' });
    return { ok: true, text: out.text };
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return { ok: false, message: err.message };
  }
}

const cases = [
  {
    id: 'the-tool-is-read-only-with-a-summary-and-a-policy-rule',
    check() {
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const tools = loadSubject(SUBJECT).createSearchTools({ apiKey: KEY, fetchImpl: fakeNet(OK).fetchImpl });
      const t = tools[0];
      return verdict(tools.length === 1 && t.name === 'search.web' && t.access === 'read' && t.summary.length > 10 && t.args.includes('query') && policy.isBuiltIn('search.web') && policy.checkAction({ tool: 'search.web', access: 'read', args: { query: 'x' } }).allowed === true && policy.checkAction({ tool: 'search.web', access: 'write', args: { query: 'x' } }).allowed === false, json(t && t.name));
    },
  },
  {
    id: 'without-a-key-there-is-no-tool',
    check() {
      const none = [undefined, null, '', '   ', 5, {}].map((apiKey) => loadSubject(SUBJECT).createSearchTools({ apiKey }).length);
      return verdict(none.every((n) => n === 0) && loadSubject(SUBJECT).createSearchTools().length === 0, json(none));
    },
  },
  {
    id: 'a-search-is-one-post-to-the-fixed-address-with-the-key-in-one-header-never-in-an-address-and-only-the-fixed-settings-in-the-body',
    async check() {
      const net = fakeNet(OK);
      const words = 'Acme shoes shop", "include_raw_content": true, "include_domains": ["evil.example"]';
      const r = await run(net, { query: words, count: 3 });
      const c = net.calls[0];
      const body = c && JSON.parse(c.init.body);
      const keys = body && Object.keys(body).sort().join();
      return verdict(r.ok && net.calls.length === 1 && c.url === 'https://api.tavily.com/search' && c.init.method === 'POST' && c.init.redirect === 'manual' && c.init.headers.Authorization === `Bearer ${KEY}` && c.init.headers['Content-Type'] === 'application/json'
        && !c.url.includes(KEY) && !c.url.includes('?') && JSON.stringify(c.init.body).split(KEY).length === 1
        && body.query === words && body.max_results === 3 && body.search_depth === 'basic' && body.include_answer === false && body.include_raw_content === false && body.include_images === false
        && keys === 'include_answer,include_images,include_raw_content,max_results,query,search_depth' && !('include_domains' in body), json({ r, url: c && c.url, keys }));
    },
  },
  {
    id: 'results-are-one-plain-line-each-without-markup-and-only-web-addresses',
    async check() {
      const r = await run(fakeNet(OK), { query: 'acme' });
      const lines = r.text.split('\n');
      return verdict(r.ok && lines.length === 2 && lines[0] === 'Acme Shop | https://acme.example/ | We sell shoes.' && !/javascript|<b>/.test(r.text), json(r));
    },
  },
  {
    id: 'no-results-and-an-odd-reply-both-say-no-results',
    async check() {
      const a = await run(fakeNet({ body: { results: [] } }), { query: 'zzz' });
      const b = await run(fakeNet({ body: { nothing: true } }), { query: 'zzz' });
      return verdict(a.ok && b.ok && a.text === 'No results.' && b.text === 'No results.', json({ a, b }));
    },
  },
  {
    id: 'a-bad-argument-is-refused-and-never-causes-a-request',
    async check() {
      const bad = [{}, { query: '' }, { query: '   ' }, { query: 5 }, { query: 'x'.repeat(201) }, { query: 'a\nb' }, { query: 'ok', count: 0 }, { query: 'ok', count: 11 }, { query: 'ok', count: 1.5 }, { query: 'ok', count: '3' }, { query: 'ok', url: 'https://evil.example/' }, { query: 'ok', domain: 'x' }, 'query', null];
      for (const args of bad) {
        const net = fakeNet(OK);
        const r = await run(net, args);
        if (r.ok || net.calls.length !== 0) return verdict(false, `${json(args)} -> ${json(r)} calls ${net.calls.length}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'the-count-defaults-to-five-and-the-text-is-cut-to-a-limit',
    async check() {
      const net = fakeNet({ body: { results: Array.from({ length: 10 }, (_, i) => ({ title: 'T'.repeat(5000), url: `https://x.example/${i}`, content: 'D'.repeat(5000) })) } });
      const r = await run(net, { query: 'long' });
      const asked = JSON.parse(net.calls[0].init.body).max_results;
      return verdict(r.ok && asked === 5 && r.text.length <= 20_000 && r.text.split('\n').every((l) => l.length < 1000), json({ len: r.text?.length, asked }));
    },
  },
  {
    id: 'a-failure-is-one-plain-sentence-that-never-shows-the-key-or-the-service-text',
    async check() {
      const failures = [{ ok: false, status: 401, body: `denied for ${KEY} at https://secret.internal/x` }, { body: 'not json at all' }, new Error(`connect ECONNREFUSED 10.0.0.5 ${KEY}`), { body: '{"results":' }];
      for (const f of failures) {
        // Through the loader (which hides every tool error) and straight from the tool (which must already be plain).
        const r = await run(fakeNet(f), { query: 'acme' });
        const [tool] = loadSubject(SUBJECT).createSearchTools({ apiKey: KEY, fetchImpl: fakeNet(f).fetchImpl });
        const direct = await tool.run({ args: { query: 'acme' } }).then(() => null, (err) => err.message);
        if (r.ok || r.message.includes(KEY) || direct !== 'The search did not work.') return verdict(false, json({ f: String(f.body ?? f.message), r, direct }));
      }
      return verdict(true);
    },
  },
];

module.exports = {
  name: 'search-tool',
  description: 'Web search tool (Tavily): read-only, one POST to a fixed address, key in one header and never in an address, fixed body settings, no redirects, plain one-line results, no error text',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
