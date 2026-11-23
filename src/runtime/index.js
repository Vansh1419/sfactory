'use strict';

// Wires the runtime together. This file never imports Electron, so the same
// runtime can later run headless on a server.

const { loadConfig } = require('./config');
const { createAudit } = require('./audit');
const { createRuntime } = require('./runtime');
const { registerCommands } = require('./commands');
const { createRestStore } = require('./store/rest');
const { createDecisionService } = require('./decisions');
const { createPolicyTools } = require('./policy-tools');

/**
 * Build the runtime from an environment object.
 *
 * If the settings are missing or invalid the runtime is still created, but blocked:
 * it refuses every action (with the reason) and only answers runtime.status, so the
 * UI can tell the founder what to fix instead of crashing.
 */
function createApp({ env, fetchImpl, version }) {
  const loaded = loadConfig(env);

  if (!loaded.ok) {
    const refuse = { append: async () => { throw new Error('not configured'); } };
    const runtime = createRuntime({ audit: refuse });
    registerCommands(runtime, { store: null, version });
    runtime.block(`The runtime is not set up: ${loaded.problems.join('; ')}.`);
    return { runtime, decisions: null, policyTools: null, problems: loaded.problems, async start() { return { ok: false }; }, async stop() { await runtime.stop(); } };
  }

  const { url, serviceKey } = loaded.config.supabase;
  const store = createRestStore({ url, serviceKey, fetchImpl });
  const audit = createAudit(store);
  const runtime = createRuntime({ audit });
  // The founder's additions to the policy check (added from Telegram in step 1.8). Built-in rules
  // always win; `policyTools.policy` is the live check the decisions service and, later, the
  // orchestrator and tool loader use. Like the decisions service it is never handed to agents' tools.
  const emit = (type, data) => runtime.emit(type, data);
  const isBlocked = () => runtime.blockedReason();
  const policyTools = createPolicyTools({ store, audit, emit, isBlocked });

  // The decisions service files, answers and chases decisions for the dashboard, the Telegram bot
  // and the orchestrator. It refuses while the runtime is blocked.
  const decisions = createDecisionService({ store, audit, emit, isBlocked, policy: policyTools.policy });
  registerCommands(runtime, { store, version, decisions });

  return {
    runtime,
    store,
    decisions,
    policyTools,
    problems: [],

    /** Record that the runtime started. If the database is not ready the runtime still runs, and says so. */
    async start() {
      try {
        await audit.append({ actorType: 'system', action: 'runtime.started', detail: { version } });
        // Load the tools the founder added. If that fails (for example the policy_tools migration is
        // not applied yet) the runtime still runs on the built-in rules, and says so.
        try {
          await policyTools.refresh();
        } catch (err) {
          runtime.emit('policy.degraded', { code: typeof err?.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : 'error' });
        }
        runtime.emit('runtime.ready', {});
        return { ok: true };
      } catch (err) {
        const code = err?.cause?.code ?? 'error';
        runtime.block(`The runtime cannot write its audit log (${code}), so it will not carry out actions. Check the database settings and that the migrations are applied.`);
        runtime.emit('runtime.degraded', { code });
        return { ok: false, code };
      }
    },

    async stop() {
      if (!runtime.blockedReason()) {
        try {
          await audit.append({ actorType: 'system', action: 'runtime.stopped', detail: {} });
        } catch {
          // Stopping must not depend on the database.
        }
      }
      await runtime.stop();
    },
  };
}

module.exports = { createApp };
