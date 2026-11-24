'use strict';

// Grades the Groq and Ollama providers and the provider-list builder (PLAN.md step 1.3):
//   src/runtime/providers/groq.js    createGroqCall({ apiKey, fetchImpl }) -> call
//   src/runtime/providers/ollama.js  createOllamaCall({ baseUrl, fetchImpl }) -> call
//   src/runtime/providers/index.js   buildProviders({ env, fetchImpl, run? }) -> provider list
//
// `call({ prompt, model })` resolves to { text, model, costUsd, tokens } or throws. The
// router treats a throw as a failed attempt and moves on. `fetchImpl(url, init)` is a
// stand-in for fetch that returns { ok, status, json() }, so nothing here touches the
// network and no real key is needed. The key is a dummy: the founder adds the real one
// to .env later.

const { loadSubject } = require('../lib');

const GROQ = 'src/runtime/providers/groq.js';
const OLLAMA = 'src/runtime/providers/ollama.js';
const INDEX = 'src/runtime/providers/index.js';
const ROUTER = 'src/runtime/router.js';

const DUMMY_KEY = 'gsk_DUMMYKEYDUMMYKEYDUMMYKEY123456';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });

/** A fetch stand-in that records the request and answers with `body`. */
function fakeFetch(body, { ok = true, status = 200 } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok, status, json: async () => body };
  };
  return { fetchImpl, seen };
}

const groqBody = {
  choices: [{ message: { role: 'assistant', content: 'hello from groq' } }],
  model: 'dummy-groq-model',
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
};
const ollamaBody = { model: 'dummy-ollama-model', message: { role: 'assistant', content: 'hello from ollama' }, prompt_eval_count: 4, eval_count: 6, done: true };

const groqCall = (fetchImpl, apiKey = DUMMY_KEY) => loadSubject(GROQ).createGroqCall({ apiKey, fetchImpl });
const ollamaCall = (fetchImpl, baseUrl) => loadSubject(OLLAMA).createOllamaCall({ baseUrl, fetchImpl });
const build = (env) => loadSubject(INDEX).buildProviders({ env, fetchImpl: fakeFetch(groqBody).fetchImpl });
const bodyOf = (init) => JSON.parse(init.body);

async function rejects(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err; // code not written yet: stay pending, not failed
    return err;
  }
}

const cases = [
  // ---- Groq ---------------------------------------------------------------
  {
    id: 'groq-posts-to-the-groq-https-api-with-the-key-as-a-bearer-token',
    async check() {
      const { fetchImpl, seen } = fakeFetch(groqBody);
      await groqCall(fetchImpl)({ prompt: 'hi', model: 'dummy-groq-model' });
      const { url, init } = seen[0];
      const ok = url.startsWith('https://api.groq.com/') && init.method === 'POST' && init.headers.Authorization === `Bearer ${DUMMY_KEY}`;
      return verdict(ok, `${url} ${JSON.stringify(init.headers)}`);
    },
  },
  {
    id: 'groq-sends-the-model-and-the-prompt-as-one-user-message',
    async check() {
      const { fetchImpl, seen } = fakeFetch(groqBody);
      await groqCall(fetchImpl)({ prompt: 'say hi', model: 'dummy-groq-model' });
      const b = bodyOf(seen[0].init);
      const ok = b.model === 'dummy-groq-model' && b.messages.length === 1 && b.messages[0].role === 'user' && b.messages[0].content === 'say hi';
      return verdict(ok, JSON.stringify(b));
    },
  },
  {
    id: 'groq-never-puts-the-key-in-the-url-or-the-body',
    async check() {
      const { fetchImpl, seen } = fakeFetch(groqBody);
      await groqCall(fetchImpl)({ prompt: 'hi', model: 'm' });
      return verdict(!seen[0].url.includes(DUMMY_KEY) && !seen[0].init.body.includes(DUMMY_KEY), 'key leaked outside the Authorization header');
    },
  },
  {
    id: 'groq-returns-text-model-and-token-count',
    async check() {
      const { fetchImpl } = fakeFetch(groqBody);
      const r = await groqCall(fetchImpl)({ prompt: 'hi', model: 'dummy-groq-model' });
      return verdict(r.text === 'hello from groq' && r.model === 'dummy-groq-model' && r.tokens === 12 && r.costUsd === 0, JSON.stringify(r));
    },
  },
  {
    id: 'groq-an-error-status-throws-and-the-message-holds-no-key-or-body',
    async check() {
      const { fetchImpl } = fakeFetch({ error: { message: `bad key ${DUMMY_KEY}` } }, { ok: false, status: 401 });
      const err = await rejects(() => groqCall(fetchImpl)({ prompt: 'hi', model: 'm' }));
      return verdict(err && !err.message.includes(DUMMY_KEY) && err.message.includes('401'), `got ${err && err.message}`);
    },
  },
  {
    id: 'groq-a-network-failure-throws-without-the-key',
    async check() {
      const fetchImpl = async () => {
        throw new Error(`connect failed for Bearer ${DUMMY_KEY}`);
      };
      const err = await rejects(() => groqCall(fetchImpl)({ prompt: 'hi', model: 'm' }));
      return verdict(err && !err.message.includes(DUMMY_KEY), `got ${err && err.message}`);
    },
  },
  {
    id: 'groq-an-answer-with-no-choices-or-no-text-throws',
    async check() {
      const empties = [{}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: '  ' } }] }];
      for (const body of empties) {
        const err = await rejects(() => groqCall(fakeFetch(body).fetchImpl)({ prompt: 'hi', model: 'm' }));
        if (!err) return verdict(false, `no throw for ${JSON.stringify(body)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'groq-without-a-key-throws-before-any-request',
    async check() {
      const { fetchImpl, seen } = fakeFetch(groqBody);
      const results = [];
      // Built directly: the groqCall helper would swap an undefined key for the dummy one.
      for (const apiKey of [undefined, '', '   ']) {
        const call = loadSubject(GROQ).createGroqCall({ apiKey, fetchImpl });
        results.push(await rejects(() => call({ prompt: 'hi', model: 'm' })));
      }
      return verdict(results.every(Boolean) && seen.length === 0, `requests sent: ${seen.length}`);
    },
  },

  // ---- Ollama -------------------------------------------------------------
  {
    id: 'ollama-posts-to-api-chat-with-streaming-off',
    async check() {
      const { fetchImpl, seen } = fakeFetch(ollamaBody);
      await ollamaCall(fetchImpl, 'http://localhost:11434')({ prompt: 'say hi', model: 'dummy-ollama-model' });
      const b = bodyOf(seen[0].init);
      const ok = seen[0].url === 'http://localhost:11434/api/chat' && b.stream === false && b.model === 'dummy-ollama-model' && b.messages[0].content === 'say hi';
      return verdict(ok, `${seen[0].url} ${JSON.stringify(b)}`);
    },
  },
  {
    id: 'ollama-defaults-to-localhost-11434-and-ignores-a-trailing-slash',
    async check() {
      const a = fakeFetch(ollamaBody);
      const b = fakeFetch(ollamaBody);
      await ollamaCall(a.fetchImpl, undefined)({ prompt: 'hi', model: 'm' });
      await ollamaCall(b.fetchImpl, 'http://127.0.0.1:9999/')({ prompt: 'hi', model: 'm' });
      return verdict(a.seen[0].url === 'http://localhost:11434/api/chat' && b.seen[0].url === 'http://127.0.0.1:9999/api/chat', `${a.seen[0].url} | ${b.seen[0].url}`);
    },
  },
  {
    id: 'ollama-returns-text-model-and-token-count',
    async check() {
      const r = await ollamaCall(fakeFetch(ollamaBody).fetchImpl)({ prompt: 'hi', model: 'dummy-ollama-model' });
      return verdict(r.text === 'hello from ollama' && r.model === 'dummy-ollama-model' && r.tokens === 10 && r.costUsd === 0, JSON.stringify(r));
    },
  },
  {
    id: 'ollama-refuses-a-base-url-that-is-not-http-or-https',
    async check() {
      const { fetchImpl, seen } = fakeFetch(ollamaBody);
      const errs = [];
      for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://host', 'not a url']) {
        errs.push(await rejects(() => ollamaCall(fetchImpl, url)({ prompt: 'hi', model: 'm' })));
      }
      return verdict(errs.every(Boolean) && seen.length === 0, `requests sent: ${seen.length}`);
    },
  },
  {
    id: 'ollama-an-error-status-or-missing-message-throws',
    async check() {
      const down = await rejects(() => ollamaCall(fakeFetch({}, { ok: false, status: 500 }).fetchImpl)({ prompt: 'hi', model: 'm' }));
      const empty = await rejects(() => ollamaCall(fakeFetch({ done: true }).fetchImpl)({ prompt: 'hi', model: 'm' }));
      return verdict(Boolean(down) && Boolean(empty), `down: ${Boolean(down)}, empty: ${Boolean(empty)}`);
    },
  },

  // ---- Provider list -------------------------------------------------------
  {
    id: 'list-has-groq-ollama-claude-code-in-that-order-when-a-key-is-set',
    check() {
      const names = build({ GROQ_API_KEY: DUMMY_KEY }).map((p) => p.name);
      return verdict(names.join(',') === 'groq,ollama,claude-code', names.join(','));
    },
  },
  {
    id: 'list-leaves-groq-out-when-the-key-is-missing-or-blank',
    check() {
      const results = [{}, { GROQ_API_KEY: '' }, { GROQ_API_KEY: '   ' }].map((env) => build(env).map((p) => p.name).join(','));
      return verdict(results.every((r) => r === 'ollama,claude-code'), JSON.stringify(results));
    },
  },
  {
    id: 'list-takes-model-names-from-the-environment-with-dummy-defaults',
    check() {
      const custom = build({ GROQ_API_KEY: DUMMY_KEY, GROQ_MODEL: 'my-groq', OLLAMA_MODEL: 'my-ollama' });
      const plain = build({ GROQ_API_KEY: DUMMY_KEY });
      const ok =
        custom.find((p) => p.name === 'groq').model === 'my-groq' &&
        custom.find((p) => p.name === 'ollama').model === 'my-ollama' &&
        plain.every((p) => typeof p.model === 'string' && p.model.length > 0);
      return verdict(ok, JSON.stringify([custom, plain].map((l) => l.map((p) => p.model))));
    },
  },
  {
    id: 'list-passes-the-routers-own-validation',
    check() {
      const out = loadSubject(ROUTER).validateProviders(build({ GROQ_API_KEY: DUMMY_KEY }));
      return verdict(out.ok === true, JSON.stringify(out));
    },
  },
  {
    id: 'list-keeps-hosted-providers-away-from-sensitive-text-and-caps-claude-code',
    check() {
      const list = build({ GROQ_API_KEY: DUMMY_KEY });
      const get = (n) => list.find((p) => p.name === n);
      const ok = get('groq').sensitive !== true && get('claude-code').sensitive !== true && get('claude-code').maxConcurrent === 2 && list[list.length - 1].name === 'claude-code';
      return verdict(ok, JSON.stringify(list.map((p) => [p.name, p.sensitive, p.maxConcurrent])));
    },
  },
  {
    id: 'list-never-stores-the-key-on-an-entry',
    check() {
      const list = build({ GROQ_API_KEY: DUMMY_KEY });
      const leaked = list.filter((p) => Object.entries(p).some(([k, v]) => k !== 'call' && String(v).includes(DUMMY_KEY)));
      return verdict(leaked.length === 0, `leaked on: ${leaked.map((p) => p.name).join(', ')}`);
    },
  },
  {
    id: 'the-groq-entry-really-calls-groq-with-the-env-key',
    async check() {
      const { fetchImpl, seen } = fakeFetch(groqBody);
      const list = loadSubject(INDEX).buildProviders({ env: { GROQ_API_KEY: DUMMY_KEY }, fetchImpl });
      const r = await list.find((p) => p.name === 'groq').call({ prompt: 'hi', model: 'm' });
      return verdict(r.text === 'hello from groq' && seen[0].init.headers.Authorization === `Bearer ${DUMMY_KEY}`, JSON.stringify(r));
    },
  },
  {
    id: 'the-ollama-entry-uses-ollama-base-url-from-the-env',
    async check() {
      const { fetchImpl, seen } = fakeFetch(ollamaBody);
      const list = loadSubject(INDEX).buildProviders({ env: { OLLAMA_BASE_URL: 'http://127.0.0.1:5555' }, fetchImpl });
      await list.find((p) => p.name === 'ollama').call({ prompt: 'hi', model: 'm' });
      return verdict(seen[0].url === 'http://127.0.0.1:5555/api/chat', seen[0].url);
    },
  },
];

module.exports = {
  name: 'http-providers',
  description: 'Groq and Ollama providers and the provider-list builder: request shape, key handling, error handling, env settings',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
