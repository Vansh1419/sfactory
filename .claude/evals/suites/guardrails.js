'use strict';

// Grades guardrails (PLAN.md step 4.2). "Done when: a looping fake agent is stopped by the caps, and /pause stops an agent mid-task."
//   src/runtime/guardrails.js    createGuardrails({ store, audit, isBlocked?, emit?, now?, onError?, cacheMs? })
//     .limits()                         -> { maxTasksPerDay, loopRepeats }       live from `app_settings` ('guardrails'), checked in code, defaults when missing or odd
//     .teamStopped(team)                -> boolean
//     .stopTeam({ team, stopped })      -> { team, stopped, changed }            the founder's kill switch for a whole team; audited first
//     .startRun({ agentId, agentName, team, taskId }) -> { ok: true } | { ok: false, reason: 'daily_cap' | 'audit_failed' }
//     .status()                         -> { limits, stoppedTeams }
//   src/runtime/agents/agent.js    createAgent({ ..., guard? }): a daily cap per agent, loop detection, and a stopped team ends a run at its next step
//   src/runtime/agents/team.js     createTeam({ ..., guard? }): a stopped team takes no new task
//   src/runtime/telegram/bot.js    /pause <agent>, /resume <agent>, /pause team <team>, /resume team <team>
//   src/runtime/commands.js        guardrails.status, guardrails.stopTeam;  src/renderer/TeamsPanel.jsx: a switch for each team
//   supabase/migrations/20261128000000_app_settings.sql   the `app_settings` table (service key only)
//
// Real Postgres with the migrations (a fresh one per case), the real agent loop and policy, with a scripted model.
//
//   - the step and token caps still stop an agent whose every call is different; an agent that repeats itself is stopped sooner, by loop detection
//   - a daily task cap per agent (counted in India's day, from the audit log), read live, so changing it needs no restart
//   - a kill switch for a team: its running agents stop at their next step, it takes no new task, and the switch is remembered by every process
//   - `/pause` on the phone stops an agent in the middle of a task; `/resume` lets it go on
//   - everything is audited first; when it cannot be, or the runtime is blocked, nothing changes; a missing settings table gives the defaults, never a crash

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const FOUNDER = 4242;
let counter = 0;
const unique = (label) => `${label}${Date.now().toString(36)}${counter++}`;
const finish = (output = 'All done.') => JSON.stringify({ action: 'finish', output });
const tool = (name, access, args = {}) => JSON.stringify({ action: 'tool', tool: name, access, args });
const TASK = { taskId: 't-1', title: 'Write a short reply', instructions: 'Thank the customer.' };

function scripted(replies, { repeatLast = false } = {}) {
  const requests = [];
  const queue = [...replies];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const next = queue.length > 1 || !repeatLast ? queue.shift() : queue[0];
      if (next === undefined) return { ok: false, reason: 'all_providers_failed' };
      return { ok: true, text: typeof next === 'function' ? next(request) : next, provider: 'fake', model: 'fake', costUsd: 0, attempts: 1 };
    },
    endTask() {},
  };
}

async function rig(over = {}) {
  const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
  const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
  const { createAudit } = require(path.join(ROOT, 'src/runtime/audit'));
  const { createGuardrails } = loadSubject('src/runtime/guardrails.js');
  const { createAgent } = loadSubject('src/runtime/agents/agent.js');
  const { createAgentEvents } = loadSubject('src/runtime/agents/events.js');
  const { createAgentControl } = loadSubject('src/runtime/agents/control.js');
  const { createToolLoader } = loadSubject('src/runtime/tools/index.js');
  const policy = require(path.join(ROOT, 'src/runtime/policy'));
  const fake = await startFakeSupabase();
  const store = createRestStore({ url: fake.url, serviceKey: fake.serviceKey });
  const audit = over.audit ?? createAudit(store);
  const clock = { t: Date.parse('2026-11-26T05:00:00.000Z') }; // 10:30 in India
  const emitted = [];
  const errors = [];
  const emit = (type, data) => emitted.push({ type, data });
  const guard = createGuardrails({ store: over.store ?? store, audit, isBlocked: over.isBlocked, emit, now: () => new Date(clock.t), onError: (e) => errors.push(e), cacheMs: over.cacheMs ?? 0 });
  const events = createAgentEvents({ store, emit });
  const control = createAgentControl({ store, audit, events, emit, isBlocked: over.isBlocked });
  const setSettings = (value) => store.insert('app_settings', { key: 'guardrails', value }).catch(() => store.update('app_settings', { key: 'guardrails' }, { value }));
  const agentRow = (extra = {}) => store.insert('agents', { name: unique('Agent'), team: 'support', role: 'worker', ...extra });
  const feed = async (id) => (await store.select('agent_events', { where: { agent_id: id }, order: 'id.asc', limit: 200 })).map((e) => [e.kind, e.summary]);
  const hooks = { onDraft: null };
  async function worker(row, replies, extra = {}) {
    const seen = [];
    const make = (name, access, run) => ({ name, access, summary: `The ${name} tool.`, args: '{ "title": text }', checkArgs: () => null, run: async (request) => { seen.push(name); return run(request); } });
    const tools = [
      make('docs.create_draft', 'write', async () => { await hooks.onDraft?.(); return { text: 'Draft saved.' }; }),
      make('filesystem.read_file', 'read', async () => ({ text: 'the file text' })),
      make('fetch.get', 'read', async () => { throw new Error('PRIVATE'); }),
    ];
    const loader = createToolLoader({ tools, hasRule: async () => true });
    await loader.load();
    const router = scripted(replies, { repeatLast: extra.repeatLast });
    const agent = createAgent({ id: row.id, name: row.name, role: 'worker', team: row.team, instructions: 'SKILLS', router, tools: loader, policy, audit, limits: extra.limits, events, control, guard: extra.noGuard ? undefined : guard });
    return { agent, router, seen };
  }
  return { fake, store, audit, guard, events, control, emitted, errors, clock, setSettings, agentRow, feed, worker, hooks, emit, done: () => fake.close() };
}

const cases = [
  {
    id: 'a-done-when-the-caps-stop-an-agent-that-never-stops-and-loop-detection-stops-one-that-repeats-itself-sooner',
    async run() {
      const x = await rig();
      try {
        const a = await x.agentRow();
        // Every call different, forever: only the caps can stop it.
        let n = 0;
        const varied = await x.worker(a, [() => tool('docs.create_draft', 'write', { title: `draft ${n += 1}` })], { repeatLast: true, limits: { maxSteps: 6 } });
        const capped = await varied.agent.run(TASK);
        const b = await x.agentRow();
        const tokens = await x.worker(b, [() => tool('docs.create_draft', 'write', { title: `draft ${n += 1}` })], { repeatLast: true, limits: { maxSteps: 20, maxTokens: 700 } });
        const tokenCapped = await tokens.agent.run(TASK);
        // The same call with the same result, again and again.
        const c = await x.agentRow();
        const same = await x.worker(c, [tool('fetch.get', 'read', { url: 'https://example.com' })], { repeatLast: true, limits: { maxSteps: 20 } });
        const looped = await same.agent.run(TASK);
        // Two calls taking turns.
        const d = await x.agentRow();
        const alt = await x.worker(d, [tool('docs.create_draft', 'write', { title: 'a' }), tool('filesystem.read_file', 'read', { path: 'x' }), tool('docs.create_draft', 'write', { title: 'a' }), tool('filesystem.read_file', 'read', { path: 'x' }), tool('docs.create_draft', 'write', { title: 'a' })], { limits: { maxSteps: 20 } });
        const cycled = await alt.agent.run(TASK);
        return verdict(capped.status === 'stopped' && capped.reason === 'step_cap' && varied.router.requests.length === 6 && tokenCapped.status === 'stopped' && tokenCapped.reason === 'token_cap'
          && looped.status === 'stopped' && looped.reason === 'loop' && same.router.requests.length === 3 && cycled.status === 'stopped' && cycled.reason === 'loop' && alt.router.requests.length === 4,
          `varied ${json([capped.reason, varied.router.requests.length])}; tokens ${tokenCapped.reason}; same ${json([looped.reason, same.router.requests.length])}; cycle ${json([cycled.reason, alt.router.requests.length])}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'b-a-repeat-that-is-not-a-loop-is-left-alone-and-the-loop-limit-is-a-live-setting',
    async run() {
      const x = await rig();
      try {
        const a = await x.agentRow();
        // The same call, but the result changes: that is polling, not a loop.
        let seen = 0;
        const polling = await x.worker(a, [tool('docs.create_draft', 'write', { title: 'same' }), tool('docs.create_draft', 'write', { title: 'same' }), tool('filesystem.read_file', 'read', { path: 'x' }), tool('docs.create_draft', 'write', { title: 'same' }), finish('Done.')]);
        const fine = await polling.agent.run(TASK);
        const b = await x.agentRow();
        const different = await x.worker(b, [tool('docs.create_draft', 'write', { title: 'one' }), tool('docs.create_draft', 'write', { title: 'two' }), tool('docs.create_draft', 'write', { title: 'three' }), finish('Done.')]);
        const fine2 = await different.agent.run(TASK);
        // The limit is read live: with 2, two identical calls in a row stop it, with no restart.
        await x.setSettings({ loopRepeats: 2 });
        const c = await x.agentRow();
        const strict = await x.worker(c, [tool('fetch.get', 'read', {}), tool('fetch.get', 'read', {}), finish('never')], { limits: { maxSteps: 10 } });
        const stopped = await strict.agent.run(TASK);
        const odd = [0, 1, -3, 'many', 999].map(() => null);
        await x.setSettings({ loopRepeats: 1 });
        const limitsOdd = await x.guard.limits();
        return verdict(fine.status === 'done' && fine2.status === 'done' && stopped.status === 'stopped' && stopped.reason === 'loop' && strict.router.requests.length === 2 && limitsOdd.loopRepeats === 3 && odd.length === 5 && seen === 0,
          `polling ${fine.status}; different ${fine2.status}; strict ${json([stopped.reason, strict.router.requests.length])}; limits with a nonsense value ${json(limitsOdd)}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'c-a-daily-task-cap-per-agent-counted-in-the-audit-log-in-indias-day-and-read-live',
    async run() {
      const x = await rig();
      try {
        await x.setSettings({ maxTasksPerDay: 2 });
        const a = await x.agentRow();
        const b = await x.agentRow();
        const run = async (row) => {
          const w = await x.worker(row, [finish('ok')]);
          const r = await w.agent.run(TASK);
          return { r, asked: w.router.requests.length };
        };
        const one = await run(a);
        const two = await run(a);
        const three = await run(a); // over the cap: the model is not asked
        const other = await run(b); // another agent has its own count
        await x.setSettings({ maxTasksPerDay: 3 });
        const raised = await run(a); // read live
        const after = await run(a);
        x.clock.t += 24 * 3_600_000; // the next day in India
        const next = await run(a);
        const rows = await x.store.select('audit_log', { where: { action: 'agent.run_started' }, limit: 100 });
        const refused = await x.store.select('audit_log', { where: { action: 'agent.run_refused' }, limit: 100 });
        const feed = await x.feed(a.id);
        return verdict(one.r.status === 'done' && two.r.status === 'done' && three.r.status === 'stopped' && three.r.reason === 'daily_cap' && three.asked === 0 && other.r.status === 'done'
          && raised.r.status === 'done' && after.r.status === 'stopped' && after.r.reason === 'daily_cap' && next.r.status === 'done'
          && rows.length === 5 && rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.detail.day)) && refused.length === 2 && feed.some(([k, s]) => k === 'error' && /daily limit/i.test(s)),
          `runs ${json([one.r.status, two.r.status, three.r.reason, other.r.status, raised.r.status, after.r.reason, next.r.status])}; asked ${three.asked}; started ${rows.length}; refused ${refused.length}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'd-a-team-kill-switch-stops-running-agents-at-their-next-step-and-takes-no-new-task-for-that-team-only',
    async run() {
      const x = await rig();
      try {
        const { createTeam } = loadSubject('src/runtime/agents/team.js');
        const a = await x.agentRow();
        // Switched off in the middle of a task: the second model call is never made.
        x.hooks.onDraft = () => x.guard.stopTeam({ team: 'support', stopped: true });
        const mid = await x.worker(a, [tool('docs.create_draft', 'write'), finish('never')]);
        const cut = await mid.agent.run(TASK);
        x.hooks.onDraft = null;
        const feed = await x.feed(a.id);
        // Another team is not touched.
        const other = await x.agentRow({ team: 'finance_legal_ops' });
        const free = await x.worker(other, [finish('fine')]);
        const fine = await free.agent.run(TASK);
        // A stopped team takes no new task: nothing is saved and no model is asked.
        const name = unique('Sam');
        const row = await x.store.insert('agents', { name, team: 'support', role: 'worker' });
        const w = await x.worker(row, [finish('x')]);
        const lead = { name: unique('Lena'), plan: async () => ({ ok: true, subtasks: [{ worker: name, title: 'Reply', instructions: 'Say thanks.' }] }), review: async () => ({ accept: true, feedback: '' }) };
        const team = createTeam({ team: 'support', lead, workers: { [name]: w.agent }, store: x.store, audit: x.audit, events: x.events, control: x.control, guard: x.guard });
        await team.register();
        const before = (await x.store.select('tasks', { where: {}, limit: 100 })).length;
        const refused = await team.runTask({ title: 'Say thanks' });
        const after = (await x.store.select('tasks', { where: {}, limit: 100 })).length;
        // Switched on again: it works.
        await x.guard.stopTeam({ team: 'support', stopped: false });
        const again = await team.runTask({ title: 'Say thanks again' });
        return verdict(cut.status === 'stopped' && cut.reason === 'team_stopped' && mid.router.requests.length === 1 && feed.some(([k, s]) => k === 'error' && /switched off/i.test(s)) && fine.status === 'done'
          && refused.status === 'failed' && refused.reason === 'team_stopped' && before === after && w.router.requests.length === 1 && again.status === 'done',
          `mid-task ${json([cut.reason, mid.router.requests.length])}; other team ${fine.status}; new task ${json(refused)}; rows ${before} -> ${after}; after switching on ${again.status}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'e-the-switch-is-audited-first-remembered-by-every-process-and-refuses-nonsense-and-nothing-changes-without-an-audit-entry',
    async run() {
      const x = await rig();
      const downAudit = { append: async () => { throw new Error('database down'); } };
      const y = await rig({ audit: downAudit });
      const z = await rig({ isBlocked: () => 'The runtime is blocked for a test.' });
      try {
        const fail = async (p) => { try { await p; return null; } catch (err) { return { code: err.code, name: err.name, message: String(err.message) }; } };
        const on = await x.guard.stopTeam({ team: 'marketing_sales', stopped: true });
        const same = await x.guard.stopTeam({ team: 'marketing_sales', stopped: true });
        const audits = await x.store.select('audit_log', { where: { action: 'team.stopped' }, limit: 20 });
        // Another process (a second guard on the same database) sees it.
        const { createGuardrails } = loadSubject('src/runtime/guardrails.js');
        const elsewhere = createGuardrails({ store: x.store, audit: x.audit, cacheMs: 0 });
        const seen = await elsewhere.teamStopped('marketing_sales');
        const status = await elsewhere.status();
        const bad = [await fail(x.guard.stopTeam({ team: 'nope', stopped: true })), await fail(x.guard.stopTeam({ team: 'support' })), await fail(x.guard.stopTeam(null)), await fail(x.guard.stopTeam({ team: 'support', stopped: 'yes' }))];
        const down = await fail(y.guard.stopTeam({ team: 'support', stopped: true }));
        const blocked = await fail(z.guard.stopTeam({ team: 'support', stopped: true }));
        const stillOff = await y.guard.teamStopped('support');
        const rowsY = await y.store.select('app_settings', { where: {}, limit: 10 });
        const off = await x.guard.stopTeam({ team: 'marketing_sales', stopped: false });
        return verdict(on.changed === true && same.changed === false && audits.length === 1 && seen === true && json(status.stoppedTeams) === json(['marketing_sales']) && bad.every((b) => b && b.name === 'GuardrailsError')
          && down?.code === 'audit_unavailable' && !/database down/.test(down.message) && blocked?.code === 'blocked' && stillOff === false && rowsY.length === 0 && off.changed === true && (await elsewhere.teamStopped('marketing_sales')) === false,
          `on ${json(on)}; again ${json(same)}; audits ${audits.length}; seen elsewhere ${seen}; status ${json(status)}; bad ${json(bad.map((b) => b?.code))}; audit down ${json(down)}; blocked ${json(blocked)}`);
      } finally { await x.done(); await y.done(); await z.done(); }
    },
  },
  {
    id: 'f-a-missing-or-odd-settings-table-gives-the-defaults-and-never-stops-work-or-throws',
    async run() {
      const x = await rig();
      try {
        const { createGuardrails } = loadSubject('src/runtime/guardrails.js');
        const broken = { select: async () => { throw Object.assign(new Error('relation "app_settings" does not exist sb_secret_ABCDEFGH'), { code: 'missing_table' }); }, insert: async () => { throw new Error('nope'); }, update: async () => { throw new Error('nope'); } };
        const errors = [];
        const emitted = [];
        const guard = createGuardrails({ store: broken, audit: x.audit, cacheMs: 0, emit: (t, d) => emitted.push(t), onError: (e) => errors.push(e) });
        const limits = await guard.limits();
        const stopped = await guard.teamStopped('support');
        const status = await guard.status();
        const run = await guard.startRun({ agentId: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', agentName: 'Aria', team: 'support', taskId: 't' });
        let stopError = null;
        try { await guard.stopTeam({ team: 'support', stopped: true }); } catch (err) { stopError = { code: err.code, message: String(err.message) }; }
        // Odd values in the row are ignored one by one.
        await x.setSettings({ maxTasksPerDay: -4, loopRepeats: 'lots', stoppedTeams: ['support', 'nope', 7] });
        const odd = await x.guard.status();
        return verdict(limits.maxTasksPerDay === 40 && limits.loopRepeats === 3 && stopped === false && status.stoppedTeams.length === 0 && run.ok === true && stopError?.code === 'not_available' && !/sb_secret|relation/.test(stopError.message)
          && emitted.includes('guardrails.degraded') && emitted.filter((t) => t === 'guardrails.degraded').length === 1
          && odd.limits.maxTasksPerDay === 40 && odd.limits.loopRepeats === 3 && json(odd.stoppedTeams) === json(['support']),
          `limits ${json(limits)}; stopped ${stopped}; run ${json(run)}; stop error ${json(stopError)}; degraded events ${emitted.filter((t) => t === 'guardrails.degraded').length}; odd row ${json(odd)}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'g-done-when-pause-on-the-phone-stops-an-agent-in-the-middle-of-a-task-and-resume-lets-it-go-on',
    async run() {
      const x = await rig();
      try {
        const bot = (over = {}) => {
          const sent = [];
          const api = { sendMessage: async (a) => { sent.push(a.text); return { messageId: sent.length }; }, editMessage: async () => {}, answerCallback: async () => {} };
          const made = loadSubject('src/runtime/telegram/bot.js').createBot({ api, founderChatId: FOUNDER, decisions: { resolve: async () => ({ changed: true }), get: async () => null }, policyTools: { list: async () => [], propose: async () => ({}), confirm: async () => ({}), cancel: async () => ({}), remove: async () => ({}) }, agentControl: x.control, guard: x.guard, onError: () => {}, ...over });
          const say = (text, from = FOUNDER) => made.handleUpdate({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, chat: { id: from }, from: { id: from }, text } });
          return { sent, say };
        };
        const h = bot();
        const a = await x.agentRow({ name: 'Aria' });
        x.hooks.onDraft = () => h.say('/pause Aria'); // the founder types /pause in the middle of the task
        const w = await x.worker(a, [tool('docs.create_draft', 'write'), finish('never')]);
        const cut = await w.agent.run(TASK);
        x.hooks.onDraft = null;
        const row = (await x.store.select('agents', { where: { id: a.id }, limit: 1 }))[0];
        const asked = w.router.requests.length;
        await h.say('/resume Aria');
        const back = (await x.store.select('agents', { where: { id: a.id }, limit: 1 }))[0].status;
        const w2 = await x.worker(a, [finish('Working again.')]);
        const worked = await w2.agent.run(TASK);
        const stranger = bot();
        await stranger.say('/pause Aria', 999);
        const afterStranger = (await x.store.select('agents', { where: { id: a.id }, limit: 1 }))[0].status;
        // Names, usage, and teams.
        await x.agentRow({ name: 'Aria Two', team: 'marketing_sales' });
        await x.agentRow({ name: 'Bea' });
        await h.say('/pause');
        await h.say('/pause Nobody');
        await h.say('/pause aria'); // "Aria" and "Aria Two": the whole name wins
        await h.say('/pause ar'); // ambiguous
        await h.say('/pause team support');
        const stopped = await x.guard.teamStopped('support');
        await h.say('/resume team support');
        const resumed = await x.guard.teamStopped('support');
        await h.say('/pause team nowhere');
        const none = bot({ agentControl: undefined, guard: undefined });
        await none.say('/pause Aria');
        const help = bot();
        await help.say('/help');
        const said = h.sent.join('\n');
        return verdict(cut.status === 'stopped' && cut.reason === 'paused' && asked === 1 && row.status === 'paused' && back === 'idle' && worked.status === 'done' && afterStranger !== 'paused'
          && /paused Aria/i.test(said) && /Usage: \/pause/.test(said) && /could not find an agent called "Nobody"/i.test(said) && /more than one/i.test(said) && stopped === true && resumed === false && /switched off/i.test(said) && /switched on/i.test(said) && /could not find a team/i.test(said)
          && /not available/i.test(none.sent[0]) && /\/pause/.test(help.sent[0]) && !/not available yet/i.test(help.sent[0]),
          `cut ${json([cut.reason, asked])}; status ${row.status} -> ${back}; stranger ${afterStranger}; replies ${json(h.sent)}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'h-the-window-has-the-two-commands-and-a-switch-for-each-team-and-the-app-wires-the-guardrails-in',
    check() {
      const app = read('src/runtime/index.js');
      const commands = read('src/runtime/commands.js');
      const preload = read('src/preload.js');
      const panel = read('src/renderer/TeamsPanel.jsx');
      const service = read('src/runtime/telegram/index.js');
      const problems = [
        ...(/createGuardrails\(/.test(app) ? [] : ['createApp does not build the guardrails']),
        ...(/guard: guardrails|guard,/.test(app) || /\bguard\b/.test(app.slice(app.indexOf('createAgentFactory('), app.indexOf('createAgentFactory(') + 400)) ? [] : ['the factory is not given the guardrails']),
        ...(/guardrails\.status/.test(commands) && /guardrails\.stopTeam/.test(commands) ? [] : ['the two commands are missing']),
        ...(/guardrails\.status/.test(preload) && /guardrails\.stopTeam/.test(preload) ? [] : ['the preload lacks them']),
        ...(/window\.api\.guardrails\.stopTeam/.test(panel) && /window\.api\.guardrails\.status/.test(panel) ? [] : ['the Teams page has no switches']),
        ...(/dangerouslySetInnerHTML|innerHTML/.test(panel) ? ['the panel builds markup'] : []),
        ...(/agentControl/.test(service) && /guard/.test(service) ? [] : ['the Telegram service does not give the bot the controls']),
      ];
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
];

module.exports = {
  name: 'guardrails',
  description: 'Guardrails (step 4.2): step, token and loop limits, a daily task cap per agent, kill switches per agent and per team, /pause on the phone',
  threshold: 1.0,
  cases: () => cases,
  async run(c) {
    return c.check ? c.check() : c.run();
  },
};
