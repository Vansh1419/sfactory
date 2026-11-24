'use strict';

// Grades the logic behind the window's Goals panel (PLAN.md step 1.9 follow-up, Nov 24, 2026):
//   src/renderer/goals.mjs   (plain functions: no React, no window, nothing to mock)
//
//   goalView(summary)   -> what one goal shows: its text, a status label and tone, a plain explanation,
//                          and its tasks each with a state and a label
//   shouldRefetch(event)-> true when a runtime event means the list of goals changed
//   goalView(...).files    -> the files the goal's tasks produced: [{ name, content }] with safe plain names
//   goalView(...).download -> null, or { kind: 'file' | 'zip', label, filename, files }: what the Download button gives
//                             (one file as itself, several as one .zip)
//
// `summary` is one entry of the runtime's `goals.list`:
//   { threadId, status: 'running' | 'waiting' | 'done' | 'failed' | 'unknown', goal, tasks: [{ taskId, title }],
//     results: [{ taskId, title, outcome, output?, file?: { name, content } }], waitingFor?, reason?, message?, submittedAt? }
//
// Why this exists: a goal sent from the phone used to be invisible in the window (only decision cards were
// shown), so there was no sign it was being planned, had finished, or had failed.

const { loadSubject } = require('../lib');

const SUBJECT = 'src/renderer/goals.mjs';
const goals = () => loadSubject(SUBJECT);
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);

const tasks = (...titles) => titles.map((title, i) => ({ taskId: `t${i + 1}`, title }));
const outcomes = (...kinds) => kinds.map((outcome, i) => ({ taskId: `t${i + 1}`, title: `Task ${i + 1}`, outcome }));

const summary = (over = {}) => ({
  threadId: 'th-1',
  status: 'waiting',
  goal: 'Buy a domain for the landing page',
  tasks: tasks('Draft the note', 'Buy the domain'),
  results: outcomes('ran'),
  waitingFor: 'dec-1',
  submittedAt: '2026-11-24T10:00:00.000Z',
  ...over,
});

const ALL_OUTCOMES = ['ran', 'failed', 'rejected', 'cancelled', 'blocked_unknown_tool', 'blocked_card', 'blocked_decision', 'blocked_audit', 'blocked_policy'];

const cases = [
  // ---- The status of a goal ---------------------------------------------------------------------
  {
    id: 'a-goal-being-planned-says-it-is-planning-and-is-active',
    check() {
      const v = goals().goalView(summary({ status: 'running', tasks: [], results: [], waitingFor: null }));
      return verdict(/planning|working/i.test(v.statusLabel) && v.isActive === true && v.tone === 'active' && /working|planning/i.test(v.explanation), json(v));
    },
  },
  {
    id: 'a-goal-waiting-on-a-card-points-to-the-queue',
    check() {
      const v = goals().goalView(summary());
      return verdict(/waiting for you/i.test(v.statusLabel) && v.tone === 'waiting' && v.isActive === false && /decision|card/i.test(v.explanation), json(v));
    },
  },
  {
    id: 'a-finished-goal-where-everything-ran-says-finished',
    check() {
      const v = goals().goalView(summary({ status: 'done', waitingFor: null, tasks: tasks('A', 'B'), results: outcomes('ran', 'ran') }));
      return verdict(/finished/i.test(v.statusLabel) && v.tone === 'ok' && v.explanation === 'Finished.', json(v));
    },
  },
  {
    id: 'a-finished-goal-with-blocked-or-failed-tasks-says-how-many-did-not-go-ahead',
    check() {
      const v = goals().goalView(summary({ status: 'done', waitingFor: null, tasks: tasks('A', 'B', 'C'), results: outcomes('ran', 'blocked_card', 'failed') }));
      const one = goals().goalView(summary({ status: 'done', waitingFor: null, tasks: tasks('A'), results: outcomes('blocked_unknown_tool') }));
      const rejected = goals().goalView(summary({ status: 'done', waitingFor: null, tasks: tasks('A', 'B'), results: outcomes('ran', 'rejected') }));
      const ok = v.explanation === 'Finished, but 2 tasks did not go ahead.' && v.tone === 'problem' && one.explanation === 'Finished, but 1 task did not go ahead.' && rejected.explanation === 'Finished.' && rejected.tone === 'ok';
      return verdict(ok, json({ v: [v.explanation, v.tone], one: one.explanation, rejected: [rejected.explanation, rejected.tone] }));
    },
  },
  {
    id: 'a-goal-that-could-not-start-shows-the-runtimes-plain-message',
    check() {
      // Deliberately different from the panel's own fallback wording, so ignoring the runtime's message is visible.
      const message = 'The runtime says: no connected tool can do this, so nothing was started.';
      const v = goals().goalView(summary({ status: 'failed', reason: 'nothing_to_do', message, waitingFor: null, tasks: [], results: [] }));
      return verdict(v.tone === 'problem' && v.explanation === message && /could not|nothing/i.test(v.statusLabel), json(v));
    },
  },
  {
    id: 'every-failure-reason-has-a-plain-explanation-even-without-a-message',
    check() {
      const reasons = ['bad_request', 'bad_plan', 'planner_failed', 'nothing_to_do', 'audit_failed', 'already_exists', 'interrupted', 'error', 'something_new'];
      const views = reasons.map((reason) => goals().goalView(summary({ status: 'failed', reason, message: undefined, tasks: [], results: [], waitingFor: null })));
      return verdict(views.every((v) => typeof v.explanation === 'string' && v.explanation.length > 10 && v.tone === 'problem'), json(views.map((v) => v.explanation)));
    },
  },
  {
    id: 'a-run-that-stopped-part-way-says-so-and-warns-an-action-may-have-happened',
    check() {
      const v = goals().goalView(summary({ status: 'failed', reason: 'interrupted', message: undefined, waitingFor: null }));
      return verdict(/part-way|stopped/i.test(v.statusLabel) && /may or may not|check/i.test(v.explanation), json(v));
    },
  },
  {
    id: 'a-goal-that-cannot-be-found-says-so',
    check() {
      const v = goals().goalView(summary({ status: 'unknown', tasks: [], results: [], waitingFor: null }));
      return verdict(/not found|could not be found/i.test(v.statusLabel + v.explanation) && v.tone === 'problem', json(v));
    },
  },

  // ---- The tasks of a goal ----------------------------------------------------------------------------
  {
    id: 'a-waiting-goal-shows-done-tasks-the-waiting-one-and-the-ones-still-to-come',
    check() {
      const v = goals().goalView(summary({ tasks: tasks('Draft', 'Buy', 'Announce'), results: outcomes('ran') }));
      const states = v.tasks.map((t) => t.state);
      return verdict(json(states) === json(['ran', 'waiting', 'upcoming']), json(v.tasks));
    },
  },
  {
    id: 'a-running-goal-shows-the-task-being-worked-on',
    check() {
      const v = goals().goalView(summary({ status: 'running', waitingFor: null, tasks: tasks('Draft', 'Buy'), results: outcomes('ran') }));
      return verdict(json(v.tasks.map((t) => t.state)) === json(['ran', 'working']), json(v.tasks));
    },
  },
  {
    id: 'every-outcome-has-a-label-and-a-tone-and-an-unknown-one-is-not-blank',
    check() {
      const views = ALL_OUTCOMES.map((o) => goals().goalView(summary({ status: 'done', waitingFor: null, tasks: tasks('A'), results: outcomes(o) })).tasks[0]);
      const odd = goals().goalView(summary({ status: 'done', waitingFor: null, tasks: tasks('A'), results: outcomes('brand_new_outcome') })).tasks[0];
      const ok = views.every((t) => t.stateLabel.length > 3) && views[0].tone === 'ok' && ['failed', 'blocked_unknown_tool', 'blocked_card', 'blocked_decision', 'blocked_audit', 'blocked_policy'].every((o) => views[ALL_OUTCOMES.indexOf(o)].tone === 'problem') && views[2].tone === 'neutral' && odd.stateLabel.length > 3;
      return verdict(ok, json({ views: views.map((t) => [t.state, t.tone, t.stateLabel]), odd }));
    },
  },
  {
    id: 'a-task-the-founder-approved-for-an-unknown-tool-says-it-did-not-run',
    check() {
      const t = goals().goalView(summary({ status: 'done', waitingFor: null, tasks: tasks('Use the tool'), results: outcomes('blocked_unknown_tool') })).tasks[0];
      return verdict(/did not run/i.test(t.stateLabel) && /not known|policy/i.test(t.stateLabel), json(t));
    },
  },
  {
    id: 'results-are-matched-to-tasks-by-id-not-by-position',
    check() {
      const v = goals().goalView(summary({ status: 'done', waitingFor: null, tasks: tasks('A', 'B'), results: [{ taskId: 't2', title: 'B', outcome: 'failed' }, { taskId: 't1', title: 'A', outcome: 'ran' }] }));
      return verdict(json(v.tasks.map((t) => [t.taskId, t.state])) === json([['t1', 'ran'], ['t2', 'failed']]), json(v.tasks));
    },
  },

  // ---- Text and odd input ------------------------------------------------------------------------------
  {
    id: 'a-goal-with-no-text-yet-gets-a-placeholder',
    check() {
      const v = goals().goalView(summary({ status: 'running', goal: '', tasks: [], results: [], waitingFor: null }));
      return verdict(v.goal.length > 3 && !/^\s*$/.test(v.goal), json(v.goal));
    },
  },
  {
    id: 'text-is-passed-through-as-it-is-never-turned-into-markup',
    check() {
      const nasty = '<img src=x onerror=alert(1)> & "quotes" <script>x</script>';
      const v = goals().goalView(summary({ goal: nasty, tasks: tasks(nasty), results: [] }));
      return verdict(v.goal === nasty && v.tasks[0].title === nasty, json(v.goal));
    },
  },
  {
    id: 'odd-input-never-throws-and-always-gives-text',
    check() {
      const odd = [null, undefined, 5, 'x', [], {}, { status: 5 }, { status: 'done', tasks: 'x', results: 5 }, { status: 'done', tasks: [null, 5, {}], results: [null, { outcome: 7 }] }, { status: 'failed', message: 5, reason: {} }];
      for (const s of odd) {
        let v;
        try {
          v = goals().goalView(s);
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return verdict(false, `threw on ${json(s)}: ${err.message}`);
        }
        if (typeof v.goal !== 'string' || typeof v.statusLabel !== 'string' || typeof v.explanation !== 'string' || !Array.isArray(v.tasks) || !v.tasks.every((t) => typeof t.title === 'string' && typeof t.stateLabel === 'string')) return verdict(false, `bad view for ${json(s)}: ${json(v)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'the-view-never-changes-the-summary-it-was-given',
    check() {
      const s = summary();
      const freeze = (x) => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); Object.values(x).forEach(freeze); } return x; };
      try {
        goals().goalView(freeze(s));
      } catch (err) {
        if (err.constructor.name === 'PendingError') throw err;
        return verdict(false, `mutated its input: ${err.message}`);
      }
      return verdict(true);
    },
  },

  // ---- Which events refresh the list -------------------------------------------------------------------------------
  {
    id: 'a-new-run-a-pause-a-finish-and-a-failure-all-refresh-the-list',
    check() {
      const { shouldRefetch } = goals();
      const types = ['orchestrator.started', 'orchestrator.waiting', 'orchestrator.finished', 'orchestrator.failed', 'orchestrator.error', 'runtime.ready'];
      return verdict(types.every((type) => shouldRefetch({ type, data: { threadId: 'x' } }) === true), json(types.map((type) => shouldRefetch({ type, data: {} }))));
    },
  },
  {
    id: 'unrelated-events-and-malformed-ones-do-not-refresh-and-never-throw',
    check() {
      const { shouldRefetch } = goals();
      const quiet = ['decision.created', 'decision.resolved', 'decision.cancelled', 'decision.reminded', 'telegram.error', 'policy.tool_changed', 'runtime.degraded', 'something.new'].map((type) => shouldRefetch({ type, data: {} }));
      const bad = [null, undefined, 5, 'x', {}, { type: 5 }, { data: {} }].map((event) => {
        try {
          return shouldRefetch(event);
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return 'threw';
        }
      });
      return verdict(quiet.every((q) => q === false) && bad.every((b) => b === false), json({ quiet, bad }));
    },
  },
  // ---- Downloads ---------------------------------------------------------------------------------
  {
    id: 'a-goal-with-no-files-has-no-download',
    check() {
      const none = goals().goalView(summary({ status: 'done', results: outcomes('ran', 'ran') }));
      const failed = goals().goalView(summary({ status: 'done', results: [{ taskId: 't1', title: 'A', outcome: 'failed', file: { name: 'a.py', content: 'x' } }] }));
      return verdict(none.download === null && none.files.length === 0 && failed.download === null, json({ none: none.download, failed: failed.download }));
    },
  },
  {
    id: 'one-file-is-downloaded-as-itself-with-its-exact-content',
    check() {
      const content = 'def add(a, b):\n    return a + b\n';
      const v = goals().goalView(summary({ status: 'done', results: [{ taskId: 't1', title: 'Write it', outcome: 'ran', file: { name: 'add.py', content } }] }));
      const d = v.download;
      return verdict(d && d.kind === 'file' && d.filename === 'add.py' && /download/i.test(d.label) && d.label.includes('add.py') && d.files.length === 1 && d.files[0].content === content, json(d));
    },
  },
  {
    id: 'several-files-are-downloaded-as-one-zip-named-after-the-goal',
    check() {
      const files = [['a.py', 'one'], ['b.txt', 'two'], ['c.md', 'three']].map(([name, content], i) => ({ taskId: `t${i + 1}`, title: `T${i + 1}`, outcome: 'ran', file: { name, content } }));
      const v = goals().goalView(summary({ status: 'done', goal: 'Build the Landing Page!', tasks: tasks('A', 'B', 'C'), results: files }));
      const d = v.download;
      return verdict(d && d.kind === 'zip' && d.filename === 'build-the-landing-page.zip' && /3 files/i.test(d.label) && d.files.map((f) => f.name).join() === 'a.py,b.txt,c.md', json(d));
    },
  },
  {
    id: 'files-from-tasks-that-did-not-run-are-left-out-and-one-left-means-a-plain-file',
    check() {
      const results = [
        { taskId: 't1', title: 'A', outcome: 'ran', file: { name: 'good.py', content: 'x' } },
        { taskId: 't2', title: 'B', outcome: 'rejected', file: { name: 'no.py', content: 'x' } },
        { taskId: 't3', title: 'C', outcome: 'blocked_card', file: { name: 'no2.py', content: 'x' } },
      ];
      const d = goals().goalView(summary({ status: 'done', tasks: tasks('A', 'B', 'C'), results })).download;
      return verdict(d && d.kind === 'file' && d.filename === 'good.py', json(d));
    },
  },
  {
    id: 'two-files-with-the-same-name-both-survive-in-the-zip',
    check() {
      const results = [1, 2, 3].map((n) => ({ taskId: `t${n}`, title: `T${n}`, outcome: 'ran', file: { name: 'script.py', content: `v${n}` } }));
      const d = goals().goalView(summary({ status: 'done', tasks: tasks('A', 'B', 'C'), results })).download;
      const names = d.files.map((f) => f.name);
      return verdict(new Set(names).size === 3 && names[0] === 'script.py' && d.files.map((f) => f.content).join() === 'v1,v2,v3' && names.every((n) => /\.py$/.test(n)), json(names));
    },
  },
  {
    id: 'unsafe-or-odd-file-entries-are-never-offered-and-never-throw',
    check() {
      const odd = [null, 'x', 5, [], {}, { name: 'a.py' }, { name: 5, content: 'x' }, { name: 'a.py', content: 5 }, { name: '', content: 'x' }, { name: '..', content: 'x' }];
      for (const file of odd) {
        let d;
        try {
          d = goals().goalView(summary({ status: 'done', results: [{ taskId: 't1', title: 'A', outcome: 'ran', file }] })).download;
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return verdict(false, `threw on ${json(file)}: ${err.message}`);
        }
        if (d !== null) return verdict(false, `offered ${json(file)}: ${json(d)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'a-file-name-with-a-path-is-reduced-to-a-plain-name-in-the-download',
    check() {
      const results = [{ taskId: 't1', title: 'A', outcome: 'ran', file: { name: '../../etc/passwd', content: 'x' } }, { taskId: 't2', title: 'B', outcome: 'ran', file: { name: 'dir\\evil.bat', content: 'y' } }];
      const d = goals().goalView(summary({ status: 'done', tasks: tasks('A', 'B'), results })).download;
      return verdict(d && d.files.map((f) => f.name).join() === 'passwd,evil.bat' && !/[\\/]/.test(d.filename), json(d));
    },
  },
  {
    id: 'a-goal-still-working-offers-the-files-made-so-far',
    check() {
      const v = goals().goalView(summary({ status: 'waiting', results: [{ taskId: 't1', title: 'A', outcome: 'ran', file: { name: 'first.py', content: 'x' } }] }));
      return verdict(v.download && v.download.filename === 'first.py', json(v.download));
    },
  },

];

module.exports = {
  name: 'goals-view',
  description: 'Goals panel logic: what a goal and its tasks show, honest about what did not go ahead, and which events refresh the list',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
