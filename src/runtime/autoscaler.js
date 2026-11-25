'use strict';

// Autoscaling (PLAN.md step 4.1). Graded by the `autoscaling` eval.
//
//   createAutoscaler({ store, audit, decisions, runtime?, emit?, isBlocked?, now?, rules?, onError? })
//     .tick()    -> { added, removed, carded, closed, moved } | { skipped: true }
//     .status()  -> [{ team, role, agents, base, max, queued, perAgent, waitMinutes, state }]
//     .start({ everySeconds }) / .stop()
//
// A "group" is the agents of one role in one team (workers, or shared specialists). Every tick, for each group that has a rule:
//   - ADD one agent when the waiting tasks PER AGENT reach `scale_up_queue_threshold`, or when the oldest waiting task has waited `scale_up_wait_minutes`
//     (counted from the newest agent's arrival, so a new agent gets time to work before another is added). The new agent is a copy of an original ("Aria 2"),
//     and the waiting work is shared out evenly (only tasks that have not started; nothing running is touched).
//   - at the cap (`max_agents`), ask the founder instead: one plain card (`agent.add`, an always-ask rule), never two at once, and not again for a day after
//     a no. An approval adds exactly one agent beyond the cap, once.
//   - REMOVE one idle copy per tick when the group is not busy: only an agent the autoscaler made, only while idle with no open work for
//     `idle_minutes_before_removal`. The originals, leads and paused or working agents are never removed.
//   - CLOSE an open project space whose project is completed or cancelled.
// The rules come from the `scaling_rules` table (global rules; the most specific one wins), with built-in defaults for a group the table does not mention.
// Every change is audited BEFORE it is made, and if that cannot be done, or the runtime is blocked, nothing changes. A tick never throws and two never overlap.
// For trusted code only: an agent is never handed this.

const crypto = require('node:crypto');

const TEAMS = Object.freeze(['product_engineering', 'marketing_sales', 'support', 'finance_legal_ops']);
const ROLES = Object.freeze(['worker', 'specialist']);
const DEFAULT_RULE = Object.freeze({ max_agents: 6, scale_up_queue_threshold: 5, scale_up_wait_minutes: 30, idle_minutes_before_removal: 60 });
const TEAM_LABELS = Object.freeze({ product_engineering: 'Product and Engineering', marketing_sales: 'Marketing and Sales', support: 'Customer Support', finance_legal_ops: 'Finance, Legal and Ops' });
const OPEN = Object.freeze(['queued', 'in_progress', 'in_review', 'blocked']);
const MINUTE = 60_000;
const ASK_AGAIN_AFTER_NO_MS = 24 * 60 * MINUTE;
const READ_LIMIT = 2000;
const CLONE_NAME = /^(.+) (\d+)$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const wholeNumber = (v, min = 1) => Number.isInteger(v) && v >= min;

function createAutoscaler({ store, audit, decisions, runtime, emit = () => {}, isBlocked = () => null, now = () => new Date(), rules: injectedRules, onError = () => {} } = {}) {
  let running = false;
  let timer = null;
  let unsubscribe = null;
  const lastAdded = new Map(); // `${team}:${role}` -> when the newest agent arrived (on this clock)
  const born = new Map(); // agent id -> when this autoscaler made it (on this clock)
  const handling = new Set(); // decision ids being applied right now

  const announce = (type, data = {}) => {
    try {
      emit(type, data);
    } catch (err) {
      onError(err);
    }
  };

  async function record(action, targetType, targetId, detail, podId) {
    await audit.append({ actorType: 'system', ...(podId ? { podId } : {}), action, targetType, targetId, detail });
  }

  // ---- the rules ---------------------------------------------------------------------------------------------------------

  function cleanRule(row) {
    if (!isObject(row) || row.enabled === false || !TEAMS.includes(row.team ?? TEAMS[0]) || !ROLES.includes(row.role ?? ROLES[0])) return null;
    const pick = (key) => (wholeNumber(row[key]) ? row[key] : DEFAULT_RULE[key]);
    if (!wholeNumber(row.max_agents)) return null;
    return { team: row.team ?? null, role: row.role ?? null, max_agents: row.max_agents, scale_up_queue_threshold: pick('scale_up_queue_threshold'), scale_up_wait_minutes: pick('scale_up_wait_minutes'), idle_minutes_before_removal: pick('idle_minutes_before_removal') };
  }

  /** The rule of each (team, role) group, the most specific one winning. A disabled rule switches that group off. */
  async function groupRules() {
    const byGroup = new Map();
    let rows;
    if (Array.isArray(injectedRules)) {
      rows = injectedRules;
    } else {
      rows = await store.select('scaling_rules', { where: { scope: 'global' }, limit: 500 });
    }
    const specificity = (r) => (r.team ? 2 : 0) + (r.role ? 1 : 0);
    const sorted = [...rows].filter(isObject).sort((a, b) => specificity(a) - specificity(b)); // least specific first, so a more specific one overwrites it
    for (const row of sorted) {
      for (const team of row.team ? [row.team] : TEAMS) {
        for (const role of row.role ? [row.role] : ROLES) {
          if (!TEAMS.includes(team) || !ROLES.includes(role)) continue;
          const rule = cleanRule({ ...row, team, role });
          byGroup.set(`${team}:${role}`, rule); // null for a disabled or odd rule: that group is off
        }
      }
    }
    if (!Array.isArray(injectedRules)) {
      for (const team of TEAMS) for (const role of ROLES) if (!byGroup.has(`${team}:${role}`)) byGroup.set(`${team}:${role}`, { team, role, ...DEFAULT_RULE });
    }
    return byGroup;
  }

  // ---- what is going on ------------------------------------------------------------------------------------------------

  async function snapshot() {
    const agents = (await store.select('agents', { where: {}, limit: READ_LIMIT })).filter((a) => a.status !== 'removed');
    const tasks = [];
    for (const status of OPEN) tasks.push(...(await store.select('tasks', { where: { status }, order: 'queued_at.asc', limit: READ_LIMIT })));
    const events = await store.select('agent_events', { where: {}, order: 'id.desc', limit: READ_LIMIT });
    const lastEvent = new Map();
    for (const e of events) if (e.agent_id && !lastEvent.has(e.agent_id)) lastEvent.set(e.agent_id, Date.parse(e.at));
    return { agents, tasks, lastEvent };
  }

  const isClone = (agent, group) => {
    const m = CLONE_NAME.exec(agent.name);
    return Boolean(m) && Number(m[2]) >= 2 && group.some((a) => a.name === m[1]);
  };

  function groupOf(snap, team, role) {
    const members = snap.agents.filter((a) => a.team === team && a.role === role);
    const ids = new Set(members.map((a) => a.id));
    const queued = snap.tasks.filter((t) => t.status === 'queued' && ids.has(t.assigned_agent_id));
    const originals = members.filter((a) => !isClone(a, members));
    const clones = members.filter((a) => isClone(a, members));
    return { team, role, members, ids, queued, originals, clones };
  }

  function metrics(group, rule) {
    const n = group.members.length;
    const perAgent = n > 0 ? group.queued.length / n : 0;
    const oldest = group.queued.length > 0 ? Math.min(...group.queued.map((t) => Date.parse(t.queued_at))) : null;
    const arrived = lastAdded.get(`${group.team}:${group.role}`) ?? Math.max(0, ...group.clones.map((c) => Date.parse(c.created_at)));
    const waitFrom = oldest === null ? null : Math.max(oldest, arrived);
    const waitMinutes = waitFrom === null ? 0 : Math.max(0, (now().getTime() - waitFrom) / MINUTE);
    const overloaded = group.queued.length > 0 && (perAgent >= rule.scale_up_queue_threshold || waitMinutes >= rule.scale_up_wait_minutes);
    return { n, perAgent, waitMinutes, overloaded };
  }

  async function status() {
    const rules = await groupRules();
    const snap = await snapshot();
    const out = [];
    for (const [key, rule] of rules) {
      if (!rule) continue;
      const [team, role] = key.split(':');
      const group = groupOf(snap, team, role);
      if (group.originals.length === 0) continue;
      const m = metrics(group, rule);
      out.push({
        team, role, agents: m.n, base: group.originals.length, max: rule.max_agents, queued: group.queued.length,
        perAgent: Math.round(m.perAgent * 10) / 10, waitMinutes: Math.round(m.waitMinutes),
        state: m.overloaded ? (m.n >= rule.max_agents ? 'at_cap' : 'busy') : 'ok',
      });
    }
    return out;
  }

  // ---- adding, sharing out and removing --------------------------------------------------------------------------

  /** One more agent in the group, a copy of the original with the fewest copies. Audited first. */
  async function addAgent(group, { decisionId, beyondCap = false } = {}) {
    const copies = (o) => group.clones.filter((c) => CLONE_NAME.exec(c.name)?.[1] === o.name).length;
    const original = [...group.originals].sort((a, b) => copies(a) - copies(b) || String(a.created_at).localeCompare(String(b.created_at)))[0];
    if (!original) return null;
    const taken = new Set(group.members.map((a) => a.name));
    let n = 2;
    while (taken.has(`${original.name} ${n}`)) n += 1;
    const name = `${original.name} ${n}`;
    const id = crypto.randomUUID();
    await record('agent.scaled_up', 'agent', id, { team: group.team, role: group.role, name, from: original.name, beyondCap, ...(decisionId ? { decisionId } : {}) });
    const row = await store.insert('agents', { id, name, team: group.team, role: group.role, is_shared: original.is_shared === true, model_tier: original.model_tier ?? 'cheap' });
    const at = now().getTime();
    lastAdded.set(`${group.team}:${group.role}`, at);
    born.set(row.id, at);
    announce('tasks.changed');
    return { team: group.team, role: group.role, agentId: row.id, name };
  }

  /** Share the waiting work of a group evenly. Only tasks that have not started move; the busiest agent gives its newest waiting task to the emptiest. */
  async function rebalance(team, role) {
    const snap = await snapshot();
    const group = groupOf(snap, team, role);
    if (group.members.length < 2) return 0;
    const lanes = new Map(group.members.map((a) => [a.id, group.queued.filter((t) => t.assigned_agent_id === a.id).sort((x, y) => String(y.queued_at).localeCompare(String(x.queued_at)))]));
    const moves = [];
    for (;;) {
      const sorted = [...lanes.entries()].sort((a, b) => a[1].length - b[1].length);
      const [emptiestId, emptiest] = sorted[0];
      const [fullestId, fullest] = sorted[sorted.length - 1];
      if (fullest.length - emptiest.length <= 1) break;
      const task = fullest.shift();
      emptiest.push(task);
      moves.push({ taskId: task.id, to: emptiestId, from: fullestId });
    }
    if (moves.length === 0) return 0;
    await record('tasks.rebalanced', 'agent', group.members[0].id, { team, role, moved: moves.length });
    let moved = 0;
    for (const move of moves) {
      const changed = await store.update('tasks', { id: move.taskId, status: 'queued', assigned_agent_id: move.from }, { assigned_agent_id: move.to });
      if (Array.isArray(changed) && changed.length > 0) moved += 1;
    }
    if (moved > 0) announce('tasks.changed');
    return moved;
  }

  /** The idle copy to remove, if any: made by the autoscaler, idle long enough, with no open work. */
  function removable(group, rule, snap) {
    if (group.clones.length === 0) return null;
    const asNeeded = group.members.length - 1;
    if (asNeeded < 1 || group.queued.length / asNeeded >= rule.scale_up_queue_threshold) return null; // the rest could not carry the waiting work
    const busyIds = new Set(snap.tasks.map((t) => t.assigned_agent_id));
    const idleFor = (a) => (now().getTime() - Math.max(born.get(a.id) ?? Date.parse(a.created_at), snap.lastEvent.get(a.id) ?? 0)) / MINUTE;
    return [...group.clones]
      .filter((a) => a.status === 'idle' && !busyIds.has(a.id) && idleFor(a) >= rule.idle_minutes_before_removal)
      .sort((a, b) => Number(CLONE_NAME.exec(b.name)[2]) - Number(CLONE_NAME.exec(a.name)[2]))[0] ?? null;
  }

  async function removeAgent(agent, group) {
    await record('agent.scaled_down', 'agent', agent.id, { team: group.team, role: group.role, name: agent.name });
    const changed = await store.update('agents', { id: agent.id, status: 'idle' }, { status: 'removed', removed_at: now().toISOString() });
    if (!Array.isArray(changed) || changed.length === 0) return null;
    born.delete(agent.id);
    announce('tasks.changed');
    return { team: group.team, role: group.role, agentId: agent.id, name: agent.name };
  }

  // ---- asking the founder past the cap ------------------------------------------------------------------------------------

  async function cardFor(group, rule, m) {
    const sameGroup = (d) => isObject(d.action) && d.action.tool === 'agent.add' && d.action.args?.team === group.team && d.action.args?.role === group.role;
    if ((await decisions.listWaiting({ tool: 'agent.add', limit: 200 })).some(sameGroup)) return null;
    const noed = (await decisions.listDeclined({ tool: 'agent.add', limit: 50 })).filter(sameGroup);
    if (noed.length > 0 && now().getTime() - Date.parse(noed[0].answeredAt) < ASK_AGAIN_AFTER_NO_MS) return null;
    const word = group.role === 'specialist' ? 'specialist' : 'worker';
    const minutes = Math.round(m.waitMinutes);
    const filed = await decisions.create({
      action: { tool: 'agent.add', access: 'write', args: { team: group.team, role: group.role } },
      card: {
        decide: `Add one more ${word} to the ${TEAM_LABELS[group.team]} team?`,
        why_now: `The team already has its most ${word}s (${rule.max_agents}) and still has ${group.queued.length} tasks waiting${minutes > 0 ? `, the oldest for ${minutes} minutes` : ''}.`,
        if_yes: `One more ${word} joins the team and takes a share of the waiting work. It uses a little more of the model while it works.`,
        if_no: 'No one is added. The waiting work stays with the team as it is, and you will not be asked about this team again for a day.',
        cost: '₹0 ($0) to add, then model use only while it works',
        risk: { level: 'Low', reason: 'It can be removed again once it is idle, and it cannot spend money or send anything by itself.' },
        recommendation: 'Add one if the waiting work matters; otherwise leave it as it is.',
      },
    });
    return { team: group.team, role: group.role, decisionId: filed.id };
  }

  /** The founder approved an `agent.add` card: add exactly one agent, once. */
  async function applyApproved(decisionId) {
    if (handling.has(decisionId)) return null;
    handling.add(decisionId);
    try {
      const decision = await decisions.get(decisionId);
      if (!isObject(decision) || decision.status !== 'approved' || decision.action?.tool !== 'agent.add') return null;
      const { team, role } = decision.action.args ?? {};
      if (!TEAMS.includes(team) || !ROLES.includes(role)) return null;
      const done = (await store.select('audit_log', { where: { action: 'agent.scaled_up' }, order: 'id.desc', limit: 500 })).some((r) => r.detail?.decisionId === decisionId);
      if (done) return null;
      if (isBlocked()) return null;
      const group = groupOf(await snapshot(), team, role);
      const added = await addAgent(group, { decisionId, beyondCap: true });
      if (added) await rebalance(team, role).catch(onError);
      return added;
    } catch (err) {
      onError(err);
      return null;
    } finally {
      handling.delete(decisionId);
    }
  }

  // ---- project spaces -------------------------------------------------------------------------------------------------------

  async function closeEndedPods() {
    const closed = [];
    const pods = await store.select('pods', { where: { status: 'open' }, limit: 500 });
    if (pods.length === 0) return closed;
    const projects = new Map((await store.select('projects', { where: {}, limit: 1000 })).map((p) => [p.id, p]));
    for (const pod of pods) {
      const project = projects.get(pod.project_id);
      if (!project || !['completed', 'cancelled'].includes(project.status)) continue;
      try {
        await record('pod.closed', 'pod', pod.id, { projectStatus: project.status }, pod.id);
        const changed = await store.update('pods', { id: pod.id, status: 'open' }, { status: 'closed', closed_at: now().toISOString() });
        if (!Array.isArray(changed) || changed.length === 0) continue;
        for (const member of await store.select('pod_members', { where: { pod_id: pod.id }, limit: 500 })) {
          if (!member.left_at) await store.update('pod_members', { pod_id: pod.id, agent_id: member.agent_id }, { left_at: now().toISOString() }).catch(onError);
        }
        closed.push(pod.id);
        announce('tasks.changed');
      } catch (err) {
        onError(err);
      }
    }
    return closed;
  }

  // ---- one pass ---------------------------------------------------------------------------------------------------------------

  async function tick() {
    if (running || isBlocked()) return { skipped: true };
    running = true;
    const result = { added: [], removed: [], carded: [], closed: [], moved: 0 };
    try {
      const rules = await groupRules();
      const snap = await snapshot();
      for (const [key, rule] of rules) {
        if (!rule) continue;
        const [team, role] = key.split(':');
        const group = groupOf(snap, team, role);
        if (group.originals.length === 0) continue;
        try {
          const m = metrics(group, rule);
          if (m.overloaded) {
            if (m.n < rule.max_agents) {
              const added = await addAgent(group);
              if (added) {
                result.added.push(added);
                result.moved += await rebalance(team, role);
              }
            } else {
              const carded = await cardFor(group, rule, m);
              if (carded) result.carded.push(carded);
            }
          } else {
            const gone = removable(group, rule, snap);
            if (gone) {
              const removed = await removeAgent(gone, group);
              if (removed) result.removed.push(removed);
            }
          }
        } catch (err) {
          onError(err); // one group failing (for example, the audit log is down) must not stop the others being looked at
        }
      }
      result.closed = await closeEndedPods();
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
    return result;
  }

  return {
    tick,
    status,

    start({ everySeconds = 60 } = {}) {
      this.stop();
      unsubscribe = runtime?.on?.('decision.resolved', (event) => {
        if (isObject(event) && typeof event.id === 'string' && event.status === 'approved') applyApproved(event.id).catch(onError);
      }) ?? null;
      // A card approved while the app was closed.
      Promise.resolve(decisions.listApproved?.({ tool: 'agent.add', limit: 50 })).then((rows) => Promise.all((Array.isArray(rows) ? rows : []).map((r) => applyApproved(r.id)))).catch(onError);
      timer = setInterval(() => { tick().catch(onError); }, Math.max(1, everySeconds) * 1000);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

module.exports = { createAutoscaler, DEFAULT_RULE, TEAMS, ROLES };
