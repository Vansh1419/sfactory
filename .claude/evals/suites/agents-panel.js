'use strict';

// Grades the project view's agents panel and live feed (PLAN.md step 3.7). "Done when: a step an agent takes appears in the feed within a second or
// two, and a typed instruction reaches the agent."
//   src/runtime/agents/events.js     createAgentEvents({ store, emit?, now? })
//     .record({ agentId?, podId?, taskId?, kind, summary, detail? }) -> the saved row, or null; NEVER throws; announces `agent.event` after it is saved
//     .list({ agentId, limit? })                                      -> events, newest first
//   src/runtime/agents/control.js    createAgentControl({ store, audit, events?, emit?, isBlocked?, now? })
//     .list()                                  -> the agents with status, current task, waiting tasks and notes waiting
//     .pause({ agentId, paused })              -> { agentId, status }      a paused agent takes no further step; audited first
//     .isPaused(agentId)                       -> Promise<boolean>         what the agent's loop asks before every step
//     .message({ agentId, text })              -> { queued, pending }      a typed instruction for a worker or specialist
//     .takeMessages(agentId)                   -> string[]                 what the loop collects before its next model call
//     .reassign({ taskId, agentId })           -> { taskId, agentId, previous }
//     errors are AgentControlError with a `code` and a plain sentence
//   src/runtime/agents/agent.js      createAgent({ ..., events?, control? }): records its steps, stops when paused, reads the founder's notes
//   src/runtime/agents/team.js       createTeam({ ..., events?, control? }): records status changes
//   src/runtime/commands.js          agents.list, agents.events, agents.pause, agents.message, agents.reassign
//   src/preload.js                   window.api.agents.*
//   src/renderer/agents.mjs          agentsView, feedView, applyAgentEvent, shouldRefetch (the logic behind AgentsPanel.jsx)
//
// Runs against a REAL Postgres with the real migrations (the `agent_events` table of step 1.1) and the REAL agent loop, with a scripted model.
//
//   - the done-when: every step an agent takes is saved to `agent_events` and announced as `agent.event` BEFORE the step's tool runs (so it is in the feed
//     at once), and a note the founder types is in the agent's next prompt, in a fence, as the founder's wish (also when sent in the middle of a run)
//   - a feed line is plain words: no tool arguments, no tool error text, no secret; recording can never stop an agent
//   - pause stops an agent at its next step (also in the middle of a task), and the task is blocked with a plain reason; resume lets it work again
//   - reassign moves only a waiting or blocked task, to a working agent of the same kind, and never to a stranger
//   - every control is audited BEFORE it is done (the founder's words never go to the audit log), and when it cannot be audited, or the runtime is
//     blocked, nothing changes
//   - the window's commands check their arguments and the panel shows text only, with no timer

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const RANDOM_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SECRET = 'gsk_a1B2c3D4a1B2c3D4a1B2c3D4a1B2c3D4';
const NOW = new Date('2026-11-25T12:00:00.000Z');
let counter = 0;
const unique = (label) => `${label}${Date.now().toString(36)}${counter++}`;

const finish = (output = 'All done.') => JSON.stringify({ action: 'finish', output });
const tool = (name, access, args = {}) => JSON.stringify({ action: 'tool', tool: name, access, args });

let environment = null;
async function database() {
  if (!environment) {
    const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
    const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
    const { createAudit } = require(path.join(ROOT, 'src/runtime/audit'));
    const fake = await startFakeSupabase();
    const store = createRestStore({ url: fake.url, serviceKey: fake.serviceKey });
    environment = { fake, store, audit: createAudit(store) };
  }
  return environment;
}

/** A scripted model: answers from a list, records every prompt. */
function scripted(replies) {
  const requests = [];
  const queue = [...replies];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const next = queue.shift();
      if (next === undefined) return { ok: false, reason: 'all_providers_failed' };
      return { ok: true, text: next, provider: 'fake', model: 'fake', costUsd: 0, attempts: 1 };
    },
    endTask() {},
  };
}

async function rig(over = {}) {
  const db = await database();
  const { createAgentEvents } = loadSubject('src/runtime/agents/events.js');
  const { createAgentControl } = loadSubject('src/runtime/agents/control.js');
  const { createAgent } = loadSubject('src/runtime/agents/agent.js');
  const { createToolLoader } = loadSubject('src/runtime/tools/index.js');
  const policy = require(path.join(ROOT, 'src/runtime/policy'));
  const emitted = [];
  const emit = (type, data) => emitted.push({ type, data, at: Date.now() });
  const events = createAgentEvents({ store: db.store, emit, now: () => NOW });
  const control = createAgentControl({ store: db.store, audit: over.audit ?? db.audit, events, emit, isBlocked: over.isBlocked, now: () => NOW });
  const agentRow = (extra = {}) => db.store.insert('agents', { name: unique('Agent'), team: 'support', role: 'worker', ...extra });
  const taskRow = (extra = {}) => db.store.insert('tasks', { team: 'support', title: unique('Task'), status: 'queued', ...extra });
  const fail = async (promise) => {
    try {
      await promise;
      return null;
    } catch (err) {
      return { code: err.code, message: String(err.message), name: err.name };
    }
  };
  const feed = async (agentId) => (await events.list({ agentId, limit: 100 })).reverse(); // oldest first
  /** A real agent loop with a scripted model and three small fake tools. `hooks.onDraft` runs inside the draft tool. */
  async function worker(row, replies, hooks = {}) {
    const seen = [];
    const make = (name, access, run) => ({ name, access, summary: `The ${name} tool.`, args: '{ "title": text }', checkArgs: () => null, run: async (request) => { seen.push({ name, args: request.args, emittedBefore: emitted.length, at: Date.now() }); return run(request); } });
    const tools = [
      make('docs.create_draft', 'write', async () => { await hooks.onDraft?.(); return { text: 'Draft saved.' }; }),
      make('filesystem.read_file', 'read', async () => ({ text: 'the file text' })),
      make('fetch.get', 'read', async () => { throw new Error('PRIVATE-TOOL-ERROR-TEXT /Users/someone/secret'); }),
    ];
    const loader = createToolLoader({ tools, hasRule: async () => true });
    await loader.load();
    const router = scripted(replies);
    const agent = createAgent({ id: row.id, name: row.name, role: 'worker', team: row.team, instructions: 'SKILLS-TEXT', router, tools: loader, policy, audit: over.audit ?? db.audit, limits: hooks.limits, events, control });
    return { agent, router, seen };
  }
  return { db, events, control, emitted, emit, agentRow, taskRow, fail, feed, worker };
}

const TASK = { taskId: 't-1', title: 'Write a short reply', instructions: 'Thank the customer.' };

const cases = [
  {
    id: 'a-an-event-is-saved-then-announced-in-plain-words-and-recording-never-throws',
    async run() {
      const x = await rig();
      const a = await x.agentRow();
      const row = await x.events.record({ agentId: a.id, kind: 'tool_used', summary: `Used the tool with ${SECRET} in it`, detail: { tool: 'docs.create_draft', token: SECRET, step: 1 } });
      const saved = (await x.db.store.select('agent_events', { where: { id: row.id }, limit: 1 }))[0];
      const announced = x.emitted.find((e) => e.type === 'agent.event' && e.data.id === row.id);
      const long = await x.events.record({ agentId: a.id, kind: 'message', summary: `${'long '.repeat(100)}\u0007end` });
      const bad = [
        await x.events.record({ agentId: a.id, kind: 'nonsense', summary: 'x' }),
        await x.events.record({ agentId: 'nope', kind: 'message', summary: 'x' }),
        await x.events.record({ agentId: a.id, kind: 'message', summary: '' }),
        await x.events.record({ agentId: a.id, kind: 'message', summary: 5 }),
        await x.events.record(null),
        await x.events.record({ agentId: a.id, podId: 'nope', kind: 'message', summary: 'x' }),
      ];
      const { createAgentEvents } = loadSubject('src/runtime/agents/events.js');
      const broken = createAgentEvents({ store: { insert: async () => { throw new Error('down'); } }, emit: () => { throw new Error('listener'); } });
      const noThrow = await broken.record({ agentId: a.id, kind: 'message', summary: 'x' });
      const deaf = createAgentEvents({ store: x.db.store, emit: () => { throw new Error('listener'); } });
      const stillSaved = await deaf.record({ agentId: a.id, kind: 'message', summary: 'saved though nobody could be told' });
      const shape = announced && announced.data.agentId === a.id && announced.data.kind === 'tool_used' && typeof announced.data.at === 'string' && !('detail' in announced.data);
      return verdict(row && saved && saved.kind === 'tool_used' && !JSON.stringify(saved).includes(SECRET) && shape && !json(announced).includes(SECRET)
        && long && long.summary.length <= 200 && !/\u0007/.test(long.summary) && bad.every((b) => b === null) && noThrow === null && stillSaved && stillSaved.id > 0,
        `saved ${json(saved)}; announced ${json(announced)}; long summary ${long?.summary.length}; refused inputs ${json(bad)}; failing store ${json(noThrow)}; deaf listener ${json(stillSaved)}`);
    },
  },
  {
    id: 'b-done-when-every-step-an-agent-takes-is-in-the-feed-before-its-tool-runs-in-plain-words',
    async run() {
      const x = await rig();
      const row = await x.agentRow();
      const taskRow = await x.taskRow({ assigned_agent_id: row.id });
      const h = await x.worker(row, [
        tool('filesystem.read_file', 'read', { path: 'docs/plan.md' }),
        tool('docs.create_draft', 'write', { title: `Reply ${SECRET}` }),
        tool('fetch.get', 'read', { url: 'https://example.com' }),
        finish('Finished.'),
      ]);
      const started = Date.now();
      const result = await h.agent.run({ ...TASK, rowId: taskRow.id });
      const feed = await x.feed(row.id);
      const kinds = feed.map((e) => e.kind);
      const everyBefore = h.seen.every((s, i) => s.emittedBefore > i);
      const announced = x.emitted.filter((e) => e.type === 'agent.event' && e.data.agentId === row.id);
      const quick = announced.every((e) => e.at - started < 2000);
      const text = json(feed);
      return verdict(result.status === 'done' && json(kinds.slice(0, 3)) === json(['file_read', 'tool_used', 'tool_used']) && feed[0].summary.includes('docs/plan.md') && feed.some((e) => e.kind === 'error' && /fetch\.get/.test(e.summary))
        && feed.every((e) => e.task_id === taskRow.id) && everyBefore && quick && announced.length === feed.length && !text.includes(SECRET) && !/PRIVATE-TOOL-ERROR|\/Users\/someone|example\.com/.test(text) && !text.includes('Reply '),
        `result ${result.status}; kinds ${json(kinds)}; summaries ${json(feed.map((e) => e.summary))}; announced before each tool ${everyBefore}; quick ${quick}; announced ${announced.length} of ${feed.length}`);
    },
  },
  {
    id: 'c-a-stop-or-a-request-for-the-founder-is-said-plainly-in-the-feed',
    async run() {
      const x = await rig();
      const stopper = await x.agentRow();
      const asker = await x.agentRow();
      const hs = await x.worker(stopper, [tool('docs.create_draft', 'write'), tool('docs.create_draft', 'write')], { limits: { maxSteps: 2 } });
      const rs = await hs.agent.run(TASK);
      const ha = await x.worker(asker, [tool('refund.issue', 'write', { amount: 500 })]);
      const ra = await ha.agent.run(TASK);
      const feedS = await x.feed(stopper.id);
      const feedA = await x.feed(asker.id);
      const helped = feedA.find((e) => e.kind === 'help_asked');
      return verdict(rs.status === 'stopped' && feedS.some((e) => e.kind === 'error' && /steps/i.test(e.summary)) && ra.status === 'needs_founder' && helped && /refund\.issue/.test(helped.summary) && !/500/.test(helped.summary)
        && feedA.every((e) => e.kind !== 'tool_used'),
        `stopper ${json(feedS.map((e) => [e.kind, e.summary]))}; asker ${json(feedA.map((e) => [e.kind, e.summary]))}`);
    },
  },
  {
    id: 'd-a-team-run-records-when-an-agent-starts-working-and-when-it-is-idle-and-recording-failures-never-stop-it',
    async run() {
      const x = await rig();
      const { createTeam } = loadSubject('src/runtime/agents/team.js');
      const name = unique('Sam');
      const row = await x.db.store.insert('agents', { name, team: 'support', role: 'worker' });
      const h = await x.worker(row, [tool('docs.create_draft', 'write', { title: 'x' }), finish('Done.')]);
      const lead = { name: unique('Lena'), plan: async () => ({ ok: true, subtasks: [{ worker: name, title: 'Reply', instructions: 'Say thanks.' }] }), review: async () => ({ accept: true, feedback: '' }) };
      const team = createTeam({ team: 'support', lead, workers: { [name]: h.agent }, store: x.db.store, audit: x.db.audit, events: x.events, control: x.control });
      await team.register();
      const run = await team.runTask({ title: 'Say thanks' });
      const feed = await x.feed(h.agent.id);
      const status = feed.filter((e) => e.kind === 'status_change').map((e) => e.summary);
      const taskIds = new Set(feed.filter((e) => e.kind !== 'status_change').map((e) => e.task_id));
      // The same run with an events service that always fails: the task still finishes.
      const row2 = await x.db.store.insert('agents', { name: unique('Sam'), team: 'support', role: 'worker' });
      const h2 = await x.worker(row2, [finish('Done.')]);
      const brokenEvents = { record: async () => { throw new Error('events down'); } };
      const lead2 = { name: unique('Lena'), plan: async () => ({ ok: true, subtasks: [{ worker: row2.name, title: 'Reply', instructions: 'Say thanks.' }] }), review: async () => ({ accept: true, feedback: '' }) };
      const team2 = createTeam({ team: 'support', lead: lead2, workers: { [row2.name]: h2.agent }, store: x.db.store, audit: x.db.audit, events: brokenEvents, control: x.control });
      await team2.register();
      const run2 = await team2.runTask({ title: 'Say thanks again' });
      return verdict(run.status === 'done' && status.length >= 2 && /started working/.test(status[0]) && /idle/.test(status[status.length - 1]) && taskIds.size === 1 && run2.status === 'done',
        `run ${run.status}; status lines ${json(status)}; task ids ${json([...taskIds])}; with a failing events service ${run2.status}`);
    },
  },
  {
    id: 'e-done-when-a-note-the-founder-types-reaches-the-agent-in-a-fence-also-when-sent-in-the-middle-of-a-run',
    async run() {
      const x = await rig();
      const row = await x.agentRow();
      const queued = await x.control.message({ agentId: row.id, text: `Please keep it under 50 words. ${SECRET}` });
      const h = await x.worker(row, [tool('docs.create_draft', 'write'), finish()]);
      await h.agent.run(TASK);
      const first = h.router.requests[0].prompt;
      const second = h.router.requests[1].prompt;
      const fenced = /<<<(FOUNDER-[0-9a-f]+)\n([\s\S]*?)\n\1>>>/.exec(first);
      const again = await x.worker(row, [finish()]);
      await again.agent.run(TASK);
      // Sent in the middle of a run: it is in the NEXT step's prompt, not the one before.
      const row2 = await x.agentRow();
      let sent = false;
      const mid = await x.worker(row2, [tool('docs.create_draft', 'write'), tool('docs.create_draft', 'write'), finish()], { onDraft: async () => { if (!sent) { sent = true; await x.control.message({ agentId: row2.id, text: 'Also add a greeting.' }); } } });
      await mid.agent.run(TASK);
      const feed = await x.feed(row.id);
      const feed2 = await x.feed(row2.id);
      const rows = await x.db.store.select('audit_log', { where: { action: 'agent.message_sent' }, limit: 500 });
      return verdict(queued.queued === true && queued.pending === 1 && fenced && /keep it under 50 words/.test(fenced[2]) && !first.includes(SECRET) && !second.includes(SECRET) && (first.match(/keep it under 50 words/g) ?? []).length === 1
        && /keep it under 50 words/.test(second) && /founder/i.test(first.slice(0, first.indexOf(fenced[0]))) && !again.router.requests[0].prompt.includes('keep it under 50 words')
        && !mid.router.requests[0].prompt.includes('greeting') && mid.router.requests[1].prompt.includes('Also add a greeting.') && mid.router.requests[2].prompt.includes('Also add a greeting.')
        && feed.some((e) => e.kind === 'message' && /Founder/.test(e.summary)) && feed.some((e) => e.kind === 'message' && /read a note/i.test(e.summary)) && feed2.filter((e) => e.kind === 'message').length === 2
        && rows.length >= 2 && !json(rows).includes('keep it under') && x.control.takeMessages(row.id).length === 0,
        `queued ${json(queued)}; fence ${json(fenced?.[0]?.slice(0, 90))}; note in step 2 ${/under 50/.test(second)}; second run has it ${again.router.requests[0].prompt.includes('under 50')}; mid-run first ${mid.router.requests[0].prompt.includes('greeting')}, second ${mid.router.requests[1].prompt.includes('greeting')}; feed ${json(feed.map((e) => e.summary))}; audit rows ${rows.length}`);
    },
  },
  {
    id: 'f-a-note-goes-only-to-a-working-worker-or-specialist-and-must-be-plain-text',
    async run() {
      const x = await rig();
      const worker = await x.agentRow();
      const lead = await x.agentRow({ role: 'team_lead' });
      const specialist = await x.agentRow({ role: 'specialist', is_shared: true });
      const removed = await x.agentRow();
      await x.db.store.update('agents', { id: removed.id }, { status: 'removed', removed_at: NOW.toISOString() });
      const bads = [
        [{ agentId: lead.id, text: 'hello' }, 'invalid'], [{ agentId: removed.id, text: 'hello' }, 'not_found'], [{ agentId: RANDOM_ID, text: 'hello' }, 'not_found'], [{ agentId: 'nope', text: 'hello' }, 'invalid'],
        [{ agentId: worker.id, text: '' }, 'invalid'], [{ agentId: worker.id, text: '   ' }, 'invalid'], [{ agentId: worker.id, text: 'x'.repeat(2001) }, 'invalid'], [{ agentId: worker.id, text: 'a\u0000b' }, 'invalid'],
        [{ agentId: worker.id, text: 5 }, 'invalid'], [{ agentId: worker.id, text: 'hello', extra: 1 }, 'invalid'], [null, 'invalid'],
      ];
      const wrong = [];
      for (const [input, code] of bads) {
        const err = await x.fail(x.control.message(input));
        if (!err || err.name !== 'AgentControlError' || err.code !== code) wrong.push(`${json(input)?.slice(0, 50)} -> ${json(err)}`);
      }
      const forSpecialist = await x.control.message({ agentId: specialist.id, text: 'Serve the urgent one first.' });
      const many = [];
      for (let i = 0; i < 25; i += 1) many.push(await x.fail(x.control.message({ agentId: worker.id, text: `note ${i}` })));
      const accepted = many.filter((m) => m === null).length;
      const refusedLate = many.filter((m) => m && m.code === 'full').length;
      return verdict(wrong.length === 0 && forSpecialist.queued === true && accepted === 20 && refusedLate === 5 && x.control.takeMessages(worker.id).length === 20,
        `answered wrongly ${json(wrong)}; specialist ${json(forSpecialist)}; accepted ${accepted}, refused as full ${refusedLate}`);
    },
  },
  {
    id: 'g-pause-stops-an-agent-at-its-next-step-also-in-the-middle-of-a-task-and-resume-lets-it-work-again',
    async run() {
      const x = await rig();
      const { createTeam } = loadSubject('src/runtime/agents/team.js');
      const row = await x.agentRow();
      const paused = await x.control.pause({ agentId: row.id, paused: true });
      const stored = (await x.db.store.select('agents', { where: { id: row.id }, limit: 1 }))[0].status;
      const h = await x.worker(row, [finish('should not be asked')]);
      const stopped = await h.agent.run(TASK);
      const askedWhilePaused = h.router.requests.length;
      const resumed = await x.control.pause({ agentId: row.id, paused: false });
      const back = (await x.db.store.select('agents', { where: { id: row.id }, limit: 1 }))[0].status;
      const h2 = await x.worker(row, [finish('Working again.')]);
      const worked = await h2.agent.run(TASK);

      // In the middle of a task: the pause arrives while the first tool runs, and the second model call is never made.
      const row2 = await x.agentRow();
      const mid = await x.worker(row2, [tool('docs.create_draft', 'write'), finish('never')], { onDraft: () => x.control.pause({ agentId: row2.id, paused: true }) });
      const cut = await mid.agent.run(TASK);

      // Through a team: the task is blocked with a plain reason and the agent stays paused.
      const name = unique('Sam');
      const row3 = await x.db.store.insert('agents', { name, team: 'support', role: 'worker' });
      const h3 = await x.worker(row3, [finish('x')]);
      const lead = { name: unique('Lena'), plan: async () => ({ ok: true, subtasks: [{ worker: name, title: 'Reply', instructions: 'Say thanks.' }] }), review: async () => ({ accept: true, feedback: '' }) };
      const team = createTeam({ team: 'support', lead, workers: { [name]: h3.agent }, store: x.db.store, audit: x.db.audit, events: x.events, control: x.control });
      await team.register();
      await x.control.pause({ agentId: row3.id, paused: true });
      const ran = await team.runTask({ title: 'Say thanks' });
      const still = (await x.db.store.select('agents', { where: { id: row3.id }, limit: 1 }))[0].status;
      const none = await x.control.pause({ agentId: row3.id, paused: true });
      const audits = (await x.db.store.select('audit_log', { where: { target_id: row.id }, limit: 100 })).map((r) => r.action);
      const feed = await x.feed(row.id);
      return verdict(paused.status === 'paused' && stored === 'paused' && stopped.status === 'stopped' && stopped.reason === 'paused' && askedWhilePaused === 0 && resumed.status === 'idle' && back === 'idle' && worked.status === 'done'
        && cut.status === 'stopped' && cut.reason === 'paused' && mid.router.requests.length === 1 && ran.status === 'blocked' && /paused/i.test(ran.reason) && still === 'paused' && none.changed === false
        && audits.includes('agent.paused') && audits.includes('agent.resumed') && feed.some((e) => e.kind === 'status_change' && /paused/i.test(e.summary)),
        `paused ${json(paused)}; run while paused ${json(stopped)} (model asked ${askedWhilePaused}); resumed ${json(resumed)}; after ${worked.status}; mid-task ${json(cut)} (model asked ${mid.router.requests.length}); team ${json(ran)}; status ${still}; audits ${json(audits)}`);
    },
  },
  {
    id: 'h-reassign-moves-only-a-waiting-or-blocked-task-to-a-working-agent-of-the-same-kind',
    async run() {
      const x = await rig();
      const a = await x.agentRow();
      const b = await x.agentRow();
      const other = await x.agentRow({ team: 'marketing_sales' });
      const removed = await x.agentRow();
      await x.db.store.update('agents', { id: removed.id }, { status: 'removed', removed_at: NOW.toISOString() });
      const s1 = await x.agentRow({ role: 'specialist', is_shared: true, team: 'product_engineering' });
      const s2 = await x.agentRow({ role: 'specialist', is_shared: true, team: 'product_engineering' });
      const queued = await x.taskRow({ assigned_agent_id: a.id });
      const blocked = await x.taskRow({ assigned_agent_id: a.id, status: 'blocked', blocked_reason: 'Waiting for the founder' });
      const running = await x.taskRow({ assigned_agent_id: a.id, status: 'in_progress' });
      const done = await x.taskRow({ assigned_agent_id: a.id, status: 'done', completed_at: NOW.toISOString() });
      const forSpecialist = await x.taskRow({ assigned_agent_id: s1.id, team: 'product_engineering' });
      const moved = await x.control.reassign({ taskId: queued.id, agentId: b.id });
      const movedBlocked = await x.control.reassign({ taskId: blocked.id, agentId: b.id });
      const specialistMoved = await x.control.reassign({ taskId: forSpecialist.id, agentId: s2.id });
      const rowAfter = (await x.db.store.select('tasks', { where: { id: queued.id }, limit: 1 }))[0];
      const refusals = [
        [{ taskId: running.id, agentId: b.id }, 'invalid'], [{ taskId: done.id, agentId: b.id }, 'invalid'], [{ taskId: queued.id, agentId: other.id }, 'invalid'], [{ taskId: queued.id, agentId: removed.id }, 'not_found'],
        [{ taskId: queued.id, agentId: b.id }, 'invalid'], // already with them
        [{ taskId: RANDOM_ID, agentId: b.id }, 'not_found'], [{ taskId: queued.id, agentId: RANDOM_ID }, 'not_found'], [{ taskId: 'nope', agentId: b.id }, 'invalid'], [{ taskId: queued.id }, 'invalid'], [{ taskId: queued.id, agentId: b.id, extra: 1 }, 'invalid'],
      ];
      const wrong = [];
      for (const [input, code] of refusals) {
        const err = await x.fail(x.control.reassign(input));
        if (!err || err.name !== 'AgentControlError' || err.code !== code) wrong.push(`${json(input)} -> ${json(err)}`);
      }
      const toPlain = await x.fail(x.control.reassign({ taskId: (await x.taskRow({ assigned_agent_id: s1.id, team: 'product_engineering' })).id, agentId: (await x.agentRow({ team: 'product_engineering' })).id }));
      const audits = (await x.db.store.select('audit_log', { where: { action: 'task.reassigned' }, limit: 100 })).length;
      const feed = await x.feed(b.id);
      return verdict(moved.previous === a.id && rowAfter.assigned_agent_id === b.id && movedBlocked.agentId === b.id && specialistMoved.agentId === s2.id && wrong.length === 0 && toPlain?.code === 'invalid' && audits >= 3
        && feed.some((e) => e.kind === 'status_change' && /reassigned|took over/i.test(e.summary)),
        `moved ${json(moved)}; row ${rowAfter.assigned_agent_id === b.id}; wrongly answered ${json(wrong)}; specialist to a plain worker ${json(toPlain)}; audits ${audits}; feed ${json(feed.map((e) => e.summary))}`);
    },
  },
  {
    id: 'i-nothing-changes-when-the-audit-log-is-down-or-the-runtime-is-blocked',
    async run() {
      const x = await rig();
      const db = await database();
      const { createAgentControl } = loadSubject('src/runtime/agents/control.js');
      const downAudit = { append: async () => { throw new Error('database down'); } };
      const down = createAgentControl({ store: db.store, audit: downAudit, events: x.events, emit: x.emit });
      const blocked = createAgentControl({ store: db.store, audit: db.audit, events: x.events, emit: x.emit, isBlocked: () => 'The runtime is blocked for a test.' });
      const a = await x.agentRow();
      const b = await x.agentRow();
      const t = await x.taskRow({ assigned_agent_id: a.id });
      const eventsBefore = x.emitted.length;
      const attempts = [
        ['down pause', () => down.pause({ agentId: a.id, paused: true }), 'audit_unavailable'], ['down message', () => down.message({ agentId: a.id, text: 'hi' }), 'audit_unavailable'], ['down reassign', () => down.reassign({ taskId: t.id, agentId: b.id }), 'audit_unavailable'],
        ['blocked pause', () => blocked.pause({ agentId: a.id, paused: true }), 'blocked'], ['blocked message', () => blocked.message({ agentId: a.id, text: 'hi' }), 'blocked'], ['blocked reassign', () => blocked.reassign({ taskId: t.id, agentId: b.id }), 'blocked'],
      ];
      const wrong = [];
      for (const [label, go, code] of attempts) {
        const err = await x.fail(go());
        if (err?.code !== code || /database down/.test(err.message)) wrong.push(`${label}: ${json(err)}`);
      }
      const agent = (await db.store.select('agents', { where: { id: a.id }, limit: 1 }))[0];
      const task = (await db.store.select('tasks', { where: { id: t.id }, limit: 1 }))[0];
      const pausedNow = await down.isPaused(a.id);
      return verdict(wrong.length === 0 && agent.status === 'idle' && task.assigned_agent_id === a.id && down.takeMessages(a.id).length === 0 && blocked.takeMessages(a.id).length === 0 && pausedNow === false && x.emitted.length === eventsBefore,
        `wrong answers ${json(wrong)}; agent ${agent.status}; task assigned to ${task.assigned_agent_id === a.id ? 'the same agent' : 'someone else'}; events ${x.emitted.length - eventsBefore}`);
    },
  },
  {
    id: 'j-the-list-gives-each-agent-with-status-current-task-waiting-tasks-and-notes-in-plain-fields-only',
    async run() {
      const x = await rig();
      const busy = await x.agentRow({ status: 'working' });
      const idle = await x.agentRow();
      const gone = await x.agentRow();
      await x.db.store.update('agents', { id: gone.id }, { status: 'removed', removed_at: NOW.toISOString() });
      const spec = await x.agentRow({ role: 'specialist', is_shared: true, team: 'product_engineering' });
      const running = await x.taskRow({ assigned_agent_id: busy.id, status: 'in_progress', title: 'Reply to <b>Acme</b>\u0007', description: 'PRIVATE-DESCRIPTION' });
      const waiting = await x.taskRow({ assigned_agent_id: busy.id, title: 'Next thing' });
      const stuck = await x.taskRow({ assigned_agent_id: busy.id, status: 'blocked', blocked_reason: 'Needs the founder', title: 'Stuck thing' });
      await x.control.message({ agentId: busy.id, text: 'a note' });
      const { agents } = await x.control.list();
      const mine = agents.find((a) => a.id === busy.id);
      const text = json(agents);
      const ids = agents.map((a) => a.id);
      const idleRow = agents.find((a) => a.id === idle.id);
      return verdict(mine && mine.status === 'working' && mine.role === 'worker' && mine.team === 'support' && mine.task?.id === running.id && mine.task.title === 'Reply to <b>Acme</b>' && mine.pending === 1
        && json(mine.tasks.map((t) => t.status).sort()) === json(['blocked', 'queued']) && mine.tasks.some((t) => t.id === waiting.id) && mine.tasks.some((t) => t.id === stuck.id)
        && idleRow.task === null && !ids.includes(gone.id) && agents.find((a) => a.id === spec.id)?.shared === true && !text.includes('PRIVATE-DESCRIPTION') && !text.includes('\u0007') && !('description' in mine.task),
        `agent ${json(mine)}; idle ${json(idleRow)}; removed shown ${ids.includes(gone.id)}`);
    },
  },
  {
    id: 'k-the-windows-commands-check-their-arguments-keep-the-founders-words-out-of-the-audit-log-and-need-the-service',
    async run() {
      const x = await rig();
      const { createRuntime } = loadSubject('src/runtime/runtime.js');
      const { registerCommands } = loadSubject('src/runtime/commands.js');
      const entries = [];
      const audit = { append: async (e) => { entries.push(e); } };
      const runtime = createRuntime({ audit });
      registerCommands(runtime, { store: x.db.store, agentControl: x.control, agentEvents: x.events });
      const bare = createRuntime({ audit });
      registerCommands(bare, { store: x.db.store });
      const call = (rt, name, args) => rt.invoke(name, args, { actor: 'founder' });
      const a = await x.agentRow();
      const b = await x.agentRow();
      const t = await x.taskRow({ assigned_agent_id: a.id });
      const words = `COMMAND-WORDS-${Date.now()}`;
      const list = await call(runtime, 'agents.list', {});
      const msg = await call(runtime, 'agents.message', { agentId: a.id, text: words });
      const pause = await call(runtime, 'agents.pause', { agentId: a.id, paused: true });
      const resume = await call(runtime, 'agents.pause', { agentId: a.id, paused: false });
      const move = await call(runtime, 'agents.reassign', { taskId: t.id, agentId: b.id });
      const events = await call(runtime, 'agents.events', { agentId: a.id, limit: 10 });
      const bad = [
        await call(runtime, 'agents.list', { x: 1 }), await call(runtime, 'agents.events', {}), await call(runtime, 'agents.events', { agentId: a.id, limit: 0 }), await call(runtime, 'agents.events', { agentId: a.id, limit: 1000 }),
        await call(runtime, 'agents.message', { agentId: 'nope', text: 'x' }), await call(runtime, 'agents.message', { agentId: a.id, text: 5 }), await call(runtime, 'agents.message', { agentId: a.id, text: 'x'.repeat(2001) }),
        await call(runtime, 'agents.pause', { agentId: a.id }), await call(runtime, 'agents.reassign', { taskId: 'nope', agentId: b.id }), await call(runtime, 'agents.reassign', { taskId: t.id }),
      ];
      const refused = await call(runtime, 'agents.reassign', { taskId: t.id, agentId: b.id });
      const offline = [await call(bare, 'agents.list', {}), await call(bare, 'agents.pause', { agentId: a.id, paused: true }), await call(bare, 'agents.message', { agentId: a.id, text: 'x' })];
      const wordsLogged = json(entries).includes(words);
      return verdict(list.ok && Array.isArray(list.data.agents) && msg.ok && pause.ok && resume.ok && move.ok && events.ok && Array.isArray(events.data.events) && events.data.events.some((e) => e.kind === 'message')
        && bad.every((r) => r.ok === false) && refused.ok === false && refused.error.code === 'invalid' && offline.every((r) => r.ok === false && r.error.code === 'not_available') && !wordsLogged && entries.some((e) => e.action === 'command.agents.message'),
        `list ${list.ok}; message ${json(msg)}; pause ${json(pause)}; events ${json(events).slice(0, 120)}; bad inputs answered ${json(bad.map((r) => r.ok))}; second move ${json(refused)}; offline ${json(offline.map((r) => r.error?.code))}; words in the audit log ${wordsLogged}`);
    },
  },
  {
    id: 'l-the-preload-exposes-the-agents-functions-and-the-panel-shows-text-only-with-no-timer',
    check() {
      const preload = read('src/preload.js');
      const panel = read('src/renderer/AgentsPanel.jsx');
      const app = read('src/renderer/App.jsx');
      const missing = ['list', 'events', 'pause', 'message', 'reassign'].filter((n) => !new RegExp(`agents\\.${n}\\b`).test(preload));
      const problems = [
        ...missing.map((n) => `preload lacks agents.${n}`),
        ...(/dangerouslySetInnerHTML|innerHTML/.test(panel) ? ['the panel builds markup'] : []),
        ...(/setInterval/.test(panel) ? ['the panel has a timer'] : []),
        ...(/window\.api\.agents\./.test(panel) ? [] : ['the panel does not call window.api.agents']),
        ...(/agent\.event|applyAgentEvent/.test(panel) ? [] : ['the panel does not take the live events']),
        ...(/AgentsPanel/.test(app) ? [] : ['App.jsx does not show the panel']),
      ];
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'm-the-panels-logic-words-the-agents-and-the-feed-and-adds-live-events-once-for-the-open-agent-only',
    async run() {
      const mod = await loadSubject('src/renderer/agents.mjs');
      const agents = mod.agentsView({ agents: [
        { id: 'w1', name: 'Dev', team: 'product_engineering', role: 'worker', status: 'working', shared: false, task: { id: 't1', title: 'Fix <b>login</b>', status: 'in_progress' }, tasks: [{ id: 't2', title: 'Later', status: 'queued' }], pending: 2 },
        { id: 'l1', name: 'Kavya', team: 'product_engineering', role: 'team_lead', status: 'paused', shared: false, task: null, tasks: [], pending: 0 },
        null, { id: 5 },
      ] });
      const dev = agents.find((a) => a.id === 'w1');
      const kavya = agents.find((a) => a.id === 'l1');
      const rows = mod.feedView([{ id: 3, at: '2026-11-25T11:59:30.000Z', kind: 'tool_used', summary: 'Used <i>git.commit</i>' }, { id: 2, at: '2026-11-25T11:00:00.000Z', kind: 'error', summary: 'It failed.' }, { id: 1, at: 'garbage', kind: 'weird', summary: 'x' }, null], NOW);
      const live = (feed, event, open) => mod.applyAgentEvent(feed, event, open);
      const e = (id, agentId) => ({ type: 'agent.event', data: { id, at: '2026-11-25T12:00:01.000Z', agentId, kind: 'message', summary: `line ${id}` } });
      const f1 = live([], e(5, 'w1'), 'w1');
      const f2 = live(f1, e(5, 'w1'), 'w1');
      const f3 = live(f2, e(6, 'other'), 'w1');
      const f4 = live(f3, { type: 'tasks.changed', data: {} }, 'w1');
      const f5 = live(f4, e(7, 'w1'), 'w1');
      const big = Array.from({ length: 120 }, (_, i) => e(i + 10, 'w1')).reduce((feed, ev) => live(feed, ev, 'w1'), []);
      return verdict(dev && dev.roleLabel === 'Worker' && dev.status.label === 'Working' && /Fix <b>login<\/b>/.test(dev.taskLine) && dev.canMessage === true && dev.pending === 2 && dev.waiting.length === 1 && dev.canPause === true && dev.pauseLabel === 'Pause'
        && kavya.status.label === 'Paused' && kavya.pauseLabel === 'Resume' && kavya.canMessage === false && /no task/i.test(kavya.taskLine) && agents.length === 2
        && rows.length === 3 && /Used <i>git\.commit<\/i>/.test(rows[0].summary) && /just now|minute/.test(rows[0].when) && rows[0].label && rows[2].label && rows[2].when === ''
        && f1.length === 1 && f2.length === 1 && f3.length === 1 && f4.length === 1 && f5.length === 2 && f5[0].id === 7 && big.length === 100 && big[0].id === 129
        && mod.shouldRefetch({ type: 'tasks.changed', data: {} }) === true && mod.shouldRefetch({ type: 'agent.event', data: {} }) === false && mod.shouldRefetch(null) === false,
        `dev ${json(dev)}; kavya ${json(kavya)}; feed rows ${json(rows)}; live sizes ${json([f1.length, f2.length, f3.length, f4.length, f5.length, big.length])}`);
    },
  },
];

module.exports = {
  name: 'agents-panel',
  description: 'The agents panel and live feed (step 3.7): every agent step saved and announced, pause, a typed note that reaches the agent, reassign, all audited',
  threshold: 1.0,
  cases: () => cases,
  async run(c) {
    return c.check ? c.check() : c.run();
  },
};
