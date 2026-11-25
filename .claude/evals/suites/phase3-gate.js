'use strict';

// Grades Gate 3 of PLAN.md (step 3.8): "a pod is created, an agent opens a PR, and an invoice draft is produced, all isolated per pod."
//
// The scenario itself lives in scripts/gate3.js so it can be re-run by hand (`npm run gate:3`). This suite runs it and fails with the names of the
// steps that failed. It uses the real app, a real Postgres with the real migrations, the real pods service, the real Engineering team and Finance, Legal
// and Ops team (skills, tool files, workers, review), the real git tools pushing to real bare repositories, policy, decisions service, tool loader,
// files panel and agents panel services, and audit log. Only GitHub's API, the remote repositories' location and the model (a scripted provider) are
// fake, and any other network request is refused and counted.
//
// Steps in the run (21): the app starts; two projects are asked for on plain cards and nothing is made until the founder approves; approving opens both
// (own folder, own git history, own GitHub repository, own memory); an agent makes a branch, writes a file, saves it, sends it and opens exactly one pull
// request on its own project's repository, with the main line and the other project untouched; an agent told to read the other project's notes is refused
// and the model never sees the other project's words (in either direction); a production deploy attempt becomes a card tied to the project and nothing goes
// live; the Finance team drafts an invoice inside the other project with the GST worked out in code and no invoice number; a payment request becomes a card
// tied to that project and nothing is paid; every task and tool run belongs to one project; the files panel and the agents panel with its live feed show it;
// the audit log has every step; no key or token is anywhere; and nothing outside was reached.

const path = require('node:path');
const { ROOT } = require('../lib');

const MIN_STEPS = 20;
const cache = {};

/** Runs the scenario once and shares the result between cases. */
function scenarioOnce() {
  if (!cache.run) {
    const { scenario } = require(path.join(ROOT, 'scripts/gate3'));
    cache.run = scenario();
  }
  return cache.run;
}

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const failedSteps = (steps) => steps.filter((s) => !s.ok).map((s) => `${s.name}${s.detail ? ` -> ${s.detail}` : ''}`);

const cases = [
  {
    id: 'the-gate-passes-a-pod-is-created-an-agent-opens-a-pr-and-an-invoice-draft-is-produced-all-isolated-per-pod',
    async check() {
      const { steps } = await scenarioOnce();
      const failed = failedSteps(steps);
      return verdict(failed.length === 0 && steps.length >= MIN_STEPS, `${steps.length} steps; failed: ${failed.join(' | ')}`);
    },
  },
  {
    id: 'the-gate-can-be-re-run-from-scratch-and-gives-the-same-result',
    async check() {
      const first = await scenarioOnce();
      const { scenario } = require(path.join(ROOT, 'scripts/gate3'));
      const again = await scenario(); // a brand new database, app, folders and repositories
      const names = (r) => r.steps.map((s) => `${s.name}:${s.ok}`).join('\n');
      return verdict(names(first) === names(again) && again.steps.every((s) => s.ok), `second run failed: ${failedSteps(again.steps).join(' | ')}`);
    },
  },
  {
    id: 'the-gate-covers-the-three-parts-of-the-done-when-and-the-isolation-in-both-directions',
    async check() {
      const { steps } = await scenarioOnce();
      const text = steps.map((s) => s.name).join('\n');
      const wanted = [/opens both projects/, /pull request is real/, /drafts the invoice inside Beta/, /Alpha told to read Beta/, /Beta's agents never saw Alpha/, /payment request/, /production deploy/];
      const missing = wanted.filter((re) => !re.test(text)).map(String);
      return verdict(missing.length === 0, `steps missing from the gate: ${missing.join(', ')}`);
    },
  },
];

module.exports = {
  name: 'phase3-gate',
  description: 'Gate 3: a pod is created, an agent opens a PR, and an invoice draft is produced, all isolated per pod (also runnable by hand: npm run gate:3)',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
