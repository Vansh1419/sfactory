'use strict';

// Guardrails (PLAN.md step 4.2). Graded by the `guardrails` eval.
//
//   createGuardrails({ store, audit, isBlocked?, emit?, now?, onError?, cacheMs? })
//     .limits()                       -> { maxTasksPerDay, loopRepeats }
//     .teamStopped(team)              -> boolean
//     .stopTeam({ team, stopped })    -> { team, stopped, changed }      the founder's kill switch for a whole team; audited first
//     .startRun({ agentId, agentName, team, taskId }) -> { ok: true } | { ok: false, reason: 'daily_cap' | 'audit_failed' }
//     .status()                       -> { limits, stoppedTeams }
//
// What it adds to the step and token caps the agent loop already had (agents/agent.js):
//   - a DAILY TASK CAP per agent: every run an agent starts is written to the audit log (`agent.run_started`, with India's date), and the run is refused
//     once the agent has started `maxTasksPerDay` today. Counting from the audit log means every process agrees, and there is nothing else to keep in step.
//   - LOOP DETECTION: `loopRepeats` identical calls with identical results in a row (or two calls taking turns) end a run (the loop does that; the number is here)
//   - KILL SWITCHES: one agent is paused (agents/control.js); a whole TEAM is switched off here: its agents stop at their next step and it takes no new task.
// The values live in the `app_settings` table (key 'guardrails'), are read live (cached for a few seconds, so a change needs no restart), and are checked in
// code: a missing table, or a nonsense value, gives the default and never stops work. Changing a switch is audited BEFORE it is made, and when that cannot
// be done, or the runtime is blocked, nothing changes. For trusted code only: an agent is never handed this.

const TEAMS = Object.freeze(['orchestrator', 'product_engineering', 'marketing_sales', 'support', 'finance_legal_ops']);
const DEFAULTS = Object.freeze({ maxTasksPerDay: 40, loopRepeats: 3 });
const BOUNDS = Object.freeze({ maxTasksPerDay: [1, 1000], loopRepeats: [2, 10] });
const KEY = 'guardrails';
const IST_OFFSET_MS = 330 * 60_000;
const DEFAULT_CACHE_MS = 3000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class GuardrailsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GuardrailsError';
    this.code = code;
  }
}
const fail = (code, message) => new GuardrailsError(code, message);

const istDay = (date) => new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

function createGuardrails({ store, audit, isBlocked = () => null, emit = () => {}, now = () => new Date(), onError = () => {}, cacheMs = DEFAULT_CACHE_MS } = {}) {
  let cached = null; // { at, value }
  let degradedSaid = false;

  const announce = (type, data = {}) => {
    try {
      emit(type, data);
    } catch (err) {
      onError(err);
    }
  };

  /** The raw settings object, or {} when the table cannot be read (said once, never an error text). */
  async function read() {
    if (cached && now().getTime() - cached.at < cacheMs) return cached.value;
    try {
      const [row] = await store.select('app_settings', { where: { key: KEY }, limit: 1 });
      cached = { at: now().getTime(), value: isObject(row?.value) ? row.value : {} };
    } catch (err) {
      onError(err);
      if (!degradedSaid) {
        degradedSaid = true;
        announce('guardrails.degraded');
      }
      return {};
    }
    return cached.value;
  }

  const bounded = (value, key) => (Number.isInteger(value) && value >= BOUNDS[key][0] && value <= BOUNDS[key][1] ? value : DEFAULTS[key]);
  const limitsOf = (raw) => ({ maxTasksPerDay: bounded(raw.maxTasksPerDay, 'maxTasksPerDay'), loopRepeats: bounded(raw.loopRepeats, 'loopRepeats') });
  const stoppedOf = (raw) => (Array.isArray(raw.stoppedTeams) ? [...new Set(raw.stoppedTeams.filter((t) => TEAMS.includes(t)))] : []);

  const limits = async () => limitsOf(await read());
  const teamStopped = async (team) => stoppedOf(await read()).includes(team);
  const status = async () => {
    const raw = await read();
    return { limits: limitsOf(raw), stoppedTeams: stoppedOf(raw) };
  };

  async function stopTeam(input) {
    const reason = isBlocked();
    if (reason) throw fail('blocked', reason);
    if (!isObject(input) || Object.keys(input).some((k) => !['team', 'stopped'].includes(k)) || !TEAMS.includes(input.team) || typeof input.stopped !== 'boolean') {
      throw fail('invalid', `A team (one of ${TEAMS.join(', ')}) and true or false are needed.`);
    }
    let raw = {};
    let exists = false;
    try {
      const [row] = await store.select('app_settings', { where: { key: KEY }, limit: 1 });
      raw = isObject(row?.value) ? row.value : {};
      exists = Boolean(row);
    } catch (err) {
      onError(err);
      throw fail('not_available', 'Team switches need the settings table. Apply the latest database migration (npm run db:migrate) and try again. Nothing was changed.');
    }
    const stopped = stoppedOf(raw);
    if (stopped.includes(input.team) === input.stopped) return { team: input.team, stopped: input.stopped, changed: false };

    try {
      await audit.append({ actorType: 'founder', action: input.stopped ? 'team.stopped' : 'team.started', targetType: 'team', detail: { team: input.team } });
    } catch {
      throw fail('audit_unavailable', 'Nothing was done, because the action could not be recorded in the audit log.');
    }
    const next = { ...raw, stoppedTeams: input.stopped ? [...stopped, input.team] : stopped.filter((t) => t !== input.team) };
    try {
      if (exists) await store.update('app_settings', { key: KEY }, { value: next, updated_at: now().toISOString() });
      else await store.insert('app_settings', { key: KEY, value: next });
    } catch (err) {
      onError(err);
      throw fail('not_available', 'The switch could not be saved. Nothing was changed.');
    }
    cached = { at: now().getTime(), value: next };
    announce('guardrails.changed', { team: input.team, stopped: input.stopped });
    announce('tasks.changed');
    return { team: input.team, stopped: input.stopped, changed: true };
  }

  /** An agent is about to start a run: refused past its daily cap, otherwise written to the audit log first. */
  async function startRun({ agentId, agentName, team, taskId } = {}) {
    const day = istDay(now());
    const { maxTasksPerDay } = await limits();
    let started = 0;
    try {
      const rows = await store.select('audit_log', { where: { action: 'agent.run_started', actor_id: agentId }, order: 'id.desc', limit: maxTasksPerDay + 5 });
      started = rows.filter((r) => r.detail?.day === day).length;
    } catch (err) {
      onError(err); // not knowing the count is not a reason to stop work; the audit write below is still required
    }
    if (started >= maxTasksPerDay) {
      try {
        await audit.append({ actorType: 'agent', actorId: agentId, action: 'agent.run_refused', detail: { team, agent: agentName, day, reason: 'daily_cap', limit: maxTasksPerDay } });
      } catch (err) {
        onError(err);
      }
      return { ok: false, reason: 'daily_cap' };
    }
    try {
      await audit.append({ actorType: 'agent', actorId: agentId, action: 'agent.run_started', detail: { team, agent: agentName, taskId, day } });
    } catch {
      return { ok: false, reason: 'audit_failed' };
    }
    return { ok: true };
  }

  return { limits, teamStopped, stopTeam, startRun, status };
}

module.exports = { createGuardrails, GuardrailsError, DEFAULTS, TEAMS };
