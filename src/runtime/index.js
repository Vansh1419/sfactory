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
const { createTelegramService, telegramProblem, digestProblem } = require('./telegram');
const { createOrchestratorService } = require('./orchestrator/service');
const { createModelPlanner, createModelCardWriter, buildToolCatalogue } = require('./orchestrator/model');
const { listRules, isBuiltIn, normaliseTool } = require('./policy');
const { createToolLoader } = require('./tools');
const { BUILTIN_TOOLS } = require('./tools/builtin');
const { createFilesystemTools } = require('./tools/filesystem');
const { createFetchTools } = require('./tools/fetch');
const { createGitHubTools } = require('./tools/github');
const { createOutbound } = require('./outbound/service');
const { createReviewer } = require('./outbound/review');
const { createOutboundTools } = require('./outbound/tools');
const { parseApprovalUntil } = require('./outbound/settings');
const { createSupabaseTools } = require('./tools/supabase');
const { createGitTools } = require('./tools/git');
const { createMemoryTools } = require('./tools/memory');
const { createPodTools } = require('./tools/pod');
const { createPodFileTools } = require('./tools/pod-files');
const { createContext7Tools } = require('./tools/context7');
const { createBrowserTools, loadPlaywrightDriver } = require('./tools/browser');
const { createSearchTools } = require('./tools/search');
const { createInvoiceTools } = require('./tools/invoice');
const { createCrmTools } = require('./tools/crm');
const { createGoogleTools } = require('./tools/google');
const { loadToolConfig, selectTools } = require('./tools/config');
const { createAgentFactory } = require('./agents');
const { createSalesTeam } = require('./teams/marketing-sales');
const { createTicketTools } = require('./tools/tickets');
const { createSupportTeam } = require('./teams/support');
const { createEngineeringTeam } = require('./teams/engineering');
const { createFinanceTeam } = require('./teams/finance-legal-ops');
const { createTeamsOverview } = require('./teams/overview');
const { createBrief } = require('./brief');
const { createTeamJobs } = require('./teams/jobs');
const { createPods } = require('./pods/service');
const { createSpecialists } = require('./specialists');
const { createPodFiles } = require('./pods/files');
const { createAgentEvents } = require('./agents/events');
const { createAgentControl } = require('./agents/control');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What one team worker may use in one run (a hard stop for a runaway agent). The agent default (8 steps, 20,000 tokens) was sized
// for tiny test skills: with the real skills a worker's first three steps already use 20,000, and a lead needs five or six steps.
const AGENT_LIMITS = Object.freeze({ maxSteps: 10, maxTokens: 60_000 });

/**
 * Build the runtime from an environment object.
 *
 * If the settings are missing or invalid the runtime is still created, but blocked:
 * it refuses every action (with the reason) and only answers runtime.status, so the
 * UI can tell the founder what to fix instead of crashing.
 */
function createApp({ env, fetchImpl, version, filesystemRoot, toolConfigDir, skillsDir, podTemplatesDir, podsRoot, additionalTools = [], mailSend, providers, gitRemoteUrl }) {
  const loaded = loadConfig(env);

  if (!loaded.ok) {
    const refuse = { append: async () => { throw new Error('not configured'); } };
    const runtime = createRuntime({ audit: refuse });
    registerCommands(runtime, { store: null, version });
    runtime.block(`The runtime is not set up: ${loaded.problems.join('; ')}.`);
    return { runtime, decisions: null, policyTools: null, router: null, telegram: null, orchestrator: null, outbound: null, agents: null, sales: null, support: null, engineering: null, finance: null, specialists: null, pods: null, podFiles: null, agentControl: null, agentEvents: null, problems: loaded.problems, async start() { return { ok: false }; }, async stop() { await runtime.stop(); } };
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
    // `providers` is for tests (the gate scripts): a ready-made provider list instead of the real ones. The app never passes it.
    providers: Array.isArray(providers) ? providers : buildProviders({ env, fetchImpl }),
    audit: ({ action, ...detail }) => audit.append({ actorType: 'system', action, detail }),
    sleep,
    // Per task, not overall. A team worker re-sends its skills (about 5,400 tokens) with every step, so a run of a few steps needs
    // more than the default 50,000; the agent's own cap (below) stops it first.
    caps: { maxTokens: AGENT_LIMITS.maxTokens + 15_000 },
  });

  // The outbound gate (step 2.2): every message to a client is saved, reviewed and, while the founder's approval is required,
  // approved on a card before it can be sent. OUTBOUND_FOUNDER_APPROVAL_UNTIL is the end of the first weeks when the founder
  // approves every message; unset, garbled or in the future means the founder approves every message. `mailSend` is the mail
  // transport (the Gmail tools of step 2.3 provide it); with none, nothing can be sent. The review and the cards may be
  // seen by hosted providers only when the router's sensitive rules allow it (client data is marked sensitive).
  const approval = parseApprovalUntil(env.OUTBOUND_FOUNDER_APPROVAL_UNTIL);
  const outbound = createOutbound({
    store,
    audit,
    decisions,
    review: createReviewer({ router }),
    writeCard: createModelCardWriter({ router }),
    send: mailSend,
    approvalUntil: approval.until,
    runtime,
    onError: () => runtime.emit('outbound.error', {}),
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
  // Pods (step 3.1): a project's own space. The founder approves a card, then the folder, git history, memory note and agents are made.
  // PODS_ROOT (an absolute path) wins over the folder main.js passes; with neither, a pod can be asked for but not opened.
  const pods = createPods({ store, audit, decisions, runtime, templatesDir: podTemplatesDir, root: env.PODS_ROOT || podsRoot, allowedRepos: (env.GITHUB_REPOS ?? '').split(',').map((r) => r.trim()).filter(Boolean), isBlocked, onError: () => runtime.emit('pods.error', {}) });
  // The project view's files panel (step 3.6): the founder reads, edits and adds files in a pod's folder; an edit is committed and locks the file for agents.
  const podFiles = createPodFiles({ store, audit, podFolder: (podId) => pods.folderFor(podId), isBlocked, emit });
  // The Filesystem tools read inside ONE folder: FILESYSTEM_ROOT, or the app's own folder when main.js passes it.
  // With neither there are no filesystem tools (never a default of "the whole disk").
  const filesystemTools = createFilesystemTools({ root: env.FILESYSTEM_ROOT || filesystemRoot, podFolder: (podId) => pods.folderFor(podId), podsRoot: env.PODS_ROOT || podsRoot });
  // Which of the available tools are used is decided by config/mcp/shared.yaml (an allow-list with a read/write tag
  // check that fails closed: without the file there are no tools). The policy rule is still required by the loader.
  // Every tool that exists. A team gets only the ones its configuration lists (shared.yaml plus <team>.yaml).
  const catalogue = [
    ...BUILTIN_TOOLS,
    ...filesystemTools,
    ...createFetchTools(),
    // GitHub only for the repositories named in GITHUB_REPOS (comma-separated owner/name), and only with a token.
    ...createGitHubTools({ token: env.GITHUB_TOKEN, repos: (env.GITHUB_REPOS ?? '').split(',').map((r) => r.trim()).filter(Boolean), fetchImpl, podRepo: (podId) => pods.repoFor(podId) }),
    ...createSupabaseTools({ store }),
    // Tools that work inside ONE pod (step 3.2): its own history, memory and client. The pod is the run's, never an argument; a team gets them only by listing them.
    ...createGitTools({ podFolder: (podId) => pods.folderFor(podId), podRepo: (podId) => pods.repoFor(podId), githubToken: env.GITHUB_TOKEN, remoteUrl: gitRemoteUrl }),
    ...createMemoryTools({ store }),
    ...createPodTools({ store }),
    // The Engineering team's own tools (step 3.3): writing a file in the pod's folder, library documentation (CONTEXT7_API_KEY is optional), and a
    // browser check of a public page (only when Playwright is installed: `npm i playwright && npx playwright install chromium`).
    // A file the founder has open in the project view is refused to agents until it is saved (step 3.6).
    ...createPodFileTools({ podFolder: (podId) => pods.folderFor(podId), isLocked: (q) => podFiles.isLocked(q) }),
    ...createContext7Tools({ apiKey: env.CONTEXT7_API_KEY, fetchImpl }),
    ...createBrowserTools({ driver: loadPlaywrightDriver() }),
    ...createOutboundTools({ outbound }),
    // The Marketing and Sales team's tools (step 2.3). Search needs TAVILY_API_KEY; Gmail and Drive need all three GOOGLE_*
    // settings (and only read mail, make drafts and save files: nothing sends mail); the lead list is our own `clients` table.
    ...createSearchTools({ apiKey: env.TAVILY_API_KEY, fetchImpl }),
    ...createCrmTools({ store }),
    ...createGoogleTools({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: env.GOOGLE_REFRESH_TOKEN, fetchImpl }),
    // The Support team's ticket tools (step 2.4). A reply is checked through the outbound service, never by reading its table.
    ...createTicketTools({ store, outbound }),
    // The Finance, Legal and Ops team's tool (step 3.4): a draft invoice with the GST worked out in code. There is no payment tool and no payment credential.
    ...createInvoiceTools(),
  ];
  const toolSelection = selectTools({ catalogue, config: loadToolConfig({ dir: toolConfigDir }) });
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

  // The agent factory (step 2.1) builds a team from `shared` plus the team's own tools and skills, and the Marketing and Sales
  // team (step 2.3) runs on it. Without a skills folder no team is built (the company charter is required). The team is built
  // the first time a lead is given to it, not at start.
  // The agents panel and live feed (step 3.7): every step an agent takes is saved to `agent_events` and announced as `agent.event`; the founder can pause an
  // agent, type it a note and move a waiting task. Trusted code only: an agent is never handed the control.
  const agentEvents = createAgentEvents({ store, emit });
  const agentControl = createAgentControl({ store, audit, events: agentEvents, emit, isBlocked });
  const agents = createAgentFactory({ router, store, audit, policy: policyTools.policy, catalogue, hasRule, configDir: toolConfigDir, skillsDir, limits: AGENT_LIMITS, onChange: () => runtime.emit('tasks.changed', {}), events: agentEvents, control: agentControl });
  const sales = createSalesTeam({ factory: agents, decisions, writeCard: createModelCardWriter({ router }), onError: () => runtime.emit('sales.error', {}) });
  // The Customer Support team (step 2.4): works one ticket from the `tickets` table; a refund, discount, complaint or legal matter
  // becomes a founder card and marks the ticket escalated.
  const support = createSupportTeam({ factory: agents, store, decisions, writeCard: createModelCardWriter({ router }), outbound, onError: () => runtime.emit('support.error', {}) });
  // The Engineering team (step 3.3): works one task inside one pod; a merge or a production deploy becomes a founder card tied to the pod.
  const engineering = createEngineeringTeam({ factory: agents, decisions, writeCard: createModelCardWriter({ router }), onError: () => runtime.emit('engineering.error', {}) });
  // The Finance, Legal and Ops team (step 3.4): drafts invoices and reads contracts; a payout, a signature or a legal document becomes a founder card (tied to the pod when there is one).
  const finance = createFinanceTeam({ factory: agents, decisions, writeCard: createModelCardWriter({ router }), onError: () => runtime.emit('finance.error', {}) });
  // The phone's follow-up after an answer comes from whichever team filed the card.
  const answers = { ...support, describeAnswer: async (decision) => (await support.describeAnswer(decision)) ?? (await engineering.describeAnswer(decision)) ?? (await finance.describeAnswer(decision)) };

  // The window's commands. They are registered here, after the orchestrator exists, because goals.list reads
  // the founder's goals from it.
  // The daily brief: the window's Brief panel and Telegram's /brief and morning digest all show the lines this builds.
  // Shared specialists (step 3.5): the queue they serve in, highest priority first. The brief reads it through this service and names every conflict.
  const specialists = createSpecialists({ store, audit, isBlocked });
  const brief = createBrief({ store, decisions, specialists });
  const teamsOverview = createTeamsOverview({ store });
  // Starting a team from the window: it starts the job at once and announces how it ended as the runtime event `team.job_finished`.
  const jobs = createTeamJobs({ sales, support, emit, onError: () => runtime.emit('teams.error', {}) });
  registerCommands(runtime, { store, version, decisions, orchestrator, teams: teamsOverview, brief, jobs, podFiles, pods, agentControl, agentEvents });

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
    brief,
    teams: teamsOverview,
    sales,
    support: answers,
    audit,
    onError: () => runtime.emit('telegram.error', {}),
  });
  const telegramIssue = telegramProblem(env); // a setting that is wrong must be said, not silently ignored
  const digestIssue = digestProblem(env);

  return {
    runtime,
    store,
    decisions,
    policyTools,
    router,
    telegram,
    orchestrator,
    outbound,
    agents,
    sales,
    support,
    engineering,
    finance,
    specialists,
    pods,
    podFiles,
    agentControl,
    agentEvents,
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
        if (digestIssue) runtime.emit('digest.problem', { message: digestIssue });
        telegram?.start();
        orchestrator.start(); // listens for answers, then recovers waiting runs in the background
        pods.start(); // listens for the founder's answers on pod cards, then opens any approved one that has no pod yet
        outbound.start(); // listens for the founder's answers on outbound messages, then applies any given while closed
        if (approval.problem) runtime.emit('outbound.problem', { message: approval.problem });
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
      outbound.stop();
      pods.stop();
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
