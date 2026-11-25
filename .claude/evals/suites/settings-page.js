'use strict';

// Grades the Settings page (PLAN.md step 4.3). "Done when: changing a limit takes effect without a restart."
//   src/runtime/settings.js       createSettings({ store, audit, guardrails, approval?, policyTools?, isBlocked?, emit?, onError? })
//     .get()                       -> { limits, stoppedTeams, scaling: [rule rows], approvals, tools }
//     .setLimits({ maxTasksPerDay?, loopRepeats? })                    -> { limits }          (the work is in guardrails.setLimits)
//     .setScaling({ team, role, max_agents?, scale_up_queue_threshold?, scale_up_wait_minutes?, idle_minutes_before_removal?, enabled? }) -> { rule }
//   src/runtime/guardrails.js     .setLimits({ maxTasksPerDay?, loopRepeats? })  strict bounds, audited first, saved in `app_settings`
//   src/runtime/commands.js       settings.get, settings.setLimits, settings.setScaling
//   src/renderer/settings.mjs     settingsView(data), limitsFormView(form), scalingFormView(row)  (the logic behind SettingsPanel.jsx)
//   src/preload.js                window.api.settings.*
//
// The Settings page edits: the limits (a daily task cap per agent, how many repeats make a loop), the scaling rules (the agent cap of each team and role,
// and when to add or remove one), and it shows the team switches. The founder's approval period for outbound messages is shown but NOT editable here:
// ending it loosens the rules, so it stays a deliberate change of the `.env` file.
//
// Runs against a REAL Postgres with the real migrations (a fresh one per case), the real agent loop, guardrails, autoscaler and decisions service.
//
//   - the done-when: a changed limit is used by the very next step (no restart), by the autoscaler's next pass, and by a second process after a few seconds
//   - values are checked in code and refused outside their bounds (never silently clamped); an unknown option is refused
//   - every change is audited first, with the old and the new value, and when it cannot be, or the runtime is blocked, nothing changes
//   - a rule is saved once (no duplicate rows), a partial change keeps the other values, and a disabled rule switches that group off

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
let counter = 0;
const unique = (label) => `${label}${Date.now().toString(36)}${counter++}`;
const finish = (output = 'All done.') => JSON.stringify({ action: 'finish', output });
const tool = (name, access, args = {}) => JSON.stringify({ action: 'tool', tool: name, access, args });

async function rig(over = {}) {
  const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
  const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
  const { createAudit } = require(path.join(ROOT, 'src/runtime/audit'));
  const { createGuardrails } = loadSubject('src/runtime/guardrails.js');
  const { createSettings } = loadSubject('src/runtime/settings.js');
  const { createAutoscaler } = loadSubject('src/runtime/autoscaler.js');
  const { createDecisionService } = loadSubject('src/runtime/decisions.js');
  const policy = require(path.join(ROOT, 'src/runtime/policy'));
  const fake = await startFakeSupabase();
  const store = createRestStore({ url: fake.url, serviceKey: fake.serviceKey });
  const real = createAudit(store);
  const audit = over.audit ?? real;
  const emitted = [];
  const errors = [];
  const emit = (type, data) => emitted.push({ type, data });
  const clock = { t: Date.now() };
  const guardrails = createGuardrails({ store, audit, isBlocked: over.isBlocked, emit, now: () => new Date(clock.t), cacheMs: 0 });
  const settings = createSettings({ store, audit, guardrails, approval: over.approval, policyTools: over.policyTools, isBlocked: over.isBlocked, emit, onError: (e) => errors.push(e) });
  const decisions = createDecisionService({ store, audit: real, emit, isBlocked: () => null, policy });
  const scaler = createAutoscaler({ store, audit: real, decisions, emit, now: () => new Date(clock.t), onError: (e) => errors.push(e) });
  const agent = (name, extra = {}) => store.insert('agents', { name, team: 'support', role: 'worker', ...extra });
  const tasks = async (n, agentRow) => { for (let i = 0; i < n; i += 1) await store.insert('tasks', { team: 'support', title: unique('Task'), status: 'queued', assigned_agent_id: agentRow.id }); };
  const fail = async (promise) => { try { await promise; return null; } catch (err) { return { code: err.code, name: err.name, message: String(err.message) }; } };
  const rules = async () => store.select('scaling_rules', { where: {}, limit: 100 });
  const audits = async (action) => (await store.select('audit_log', { where: { action }, order: 'id.asc', limit: 200 }));
  return { fake, store, audit, real, guardrails, settings, scaler, decisions, emit, emitted, errors, clock, agent, tasks, fail, rules, audits, done: () => fake.close() };
}

const cases = [
  {
    id: 'a-the-page-reads-the-limits-the-rules-the-team-switches-the-approval-period-and-the-added-tools-with-their-defaults',
    async run() {
      const tools = [{ tool: 'acme.lookup', kind: 'ask', category: 'spend', access: null, status: 'active' }, { tool: 'old.tool', kind: 'ask', category: 'spend', access: null, status: 'removed' }, { tool: 'x.y', kind: 'routine', category: null, access: 'read', status: 'proposed' }];
      const x = await rig({ approval: { until: new Date('2026-12-09T00:00:00.000Z'), problem: null }, policyTools: { list: async () => tools } });
      try {
        const first = await x.settings.get();
        await x.store.insert('scaling_rules', { scope: 'global', team: 'support', role: 'worker', max_agents: 2, scale_up_queue_threshold: 3, scale_up_wait_minutes: 20, idle_minutes_before_removal: 5, enabled: true });
        await x.guardrails.stopTeam({ team: 'finance_legal_ops', stopped: true });
        const second = await x.settings.get();
        const row = (data, team, role) => data.scaling.find((r) => r.team === team && r.role === role);
        const none = await rig({ approval: { until: null, problem: 'garbled' } });
        const always = (await none.settings.get()).approvals;
        await none.done();
        return verdict(first.limits.maxTasksPerDay === 40 && first.limits.loopRepeats === 3 && first.scaling.length === 8 && row(first, 'support', 'worker').source === 'default' && row(first, 'support', 'worker').max_agents === 6
          && row(second, 'support', 'worker').source === 'table' && row(second, 'support', 'worker').max_agents === 2 && row(second, 'support', 'worker').scale_up_queue_threshold === 3 && json(second.stoppedTeams) === json(['finance_legal_ops'])
          && second.approvals.outbound.mode === 'until' && second.approvals.outbound.until === '2026-12-09' && second.approvals.editableHere === false && always.outbound.mode === 'always' && always.outbound.until === null
          && second.tools.length === 2 && second.tools.every((t) => t.status !== 'removed') && !first.scaling.some((r) => r.team === 'orchestrator'),
          `limits ${json(first.limits)}; scaling ${first.scaling.length}; support worker ${json(row(second, 'support', 'worker'))}; stopped ${json(second.stoppedTeams)}; approvals ${json(second.approvals)} / ${json(always)}; tools ${second.tools.length}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'b-done-when-a-changed-limit-is-used-by-the-very-next-step-and-by-a-second-process-with-no-restart',
    async run() {
      const x = await rig();
      try {
        const { createAgent } = loadSubject('src/runtime/agents/agent.js');
        const { createToolLoader } = loadSubject('src/runtime/tools/index.js');
        const policy = require(path.join(ROOT, 'src/runtime/policy'));
        const loader = createToolLoader({ tools: [{ name: 'fetch.get', access: 'read', summary: 'x', args: '{}', checkArgs: () => null, run: async () => { throw new Error('x'); } }, { name: 'docs.create_draft', access: 'write', summary: 'x', args: '{}', checkArgs: () => null, run: async () => ({ text: 'ok' }) }], hasRule: async () => true });
        await loader.load();
        const worker = async (row, replies) => {
          const queue = [...replies];
          const requests = [];
          const router = { requests, async complete(r) { requests.push(r); return { ok: true, text: queue.length > 1 ? queue.shift() : queue[0] }; }, endTask() {} };
          return { requests, agent: createAgent({ id: row.id, name: row.name, role: 'worker', team: 'support', instructions: 'S', router, tools: loader, policy, audit: x.real, limits: { maxSteps: 12 }, guard: x.guardrails }) };
        };
        const task = { taskId: 't-1', title: 'T', instructions: 'Do it.' };
        const a = await x.agent(unique('A'));
        const before = await worker(a, [tool('fetch.get', 'read', {})]);
        const r1 = await before.agent.run(task); // the default: three identical calls make a loop
        const set = await x.settings.setLimits({ loopRepeats: 2 });
        const b = await x.agent(unique('B'));
        const after = await worker(b, [tool('fetch.get', 'read', {})]);
        const r2 = await after.agent.run(task); // the very next run: two make a loop
        // The daily cap.
        await x.settings.setLimits({ maxTasksPerDay: 1 });
        const c = await x.agent(unique('C'));
        const one = await (await worker(c, [finish()])).agent.run(task);
        const wk = await worker(c, [finish()]);
        const two = await wk.agent.run(task);
        // A second process (another guard on the same database).
        const { createGuardrails } = loadSubject('src/runtime/guardrails.js');
        const elsewhere = createGuardrails({ store: x.store, audit: x.real, cacheMs: 0 });
        const seen = await elsewhere.limits();
        return verdict(r1.reason === 'loop' && before.requests.length === 3 && set.limits.loopRepeats === 2 && r2.reason === 'loop' && after.requests.length === 2 && one.status === 'done' && two.reason === 'daily_cap' && wk.requests.length === 0
          && seen.maxTasksPerDay === 1 && seen.loopRepeats === 2, `default loop at ${before.requests.length}; after the change at ${after.requests.length}; daily ${json([one.status, two.reason])}; second process ${json(seen)}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'c-limits-are-held-to-their-bounds-never-clamped-audited-first-with-the-old-and-new-value-and-nothing-changes-without-an-audit-entry',
    async run() {
      const x = await rig();
      const down = await rig({ audit: { append: async () => { throw new Error('database down'); } } });
      const blocked = await rig({ isBlocked: () => 'The runtime is blocked for a test.' });
      try {
        const bad = [null, 'x', {}, { maxTasksPerDay: 0 }, { maxTasksPerDay: 1001 }, { maxTasksPerDay: 2.5 }, { maxTasksPerDay: '10' }, { loopRepeats: 1 }, { loopRepeats: 11 }, { loopRepeats: null }, { extra: 1 }, { maxTasksPerDay: 5, extra: 1 }];
        const refused = [];
        for (const input of bad) {
          const err = await x.fail(x.settings.setLimits(input));
          if (!err || !['GuardrailsError', 'SettingsError'].includes(err.name)) refused.push(json(input));
        }
        const okOne = await x.settings.setLimits({ maxTasksPerDay: 25 });
        const okTwo = await x.settings.setLimits({ loopRepeats: 4 });
        const same = await x.settings.setLimits({ loopRepeats: 4 });
        const entries = await x.audits('settings.limits_changed');
        const status = await x.guardrails.status();
        const downErr = await down.fail(down.settings.setLimits({ maxTasksPerDay: 7 }));
        const blockedErr = await blocked.fail(blocked.settings.setLimits({ maxTasksPerDay: 7 }));
        const downRows = await down.store.select('app_settings', { where: {}, limit: 5 });
        return verdict(refused.length === 0 && okOne.limits.maxTasksPerDay === 25 && okOne.limits.loopRepeats === 3 && okTwo.limits.maxTasksPerDay === 25 && okTwo.limits.loopRepeats === 4 && same.changed === false
          && entries.length === 2 && entries[0].detail.from.maxTasksPerDay === 40 && entries[0].detail.to.maxTasksPerDay === 25 && entries[1].detail.from.loopRepeats === 3 && entries[1].detail.to.loopRepeats === 4
          && status.limits.maxTasksPerDay === 25 && downErr?.code === 'audit_unavailable' && !/database down/.test(downErr.message) && blockedErr?.code === 'blocked' && downRows.length === 0,
          `accepted ${json(refused)}; entries ${json(entries.map((e) => e.detail))}; status ${json(status.limits)}; down ${json(downErr)}; blocked ${json(blockedErr)}; rows after a refused change ${downRows.length}`);
      } finally { await x.done(); await down.done(); await blocked.done(); }
    },
  },
  {
    id: 'd-done-when-a-changed-agent-cap-is-used-by-the-autoscalers-next-pass-and-a-disabled-rule-switches-that-group-off',
    async run() {
      const x = await rig();
      try {
        const aria = await x.agent('Aria');
        await x.tasks(12, aria);
        const first = await x.settings.setScaling({ team: 'support', role: 'worker', max_agents: 1, scale_up_queue_threshold: 4 });
        const atCap = await x.scaler.tick(); // one agent, the cap is one: a card, no new agent
        const agentsBefore = (await x.store.select('agents', { where: { team: 'support' }, limit: 50 })).length;
        await x.settings.setScaling({ team: 'support', role: 'worker', max_agents: 3 }); // no restart
        const raised = await x.scaler.tick();
        const agentsAfter = (await x.store.select('agents', { where: { team: 'support' }, limit: 50 })).length;
        await x.settings.setScaling({ team: 'support', role: 'worker', enabled: false });
        const off = await x.scaler.tick();
        const status = await x.scaler.status();
        const table = await x.rules();
        const kept = table.find((r) => r.team === 'support' && r.role === 'worker');
        return verdict(first.rule.max_agents === 1 && atCap.added.length === 0 && atCap.carded.length === 1 && agentsBefore === 1 && raised.added.length === 1 && agentsAfter === 2 && off.added.length === 0 && off.carded.length === 0
          && !status.some((g) => g.team === 'support' && g.role === 'worker') && table.length === 1 && kept.max_agents === 3 && kept.scale_up_queue_threshold === 4 && kept.enabled === false,
          `first ${json(first.rule)}; at the cap ${json([atCap.added.length, atCap.carded.length])}; raised ${json([raised.added.length, agentsAfter])}; disabled ${json([off.added.length, off.carded.length])}; rows ${table.length}; kept ${json(kept)}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'e-a-rule-is-saved-once-a-partial-change-keeps-the-rest-values-are-checked-and-every-change-is-audited-first',
    async run() {
      const x = await rig();
      const down = await rig({ audit: { append: async () => { throw new Error('database down'); } } });
      const blocked = await rig({ isBlocked: () => 'The runtime is blocked for a test.' });
      try {
        const bad = [null, {}, { team: 'support' }, { role: 'worker' }, { team: 'orchestrator', role: 'worker', max_agents: 2 }, { team: 'nope', role: 'worker', max_agents: 2 }, { team: 'support', role: 'lead', max_agents: 2 },
          { team: 'support', role: 'worker' }, { team: 'support', role: 'worker', max_agents: 0 }, { team: 'support', role: 'worker', max_agents: 51 }, { team: 'support', role: 'worker', max_agents: 2.5 }, { team: 'support', role: 'worker', max_agents: '3' },
          { team: 'support', role: 'worker', scale_up_queue_threshold: 0 }, { team: 'support', role: 'worker', scale_up_wait_minutes: 10081 }, { team: 'support', role: 'worker', idle_minutes_before_removal: 0 }, { team: 'support', role: 'worker', enabled: 'yes' },
          { team: 'support', role: 'worker', max_agents: 2, extra: 1 }, { team: 'support', role: 'worker', scope: 'pod', max_agents: 2 }];
        const refused = [];
        for (const input of bad) {
          const err = await x.fail(x.settings.setScaling(input));
          if (!err || err.name !== 'SettingsError') refused.push(json(input));
        }
        const rowsAfterBad = (await x.rules()).length;
        const made = await x.settings.setScaling({ team: 'marketing_sales', role: 'specialist', max_agents: 4 });
        const changed = await x.settings.setScaling({ team: 'marketing_sales', role: 'specialist', scale_up_wait_minutes: 15 });
        const again = await x.settings.setScaling({ team: 'marketing_sales', role: 'specialist', scale_up_wait_minutes: 15 });
        const table = await x.rules();
        const entries = await x.audits('scaling.rule_changed');
        const downErr = await down.fail(down.settings.setScaling({ team: 'support', role: 'worker', max_agents: 2 }));
        const blockedErr = await blocked.fail(blocked.settings.setScaling({ team: 'support', role: 'worker', max_agents: 2 }));
        return verdict(refused.length === 0 && rowsAfterBad === 0 && made.rule.max_agents === 4 && made.rule.scale_up_queue_threshold === 5 && changed.rule.max_agents === 4 && changed.rule.scale_up_wait_minutes === 15 && again.changed === false
          && table.length === 1 && table[0].scope === 'global' && entries.length === 2 && entries[1].detail.from.scale_up_wait_minutes === 30 && entries[1].detail.to.scale_up_wait_minutes === 15
          && downErr?.code === 'audit_unavailable' && !/database down/.test(downErr.message) && (await down.rules()).length === 0 && blockedErr?.code === 'blocked' && (await blocked.rules()).length === 0,
          `accepted ${json(refused)}; rows after bad ${rowsAfterBad}; made ${json(made.rule)}; changed ${json(changed.rule)}; rows ${table.length}; entries ${entries.length}; down ${json(downErr)}; blocked ${json(blockedErr)}`);
      } finally { await x.done(); await down.done(); await blocked.done(); }
    },
  },
  {
    id: 'f-the-approval-period-can-be-seen-but-not-changed-from-the-page-and-the-commands-are-exactly-three',
    async run() {
      const x = await rig();
      try {
        const { createRuntime } = loadSubject('src/runtime/runtime.js');
        const { registerCommands } = loadSubject('src/runtime/commands.js');
        const entries = [];
        const runtime = createRuntime({ audit: { append: async (e) => { entries.push(e); } } });
        registerCommands(runtime, { store: x.store, settings: x.settings });
        const bare = createRuntime({ audit: { append: async () => {} } });
        registerCommands(bare, { store: x.store });
        const call = (rt, name, args) => rt.invoke(name, args, { actor: 'founder' });
        const names = runtime.commands().filter((c) => c.startsWith('settings.')).sort();
        const got = await call(runtime, 'settings.get', {});
        const lim = await call(runtime, 'settings.setLimits', { loopRepeats: 5 });
        const rule = await call(runtime, 'settings.setScaling', { team: 'support', role: 'worker', max_agents: 5 });
        const bad = [await call(runtime, 'settings.get', { x: 1 }), await call(runtime, 'settings.setLimits', {}), await call(runtime, 'settings.setLimits', { loopRepeats: 'many' }), await call(runtime, 'settings.setLimits', { approvalUntil: '2020-01-01' }),
          await call(runtime, 'settings.setScaling', { team: 'support' }), await call(runtime, 'settings.setScaling', { team: 'support', role: 'worker', max_agents: 'x' }), await call(runtime, 'settings.setScaling', { team: 'support', role: 'worker', max_agents: 100 })];
        const offline = [await call(bare, 'settings.get', {}), await call(bare, 'settings.setLimits', { loopRepeats: 3 }), await call(bare, 'settings.setScaling', { team: 'support', role: 'worker', max_agents: 2 })];
        const source = read('src/runtime/settings.js');
        const touchesApproval = /OUTBOUND_FOUNDER_APPROVAL_UNTIL|approvalUntil\s*[:=]|setApproval/.test(source.replace(/\/\/.*$/gm, ''));
        return verdict(json(names) === json(['settings.get', 'settings.setLimits', 'settings.setScaling']) && got.ok && got.data.approvals.editableHere === false && lim.ok && rule.ok && bad.every((r) => r.ok === false) && offline.every((r) => r.ok === false && r.error.code === 'not_available') && !touchesApproval
          && entries.some((e) => e.action === 'command.settings.setScaling'), `names ${json(names)}; bad ${json(bad.map((r) => r.error?.code))}; offline ${json(offline.map((r) => r.error?.code))}; approval touched ${touchesApproval}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'g-the-pages-logic-words-the-settings-and-checks-the-forms-before-anything-is-sent',
    async run() {
      const mod = await loadSubject('src/renderer/settings.mjs');
      const data = { limits: { maxTasksPerDay: 40, loopRepeats: 3 }, stoppedTeams: ['support'], approvals: { outbound: { mode: 'until', until: '2026-12-09' }, editableHere: false }, tools: [{ tool: 'acme.lookup', kind: 'ask', category: 'spend', access: null, status: 'active' }],
        scaling: [{ team: 'support', role: 'worker', max_agents: 6, scale_up_queue_threshold: 5, scale_up_wait_minutes: 30, idle_minutes_before_removal: 60, enabled: true, source: 'default' }, { team: 'orchestrator', role: 'worker', max_agents: 1, source: 'table' }, null] };
      const view = mod.settingsView(data);
      const limits = mod.limitsFormView({ maxTasksPerDay: ' 25 ', loopRepeats: '' });
      const limitsBad = [mod.limitsFormView({ maxTasksPerDay: '0', loopRepeats: '3' }), mod.limitsFormView({ maxTasksPerDay: 'many', loopRepeats: '3' }), mod.limitsFormView({ maxTasksPerDay: '', loopRepeats: '' }), mod.limitsFormView(null)];
      const rule = mod.scalingFormView({ team: 'support', role: 'worker', max_agents: '8', scale_up_queue_threshold: '', scale_up_wait_minutes: '45', idle_minutes_before_removal: '', enabled: false });
      const ruleBad = [mod.scalingFormView({ team: 'support', role: 'worker', max_agents: '0' }), mod.scalingFormView({ team: 'support', role: 'worker', max_agents: '51' }), mod.scalingFormView({ team: 'support', role: 'worker', max_agents: '2.5' }), mod.scalingFormView(null)];
      return verdict(view.scaling.length === 1 && view.scaling[0].teamLabel === 'Customer Support' && view.scaling[0].roleLabel === 'Workers' && view.scaling[0].sourceNote === 'the built-in default' && /9 December 2026/.test(view.approvalLine) && /\.env/.test(view.approvalNote)
        && view.stopped.length === 1 && view.stopped[0] === 'Customer Support' && view.tools.length === 1 && view.limits.length === 2
        && limits.ok && json(limits.args) === json({ maxTasksPerDay: 25 }) && limitsBad.every((r) => r.ok === false && typeof r.problem === 'string')
        && rule.ok && json(rule.args) === json({ team: 'support', role: 'worker', max_agents: 8, scale_up_wait_minutes: 45, enabled: false }) && ruleBad.every((r) => r.ok === false && typeof r.problem === 'string'),
        `view ${json(view).slice(0, 300)}; limits ${json(limits)}; rule ${json(rule)}`);
    },
  },
  {
    id: 'h-the-page-shows-text-only-has-no-timer-and-the-app-and-preload-wire-it-in',
    check() {
      const panel = fs.existsSync(path.join(ROOT, 'src/renderer/SettingsPanel.jsx')) ? read('src/renderer/SettingsPanel.jsx') : '';
      const app = read('src/renderer/App.jsx');
      const preload = read('src/preload.js');
      const runtime = read('src/runtime/index.js');
      const problems = [
        ...(/dangerouslySetInnerHTML|innerHTML/.test(panel) ? ['the page builds markup'] : []),
        ...(/setInterval/.test(panel) ? ['the page has a timer'] : []),
        ...(/window\.api\.settings\.get/.test(panel) && /window\.api\.settings\.setLimits/.test(panel) && /window\.api\.settings\.setScaling/.test(panel) ? [] : ['the page does not use the three settings functions']),
        ...(/SettingsPanel/.test(app) ? [] : ['App.jsx does not show the page']),
        ...(/settings:\s*\{/.test(preload) && /settings\.get/.test(preload) && /settings\.setLimits/.test(preload) && /settings\.setScaling/.test(preload) ? [] : ['the preload lacks the settings functions']),
        ...(/createSettings\(/.test(runtime) && /settings,/.test(runtime) ? [] : ['createApp does not build and register the settings']),
      ];
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
];

module.exports = {
  name: 'settings-page',
  description: 'The Settings page (step 4.3): limits and scaling rules edited live, team switches, the approval period shown but not editable, all audited',
  threshold: 1.0,
  cases: () => cases,
  async run(c) {
    return c.check ? c.check() : c.run();
  },
};
