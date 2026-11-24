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
const { createRouter } = require('./router');
const { buildProviders } = require('./providers');
const { createTelegramService, telegramProblem } = require('./telegram');
const { createOrchestratorService } = require('./orchestrator/service');
const { createModelPlanner, createModelCardWriter, buildToolCatalogue } = require('./orchestrator/model');
const { listRules, isBuiltIn, normaliseTool } = require('./policy');
const { createToolLoader } = require('./tools');
const { BUILTIN_TOOLS } = require('./tools/builtin');
const { createFilesystemTools } = require('./tools/filesystem');
const { createFetchTools } = require('./tools/fetch');
const { createGitHubTools } = require('./tools/github');
const { createSupabaseTools } = require('./tools/supabase');
const { loadToolConfig, selectTools } = require('./tools/config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the runtime from an environment object.
 *
 * If the settings are missing or invalid the runtime is still created, but blocked:
 * it refuses every action (with the reason) and only answers runtime.status, so the
 * UI can tell the founder what to fix instead of crashing.
 */
function createApp({ env, fetchImpl, version, filesystemRoot, toolConfigDir, additionalTools = [] }) {
  const loaded = loadConfig(env);

  if (!loaded.ok) {
    const refuse = { append: async () => { throw new Error('not configured'); } };
    const runtime = createRuntime({ audit: refuse });
    registerCommands(runtime, { store: null, version });
    runtime.block(`The runtime is not set up: ${loaded.problems.join('; ')}.`);
    return { runtime, decisions: null, policyTools: null, router: null, telegram: null, orchestrator: null, problems: loaded.problems, async start() { return { ok: false }; }, async stop() { await runtime.stop(); } };
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

  // The model router: Groq (once its key is set), then local Ollama, then Claude Code. Every attempt is
  // written to the audit log before it is made, and if that write fails no model is called. Like the
  // decisions service it is for trusted code (the orchestrator, step 1.7); agents never get it directly.
  const router = createRouter({
    providers: buildProviders({ env, fetchImpl }),
    audit: ({ action, ...detail }) => audit.append({ actorType: 'system', action, detail }),
    sleep,
  });

  // The orchestrator: plans a goal, runs routine actions, and pauses on a card for anything that needs the
  // founder. It finds a run again from its card, so an answer from Telegram or the dashboard resumes it,
  // and runs waiting when the app was closed are resumed on start. The planner and the card writer are written
  // by a model through the router (the goal and the card facts may be seen by hosted providers, as the router's
  // defaults allow; secrets in arguments are removed first). Only the tools the loader has loaded can run; any other routine action fails as
  // "not connected" and a spend still files its card. The policy is the live one.
  // The tool loader (step 1.10): only a tool with a policy rule (built-in or one the founder activated) is loaded,
  // and the rule is checked again on every call. Its tools hand plain text back to the run.
  const hasRule = async (tool) => {
    if (isBuiltIn(tool)) return true;
    const name = normaliseTool(tool);
    return (await policyTools.list()).some((row) => row.status === 'active' && normaliseTool(row.tool) === name);
  };
  // The Filesystem tools read inside ONE folder: FILESYSTEM_ROOT, or the app's own folder when main.js passes it.
  // With neither there are no filesystem tools (never a default of "the whole disk").
  const filesystemTools = createFilesystemTools({ root: env.FILESYSTEM_ROOT || filesystemRoot });
  // Which of the available tools are used is decided by config/mcp/shared.yaml (an allow-list with a read/write tag
  // check that fails closed: without the file there are no tools). The policy rule is still required by the loader.
  const toolSelection = selectTools({
    catalogue: [
      ...BUILTIN_TOOLS,
      ...filesystemTools,
      ...createFetchTools(),
      // GitHub only for the repositories named in GITHUB_REPOS (comma-separated owner/name), and only with a token.
      ...createGitHubTools({ token: env.GITHUB_TOKEN, repos: (env.GITHUB_REPOS ?? '').split(',').map((r) => r.trim()).filter(Boolean), fetchImpl }),
      ...createSupabaseTools({ store }),
    ],
    config: loadToolConfig({ dir: toolConfigDir }),
  });
  // `additionalTools` are tools added in code (the Phase 1 gate test uses a pretend purchase tool). They skip the
  // configuration allow-list but NOT the policy: the loader still refuses one with no policy rule.
  const toolLoader = createToolLoader({ tools: [...toolSelection.tools, ...(Array.isArray(additionalTools) ? additionalTools : [])], hasRule });
  const orchestrator = createOrchestratorService({
    store,
    rawAudit: audit,
    decisions,
    policy: policyTools.policy,
    runtime,
    planner: createModelPlanner({ router, listTools: buildToolCatalogue({ rules: listRules, policyTools, details: () => toolLoader.describe() }) }),
    writeCard: createModelCardWriter({ router }),
    runTool: (request) => toolLoader.run(request),
    onError: () => runtime.emit('orchestrator.error', {}),
  });

  // The window's commands. They are registered here, after the orchestrator exists, because goals.list reads
  // the founder's goals from it.
  registerCommands(runtime, { store, version, decisions, orchestrator });

  // The Telegram bot, only when TELEGRAM_BOT_TOKEN and TELEGRAM_FOUNDER_CHAT_ID are both set. It starts
  // with the runtime and never starts on a blocked one, and it is how the founder gives a goal (/goal).
  // Its errors reach the window as a bare event with no details, because an error message from a
  // network call can hold a token. It is built after the orchestrator, which it hands goals to.
  const telegram = createTelegramService({
    env,
    decisions,
    policyTools,
    orchestrator,
    runtime,
    store,
    fetchImpl,
    sleep,
    onError: () => runtime.emit('telegram.error', {}),
  });
  const telegramIssue = telegramProblem(env); // a setting that is wrong must be said, not silently ignored

  return {
    runtime,
    store,
    decisions,
    policyTools,
    router,
    telegram,
    orchestrator,
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
        try {
          await toolLoader.load();
          if (toolSelection.problems.length > 0) runtime.emit('tools.degraded', { count: toolSelection.problems.length });
        } catch {
          runtime.emit('tools.degraded', {});
        }
        runtime.emit('runtime.ready', {});
        if (telegramIssue) runtime.emit('telegram.problem', { message: telegramIssue });
        telegram?.start();
        orchestrator.start(); // listens for answers, then recovers waiting runs in the background
        return { ok: true };
      } catch (err) {
        const code = err?.cause?.code ?? 'error';
        runtime.block(`The runtime cannot write its audit log (${code}), so it will not carry out actions. Check the database settings and that the migrations are applied.`);
        runtime.emit('runtime.degraded', { code });
        return { ok: false, code };
      }
    },

    async stop() {
      telegram?.stop();
      orchestrator.stop();
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
