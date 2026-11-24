'use strict';

// Grades Gate 1 of PLAN.md (step 1.11): "a fake agent proposes a spend, a plain-language card reaches Telegram and the
// dashboard, one approval unblocks it, and audit_log records every step."
//
// The scenario itself lives in scripts/gate1.js so it can be re-run by hand (`npm run gate:1`). This suite runs it and
// fails with the names of the steps that failed. It uses the real app, a real Postgres with the real migrations, the
// real Telegram bot and poller, the real planner, card writer, policy, decisions, tool loader, graph and audit log. Only
// Telegram's servers, the model and the purchase tool are fake, and any other network request is refused and counted.
//
// Steps in each run (16 when the founder approves, 16 when they reject): the app starts; a /goal is acknowledged; the
// plan's spend becomes a decision; the card passes the plain-language checker; it reaches Telegram with its buttons;
// it is on the dashboard and the window is told; nothing is bought while it waits; one tap answers it and Telegram
// confirms; the run continues (the purchase happens exactly once, after its audit entry) or, on a rejection, buys
// nothing; the founder is told how it ended; answering again changes nothing; audit_log has every step in order, no
// key, and says who answered; the window is told about every stage; and nothing outside was reached.

const path = require('node:path');
const { ROOT } = require('../lib');

const MIN_STEPS = 15;
const cache = new Map();

/** Runs one scenario once and shares the result between cases. */
function scenarioOnce(answer) {
  if (!cache.has(answer)) {
    const { scenario } = require(path.join(ROOT, 'scripts/gate1'));
    cache.set(answer, scenario(answer));
  }
  return cache.get(answer);
}

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });

const failedSteps = (steps) => steps.filter((s) => !s.ok).map((s) => `${s.name}${s.detail ? ` -> ${s.detail}` : ''}`);

const cases = [
  {
    id: 'the-gate-passes-when-the-founder-approves',
    async check() {
      const { steps } = await scenarioOnce('approved');
      const failed = failedSteps(steps);
      return verdict(failed.length === 0 && steps.length >= MIN_STEPS, `${steps.length} steps; failed: ${failed.join(' | ')}`);
    },
  },
  {
    id: 'the-gate-passes-when-the-founder-rejects',
    async check() {
      const { steps } = await scenarioOnce('rejected');
      const failed = failedSteps(steps);
      return verdict(failed.length === 0 && steps.length >= MIN_STEPS, `${steps.length} steps; failed: ${failed.join(' | ')}`);
    },
  },
  {
    id: 'the-gate-can-be-re-run-from-scratch-and-gives-the-same-result',
    async check() {
      const first = await scenarioOnce('approved');
      const { scenario } = require(path.join(ROOT, 'scripts/gate1'));
      const again = await scenario('approved'); // a brand new database, app and fake Telegram
      const names = (r) => r.steps.map((s) => `${s.name}:${s.ok}`).join('\n');
      return verdict(names(first) === names(again) && again.steps.every((s) => s.ok), `second run failed: ${failedSteps(again.steps).join(' | ')}`);
    },
  },
];

module.exports = {
  name: 'phase1-gate',
  description: 'Gate 1: a fake agent proposes a spend, a plain-language card reaches Telegram and the dashboard, one approval unblocks it, and audit_log records every step (also runnable by hand: npm run gate:1)',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
