'use strict';

// Grades Gate 2 of PLAN.md (step 2.7): "a lead goes from research to a drafted proposal to founder approval, and a support ticket is answered
// or escalated correctly."
//
// The scenario itself lives in scripts/gate2.js so it can be re-run by hand (`npm run gate:2`). This suite runs it and fails with the names of the
// steps that failed. It uses the real app, a real Postgres with the real migrations, the real Marketing and Sales team and Customer Support team
// (skills, tool files, workers, review), the real outbound gate, policy, decisions service, tool loader, Telegram bot and poller, Teams overview,
// daily brief and audit log. Only Telegram's and Tavily's servers, the model (a scripted provider cleared for client text) and the mail transport are
// fake, and any other network request is refused and counted.
//
// Steps in each run (22 when the founder approves the emails, 22 when they reject them): the app starts and the new screens start empty; a lead is
// researched, saved and turned into a proposal email that is reviewed and waits on a card (nothing is sent); the card is in plain language and reaches
// the phone and the window; a routine ticket is answered through the same gate and recorded; a refund ticket becomes a spend card, the ticket is marked
// escalated and the customer is written nothing; the phone's /brief matches the window's brief and says what happened; the Teams page matches the data;
// ONE tap approves (the email is sent exactly once, with exactly the stored text) or rejects (it can never be sent); the refund is still the founder's:
// no refund ran; audit_log has every step in order and no key; the window was told as it happened; and nothing outside was reached.

const path = require('node:path');
const { ROOT } = require('../lib');

const MIN_STEPS = 20;
const cache = new Map();

/** Runs one scenario once and shares the result between cases. */
function scenarioOnce(answer) {
  if (!cache.has(answer)) {
    const { scenario } = require(path.join(ROOT, 'scripts/gate2'));
    cache.set(answer, scenario(answer));
  }
  return cache.get(answer);
}

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const failedSteps = (steps) => steps.filter((s) => !s.ok).map((s) => `${s.name}${s.detail ? ` -> ${s.detail}` : ''}`);

const cases = [
  {
    id: 'the-gate-passes-when-the-founder-approves-the-emails',
    async check() {
      const { steps } = await scenarioOnce('approved');
      const failed = failedSteps(steps);
      return verdict(failed.length === 0 && steps.length >= MIN_STEPS, `${steps.length} steps; failed: ${failed.join(' | ')}`);
    },
  },
  {
    id: 'the-gate-passes-when-the-founder-rejects-the-emails',
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
      const { scenario } = require(path.join(ROOT, 'scripts/gate2'));
      const again = await scenario('approved'); // a brand new database, app and fake Telegram
      const names = (r) => r.steps.map((s) => `${s.name}:${s.ok}`).join('\n');
      return verdict(names(first) === names(again) && again.steps.every((s) => s.ok), `second run failed: ${failedSteps(again.steps).join(' | ')}`);
    },
  },
];

module.exports = {
  name: 'phase2-gate',
  description: 'Gate 2: a lead goes from research to a drafted proposal to founder approval, and a support ticket is answered or escalated correctly; the phone and the window agree (also runnable by hand: npm run gate:2)',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
