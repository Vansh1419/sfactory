'use strict';

// Grades src/runtime/router.js (PLAN.md step 1.3): the model router that tries
// providers in order, retries with backoff, keeps per-task caps and writes an
// audit entry for every attempt. The module does not exist yet, so every case
// reports "pending" until it is written. No model is called and nothing waits:
// providers are mocks and `sleep` is injected.
//
// Contract the implementation must satisfy:
//
//   createRouter({ providers, audit, sleep, caps? }) -> { complete(request) }
//
//   providers  array, tried in the given order. Each entry is plain configuration
//              plus one function:
//                { name, model, tiers: ['cheap'|'strong'...], sensitive: boolean,
//                  maxConcurrent?: number, call: async ({ prompt, model }) ->
//                  { text, model, costUsd?, tokens? } }
//              `sensitive` must be exactly true for the provider to see sensitive
//              text (missing means no). Adding a provider is adding an entry.
//   audit      async (entry) -> void. Called BEFORE each provider call. If it
//              throws, that provider is not called.
//   sleep      async (ms) -> void, used for backoff.
//   caps       { maxSteps, maxTokens, maxRetries, baseDelayMs } (defaults:
//              steps 20, tokens 50000, retries 2, base delay 500 ms).
//
//   complete({ taskId, tier, prompt, sensitive? }) never throws and returns
//     { ok: true,  text, provider, model, costUsd, attempts }
//     { ok: false, reason, message }
//   reason is one of: all_providers_failed, no_provider, step_cap, token_cap,
//   audit_failed, bad_request. `message` is generic: never provider error text.
//
//   validateProviders(list) -> { ok, problems: string[] }   (never throws)
//   defaultProviderConfig() -> array of plain entries (no `call`), in order
//     groq, ollama, claude-code.

const { loadSubject } = require('../lib');

const SUBJECT = 'src/runtime/router.js';
const router = () => loadSubject(SUBJECT);
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });

// ---- helpers -------------------------------------------------------------

const ok = (text = 'hello', extra = {}) => async ({ model }) => ({ text, model, costUsd: 0, tokens: 10, ...extra });
const fails = (message = 'boom') => async () => {
  throw new Error(message);
};

function provider(name, call, over = {}) {
  return { name, model: `${name}-model`, tiers: ['cheap', 'strong'], sensitive: false, call, ...over };
}

function setup(providers, { caps, auditFails = false } = {}) {
  const log = [];
  const sleeps = [];
  const r = router().createRouter({
    providers,
    caps,
    audit: async (entry) => {
      if (auditFails) throw new Error('audit down');
      log.push(entry);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { r, log, sleeps };
}

const ask = (r, over = {}) => r.complete({ taskId: 't1', tier: 'cheap', prompt: 'say hi', ...over });

/** Provider that records how many times it was called. */
function counting(call) {
  const state = { calls: 0 };
  const fn = async (arg) => {
    state.calls += 1;
    return call(arg);
  };
  return { fn, state };
}

// ---- cases ---------------------------------------------------------------

const cases = [
  {
    id: 'first-provider-answers-and-chain-stops',
    async check() {
      const b = counting(ok('from b'));
      const { r } = setup([provider('a', ok('from a')), provider('b', b.fn)]);
      const res = await ask(r);
      return verdict(res.ok === true && res.text === 'from a' && res.provider === 'a' && b.state.calls === 0, JSON.stringify(res));
    },
  },
  {
    id: 'falls-through-all-three-providers-in-order',
    async check() {
      const order = [];
      const rec = (n, call) => async (arg) => {
        order.push(n);
        return call(arg);
      };
      const { r } = setup(
        [provider('groq', rec('groq', fails())), provider('ollama', rec('ollama', fails())), provider('claude-code', rec('claude-code', ok('last')))],
        { caps: { maxRetries: 0 } },
      );
      const res = await ask(r);
      return verdict(res.ok && res.provider === 'claude-code' && order.join(',') === 'groq,ollama,claude-code', `order ${order.join(',')}; ${JSON.stringify(res)}`);
    },
  },
  {
    id: 'order-is-the-configured-order-not-alphabetical',
    async check() {
      const { r } = setup([provider('zeta', ok('z')), provider('alpha', ok('a'))]);
      const res = await ask(r);
      return verdict(res.ok && res.provider === 'zeta', JSON.stringify(res));
    },
  },
  {
    id: 'all-providers-failing-returns-a-failure-not-a-throw',
    async check() {
      const { r } = setup([provider('a', fails()), provider('b', fails())], { caps: { maxRetries: 0 } });
      let res;
      try {
        res = await ask(r);
      } catch (err) {
        return verdict(false, `threw: ${err.message}`);
      }
      return verdict(res.ok === false && res.reason === 'all_providers_failed', JSON.stringify(res));
    },
  },
  {
    id: 'provider-error-text-never-reaches-the-caller',
    async check() {
      const secret = 'sk-live-ABC123-very-secret';
      const { r } = setup([provider('a', fails(`401 bad key ${secret}`))], { caps: { maxRetries: 0 } });
      const res = await ask(r);
      return verdict(!JSON.stringify(res).includes(secret), `leaked in ${JSON.stringify(res)}`);
    },
  },
  {
    id: 'no-providers-configured-is-a-clean-failure',
    async check() {
      const { r } = setup([]);
      const res = await ask(r);
      return verdict(res.ok === false && res.reason === 'no_provider', JSON.stringify(res));
    },
  },
  {
    id: 'retries-a-provider-then-succeeds',
    async check() {
      let n = 0;
      const flaky = async ({ model }) => {
        n += 1;
        if (n < 3) throw new Error('rate limited');
        return { text: 'finally', model, costUsd: 0, tokens: 5 };
      };
      const next = counting(ok('b'));
      const { r } = setup([provider('a', flaky), provider('b', next.fn)], { caps: { maxRetries: 2, baseDelayMs: 100 } });
      const res = await ask(r);
      return verdict(res.ok && res.provider === 'a' && res.text === 'finally' && n === 3 && next.state.calls === 0, `calls ${n}; ${JSON.stringify(res)}`);
    },
  },
  {
    id: 'retries-stop-at-the-limit-then-fall-through',
    async check() {
      const a = counting(fails());
      const { r } = setup([provider('a', a.fn), provider('b', ok('b'))], { caps: { maxRetries: 2, baseDelayMs: 100 } });
      const res = await ask(r);
      return verdict(res.ok && res.provider === 'b' && a.state.calls === 3, `a called ${a.state.calls} times (want 1 + 2 retries); ${JSON.stringify(res)}`);
    },
  },
  {
    id: 'backoff-delays-grow-between-retries',
    async check() {
      const { r, sleeps } = setup([provider('a', fails()), provider('b', ok())], { caps: { maxRetries: 3, baseDelayMs: 100 } });
      await ask(r);
      const grows = sleeps.length >= 3 && sleeps.every((ms, i) => i === 0 || ms > sleeps[i - 1]) && sleeps[0] >= 100;
      return verdict(grows, `sleeps ${JSON.stringify(sleeps)}`);
    },
  },
  {
    id: 'a-malformed-provider-answer-counts-as-a-failure',
    async check() {
      const bad = async () => ({ model: 'x' }); // no text
      const { r } = setup([provider('a', bad), provider('b', ok('good'))], { caps: { maxRetries: 0 } });
      const res = await ask(r);
      return verdict(res.ok && res.provider === 'b' && res.text === 'good', JSON.stringify(res));
    },
  },
  {
    id: 'an-empty-answer-counts-as-a-failure',
    async check() {
      const { r } = setup([provider('a', ok('')), provider('b', ok('good'))], { caps: { maxRetries: 0 } });
      const res = await ask(r);
      return verdict(res.ok && res.provider === 'b', JSON.stringify(res));
    },
  },
  {
    id: 'a-provider-added-by-config-alone-is-used',
    async check() {
      const { r } = setup([provider('a', fails()), provider('b', fails()), provider('c', fails()), provider('gemini', ok('new one'))], { caps: { maxRetries: 0 } });
      const res = await ask(r);
      return verdict(res.ok && res.provider === 'gemini', JSON.stringify(res));
    },
  },
  {
    id: 'strong-tier-skips-providers-not-allowed-for-it',
    async check() {
      const cheapOnly = counting(ok('cheap'));
      const { r } = setup([provider('small', cheapOnly.fn, { tiers: ['cheap'] }), provider('big', ok('strong answer'), { tiers: ['strong'] })]);
      const res = await ask(r, { tier: 'strong' });
      return verdict(res.ok && res.provider === 'big' && cheapOnly.state.calls === 0, JSON.stringify(res));
    },
  },
  {
    id: 'unknown-tier-is-refused',
    async check() {
      const a = counting(ok());
      const { r } = setup([provider('a', a.fn)]);
      const res = await ask(r, { tier: 'ultra' });
      return verdict(res.ok === false && res.reason === 'bad_request' && a.state.calls === 0, JSON.stringify(res));
    },
  },
  {
    id: 'sensitive-text-never-goes-to-a-provider-not-marked-sensitive',
    async check() {
      const hosted = counting(ok('hosted'));
      const local = counting(ok('local'));
      const { r } = setup([provider('hosted', hosted.fn, { sensitive: false }), provider('local', local.fn, { sensitive: true })]);
      const res = await ask(r, { sensitive: true });
      return verdict(res.ok && res.provider === 'local' && hosted.state.calls === 0, JSON.stringify(res));
    },
  },
  {
    id: 'sensitive-is-deny-by-default-and-only-exactly-true-counts',
    async check() {
      const sneaky = counting(ok());
      const { r } = setup([
        provider('missing-flag', sneaky.fn, { sensitive: undefined }),
        provider('string-flag', sneaky.fn, { sensitive: 'true' }),
        provider('number-flag', sneaky.fn, { sensitive: 1 }),
      ]);
      const res = await ask(r, { sensitive: true });
      return verdict(res.ok === false && res.reason === 'no_provider' && sneaky.state.calls === 0, `calls ${sneaky.state.calls}; ${JSON.stringify(res)}`);
    },
  },
  {
    id: 'a-request-that-is-not-sensitive-may-use-any-provider',
    async check() {
      const { r } = setup([provider('hosted', ok('hosted'), { sensitive: false })]);
      const res = await ask(r, { sensitive: false });
      return verdict(res.ok && res.provider === 'hosted', JSON.stringify(res));
    },
  },
  {
    id: 'step-cap-stops-a-task-and-calls-nothing-more',
    async check() {
      const a = counting(ok());
      const { r } = setup([provider('a', a.fn)], { caps: { maxSteps: 3 } });
      const results = [];
      for (let i = 0; i < 5; i += 1) results.push(await ask(r));
      const stopped = results.slice(3).every((x) => x.ok === false && x.reason === 'step_cap');
      return verdict(results.slice(0, 3).every((x) => x.ok) && stopped && a.state.calls === 3, `calls ${a.state.calls}; ${JSON.stringify(results.map((x) => x.reason || 'ok'))}`);
    },
  },
  {
    id: 'token-cap-stops-a-task-once-spent',
    async check() {
      const a = counting(ok('x', { tokens: 600 }));
      const { r } = setup([provider('a', a.fn)], { caps: { maxTokens: 1000, maxSteps: 50 } });
      const first = await ask(r);
      const second = await ask(r);
      const third = await ask(r);
      return verdict(first.ok && second.ok && third.ok === false && third.reason === 'token_cap' && a.state.calls === 2, `calls ${a.state.calls}; third ${JSON.stringify(third)}`);
    },
  },
  {
    id: 'caps-are-per-task',
    async check() {
      const { r } = setup([provider('a', ok())], { caps: { maxSteps: 1 } });
      const one = await ask(r, { taskId: 'one' });
      const oneAgain = await ask(r, { taskId: 'one' });
      const two = await ask(r, { taskId: 'two' });
      return verdict(one.ok && oneAgain.reason === 'step_cap' && two.ok, JSON.stringify([one.ok, oneAgain.reason, two.ok]));
    },
  },
  {
    id: 'a-request-without-a-task-id-is-refused',
    async check() {
      const a = counting(ok());
      const { r } = setup([provider('a', a.fn)]);
      const res = await r.complete({ tier: 'cheap', prompt: 'hi' });
      return verdict(res.ok === false && res.reason === 'bad_request' && a.state.calls === 0, JSON.stringify(res));
    },
  },
  {
    id: 'a-blank-or-non-string-prompt-is-refused',
    async check() {
      const a = counting(ok());
      const { r } = setup([provider('a', a.fn)]);
      const bad = [await ask(r, { prompt: '' }), await ask(r, { prompt: '   ' }), await ask(r, { prompt: { text: 'hi' } })];
      return verdict(bad.every((x) => x.ok === false && x.reason === 'bad_request') && a.state.calls === 0, JSON.stringify(bad));
    },
  },
  {
    id: 'concurrent-calls-to-a-capped-provider-never-exceed-the-cap',
    async check() {
      let inFlight = 0;
      let peak = 0;
      const slow = async ({ model }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return { text: 'ok', model, costUsd: 0, tokens: 1 };
      };
      const { r } = setup([provider('claude-code', slow, { maxConcurrent: 2 }), provider('spare', ok('spare'))], { caps: { maxSteps: 50 } });
      const results = await Promise.all([1, 2, 3, 4, 5].map((i) => ask(r, { taskId: `c${i}` })));
      return verdict(peak <= 2 && results.every((x) => x.ok), `peak ${peak}; ${JSON.stringify(results.map((x) => x.provider || x.reason))}`);
    },
  },
  {
    id: 'a-provider-at-its-concurrency-cap-is-skipped-not-queued',
    async check() {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const held = async ({ model }) => {
        await gate;
        return { text: 'held', model, costUsd: 0, tokens: 1 };
      };
      const { r } = setup([provider('limited', held, { maxConcurrent: 1 }), provider('spare', ok('spare'))], { caps: { maxSteps: 50 } });
      const first = ask(r, { taskId: 'x1' });
      const second = await ask(r, { taskId: 'x2' });
      release();
      await first;
      return verdict(second.ok && second.provider === 'spare', JSON.stringify(second));
    },
  },
  {
    id: 'every-attempt-is-audited-before-the-call',
    async check() {
      const seenBeforeCall = [];
      let logRef;
      const probe = async ({ model }) => {
        seenBeforeCall.push(logRef.length);
        return { text: 'ok', model, costUsd: 0, tokens: 1 };
      };
      const { r, log } = setup([provider('a', probe)]);
      logRef = log;
      await ask(r);
      return verdict(seenBeforeCall[0] >= 1, `entries before the call: ${seenBeforeCall[0]}`);
    },
  },
  {
    id: 'audit-entry-names-provider-model-task-and-never-holds-the-prompt',
    async check() {
      const prompt = 'client password is hunter2-zebra';
      const { r, log } = setup([provider('a', fails()), provider('b', ok('fine'))], { caps: { maxRetries: 0 } });
      await ask(r, { prompt });
      const text = JSON.stringify(log);
      const named = log.some((e) => e.provider === 'a') && log.some((e) => e.provider === 'b' && e.model === 'b-model');
      const hasTask = log.every((e) => e.taskId === 't1');
      return verdict(named && hasTask && !text.includes('hunter2-zebra') && !text.includes('fine'), `log ${text}`);
    },
  },
  {
    id: 'audit-failure-means-no-provider-is-called',
    async check() {
      const a = counting(ok());
      const { r } = setup([provider('a', a.fn)], { auditFails: true });
      const res = await ask(r);
      return verdict(res.ok === false && res.reason === 'audit_failed' && a.state.calls === 0, `calls ${a.state.calls}; ${JSON.stringify(res)}`);
    },
  },
  {
    id: 'result-reports-cost-and-attempt-count',
    async check() {
      const { r } = setup([provider('a', fails()), provider('b', ok('x', { costUsd: 0.002 }))], { caps: { maxRetries: 0 } });
      const res = await ask(r);
      return verdict(res.ok && res.costUsd === 0.002 && res.attempts === 2, JSON.stringify(res));
    },
  },
  {
    id: 'validate-accepts-a-good-list',
    async check() {
      const out = router().validateProviders([provider('a', ok()), provider('b', ok(), { tiers: ['cheap'] })]);
      return verdict(out.ok === true && out.problems.length === 0, JSON.stringify(out));
    },
  },
  {
    id: 'validate-rejects-duplicate-names-bad-tiers-and-a-missing-call',
    async check() {
      const dup = router().validateProviders([provider('a', ok()), provider('a', ok())]);
      const tier = router().validateProviders([provider('a', ok(), { tiers: ['ultra'] })]);
      const noTier = router().validateProviders([provider('a', ok(), { tiers: [] })]);
      const noCall = router().validateProviders([{ name: 'a', model: 'm', tiers: ['cheap'], sensitive: false }]);
      const all = [dup, tier, noTier, noCall];
      return verdict(all.every((x) => x.ok === false && x.problems.length > 0), JSON.stringify(all));
    },
  },
  {
    id: 'validate-never-throws-on-garbage',
    async check() {
      try {
        const out = [router().validateProviders(null), router().validateProviders('x'), router().validateProviders([null, 5])];
        return verdict(out.every((x) => x.ok === false), JSON.stringify(out));
      } catch (err) {
        if (err.constructor.name === 'PendingError') throw err;
        return verdict(false, `threw: ${err.message}`);
      }
    },
  },
  {
    id: 'default-config-order-is-groq-ollama-claude-code',
    async check() {
      const names = router().defaultProviderConfig().map((p) => p.name);
      return verdict(names.join(',') === 'groq,ollama,claude-code', names.join(','));
    },
  },
  {
    id: 'default-config-keeps-hosted-providers-away-from-sensitive-text',
    async check() {
      const cfg = router().defaultProviderConfig();
      const hosted = cfg.filter((p) => p.name === 'groq' || p.name === 'claude-code');
      return verdict(hosted.length === 2 && hosted.every((p) => p.sensitive !== true), JSON.stringify(hosted.map((p) => [p.name, p.sensitive])));
    },
  },
  {
    id: 'default-config-caps-claude-code-at-two-calls-and-makes-it-last',
    async check() {
      const cfg = router().defaultProviderConfig();
      const last = cfg[cfg.length - 1];
      return verdict(last.name === 'claude-code' && last.maxConcurrent === 2, JSON.stringify(last));
    },
  },
  {
    id: 'default-config-passes-its-own-validation-once-calls-are-attached',
    async check() {
      const cfg = router().defaultProviderConfig().map((p) => ({ ...p, call: ok() }));
      const out = router().validateProviders(cfg);
      return verdict(out.ok === true, JSON.stringify(out));
    },
  },
];

module.exports = {
  name: 'model-router',
  description: 'Model router: ordered fallback chain, retry with backoff, tiers, sensitive-text rule, per-task caps, concurrency cap, audit before call',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
