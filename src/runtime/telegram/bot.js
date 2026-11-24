'use strict';

// The Telegram bot core (PLAN.md step 1.8): a thin layer over the decisions service and
// the policy tools. It holds no rules of its own. What it does:
//   - answers only the founder: the chat AND the sender must be the founder's id, and
//     anyone else gets no reply at all (a reply would tell a stranger the bot exists)
//   - pushes decision cards with Approve and Reject buttons, and resolves taps through
//     the decisions service as `via: 'telegram'`
//   - /tools, /addtool, /removetool, and "Add this tool" buttons on unknown-tool cards;
//     anything that loosens the rules waits for a Yes tap
// All text is plain (no parse mode), so nothing a card says can be read as formatting.
// Errors shown to the founder are only the ones written for the founder (DecisionError,
// PolicyToolError); anything else becomes a generic sentence, so a raw error, which can
// hold a key, never reaches the chat.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_MESSAGE_CHARS = 4096;
const MAX_FIELD_CHARS = 500;
const MAX_TOAST_CHARS = 190; // Telegram allows 200 for a callback answer

const SAFE_ERROR_NAMES = ['DecisionError', 'PolicyToolError'];
const GENERIC_ERROR = 'Something went wrong and nothing was changed. You can try again, or use the dashboard.';

// What the founder types, what the policy check calls it, and the one letter used in button data.
const ASK_CATEGORIES = {
  spend: { category: 'spend', code: 's', label: 'spend' },
  people: { category: 'people_or_contracts', code: 'p', label: 'people or contracts' },
  launch: { category: 'launch_or_pricing', code: 'l', label: 'launch or pricing' },
  legal: { category: 'legal_or_public', code: 'g', label: 'legal or public' },
};
const CATEGORY_BY_CODE = Object.fromEntries(Object.values(ASK_CATEGORIES).map((c) => [c.code, c]));
const CATEGORY_LABEL = Object.fromEntries(Object.values(ASK_CATEGORIES).map((c) => [c.category, c.label]));
const ACCESS_BY_CODE = { r: 'read', w: 'write' };

const NOT_YET = {
  brief: 'The morning brief is not available yet. It arrives once the teams are running.',
  status: 'Team status is not available yet. It arrives once the teams are running.',
  pause: 'Pausing an agent is not available yet. It arrives with the agent controls.',
};

const HELP = [
  'What I can do:',
  '/tools - list the tools you have added',
  '/addtool <tool> ask <spend|people|launch|legal> - always ask you first',
  '/addtool <tool> routine <read|write> - let it run without asking (needs your Yes)',
  '/removetool <tool> - remove a tool you added',
  '/goal <what you want done> - give the team a goal',
  '/brief - morning brief (not available yet)',
  '/status <team> - team status (not available yet)',
  '/pause <agent> - pause an agent (not available yet)',
  '/help - this list',
].join('\n');

const HINT = 'I did not understand that. Send /help to see what I can do.';

// /goal. Planning takes a while (a model call or two), so a goal runs in the background and its result
// arrives as a second message; the bot keeps answering taps and commands meanwhile. A few at a time at most,
// so a burst of commands cannot flood the model.
const MAX_GOAL_CHARS = 2000;
const MAX_GOALS_AT_ONCE = 3;
const MAX_LOG_LINE_CHARS = 300;
const GOAL_USAGE = 'Usage: /goal <what you want done>\nFor example: /goal Buy a domain for the new landing page';

/** The founder-facing summary of a run: fixed sentences plus the plan's own plain-text log lines. */
function describeRun(result) {
  if (!result || typeof result !== 'object') return 'The run stopped.';
  if (result.status === 'failed') return clip(`I could not start that. ${typeof result.message === 'string' ? result.message : ''}`, 600);
  // "Finished" must not hide that a task did not go ahead (a card that could not be written, a tool that is not
  // known, an action that failed). Those are said first, with a count; a task you rejected is your own choice.
  const results = Array.isArray(result.results) ? result.results : [];
  const stuck = results.filter((r) => typeof r?.outcome === 'string' && (r.outcome.startsWith('blocked_') || r.outcome === 'failed')).length;
  const finished = stuck > 0 ? `Finished, but ${stuck} task${stuck === 1 ? '' : 's'} did not go ahead.` : 'Finished.';
  const head = { waiting: 'The plan is under way and waiting for your decision (the card is in this chat).', done: finished }[result.status] ?? 'The run stopped.';
  const lines = (Array.isArray(result.log) ? result.log : []).filter((l) => typeof l === 'string').map((l) => `- ${clip(l, MAX_LOG_LINE_CHARS)}`);
  // Text a task produced (a draft, a script) is sent as it is, below the summary, with its line breaks kept.
  const outputs = results.filter((r) => typeof r?.output === 'string' && r.output !== '').map((r) => `${clip(r.title, MAX_LOG_LINE_CHARS)}:\n${r.output}`);
  return [clip([head, ...lines].join('\n'), MAX_MESSAGE_CHARS), ...outputs].join('\n\n').slice(0, MAX_MESSAGE_CHARS);
}
const ADDTOOL_USAGE = 'Usage:\n/addtool <tool> ask <spend|people|launch|legal>\n/addtool <tool> routine <read|write>';
const REMOVETOOL_USAGE = 'Usage:\n/removetool <tool>';

// A tool name taken from an agent's request is only shown to the founder if it looks like a tool name.
const TOOL_NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i;
const MAX_TOOL_NAME_CHARS = 100;
const ODD_TOOL = 'That tool name looks unusual, so I did not add it. Use /addtool with the exact name.';

const clip = (value, max) => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const isFounderId = (value, founder) => typeof value === 'number' && value === founder;

// The store's own message is never shown. A few of its short codes get a sentence written here,
// because the founder can do something about them.
const STORE_PROBLEMS = Object.freeze({
  missing_table: 'The database is missing a table this needs. Apply the database migrations (npm run db:migrate), then restart the app.',
  unreachable: 'I could not reach the database. Check the internet connection and try again.',
  unauthorized: 'The database rejected the key. Check SUPABASE_SERVICE_ROLE_KEY in the .env file, then restart the app.',
});

function safeMessage(err) {
  if (err?.name === 'StoreError' && Object.hasOwn(STORE_PROBLEMS, err.code)) return STORE_PROBLEMS[err.code];
  return SAFE_ERROR_NAMES.includes(err?.name) && typeof err.message === 'string' ? clip(err.message, MAX_FIELD_CHARS) : GENERIC_ERROR;
}

function renderCard(decision, heading) {
  const card = decision.card ?? {};
  const risk = card.risk ?? {};
  const lines = [
    heading,
    clip(card.decide, MAX_FIELD_CHARS),
    '',
    `Why now: ${clip(card.why_now, MAX_FIELD_CHARS)}`,
    `If you approve: ${clip(card.if_yes, MAX_FIELD_CHARS)}`,
    `If you reject: ${clip(card.if_no, MAX_FIELD_CHARS)}`,
    `Cost: ${clip(card.cost, MAX_FIELD_CHARS)}`,
    `Risk: ${clip(risk.level, 20)} - ${clip(risk.reason, MAX_FIELD_CHARS)}`,
    `My recommendation: ${clip(card.recommendation, MAX_FIELD_CHARS)}`,
  ];
  return clip(lines.join('\n'), MAX_MESSAGE_CHARS);
}

const decideButtons = (id) => [[{ text: 'Approve', data: `d:a:${id}` }, { text: 'Reject', data: `d:r:${id}` }]];

function unknownToolButtons(id) {
  const ask = Object.values(ASK_CATEGORIES).map((c) => ({ text: `Always ask me: ${c.label}`, data: `ta:${c.code}:${id}` }));
  return [
    [ask[0], ask[1]],
    [ask[2], ask[3]],
    [{ text: 'Add: let it run without asking (read only)', data: `tr:r:${id}` }],
    [{ text: 'Add: let it run without asking (can change things)', data: `tr:w:${id}` }],
  ];
}

/** Read the bot's own button data. Returns null for anything that is not exactly one of its formats. */
function parseData(data) {
  if (typeof data !== 'string' || data.length > 64) return null;
  const parts = data.split(':');
  const [kind, a, b] = parts;
  if (kind === 'd' && parts.length === 3 && (a === 'a' || a === 'r') && UUID.test(b)) return { kind: 'decide', decision: a === 'a' ? 'approved' : 'rejected', id: b };
  if (kind === 'ta' && parts.length === 3 && CATEGORY_BY_CODE[a] && UUID.test(b)) return { kind: 'addAsk', category: CATEGORY_BY_CODE[a].category, id: b };
  if (kind === 'tr' && parts.length === 3 && ACCESS_BY_CODE[a] && UUID.test(b)) return { kind: 'addRoutine', access: ACCESS_BY_CODE[a], id: b };
  if ((kind === 'pc' || kind === 'pn') && parts.length === 2 && UUID.test(a)) return { kind: kind === 'pc' ? 'confirm' : 'cancel', id: a };
  return null;
}

function parseCommand(text) {
  if (typeof text !== 'string' || !text.startsWith('/')) return null;
  const trimmed = text.trim();
  const [head, ...args] = trimmed.split(/\s+/);
  // `rest` is everything after the command exactly as typed (a goal keeps its line breaks).
  return { cmd: head.slice(1).split('@')[0].toLowerCase(), args, rest: trimmed.slice(head.length).trim() };
}

function describeRule(rule) {
  const base =
    rule.kind === 'ask'
      ? `always asks you (${CATEGORY_LABEL[rule.category] ?? 'needs you'})`
      : `runs without asking (${rule.access === 'read' ? 'read only' : 'can change things'})`;
  return rule.status === 'proposed' ? `${base} - waiting for your Yes` : base;
}

function createBot({ api, founderChatId, decisions, policyTools, orchestrator, onError = () => {} }) {
  const founder = Number(founderChatId);
  const reply = (text, buttons) => api.sendMessage({ chatId: founder, text, buttons });
  const toast = (callbackId, text) => api.answerCallback({ id: callbackId, text: clip(text, MAX_TOAST_CHARS) });

  // ---- cards ------------------------------------------------------------------

  async function sendCard(decision, heading) {
    if (!decision || decision.status !== 'pending') return null;
    if (typeof decision.id !== 'string' || !UUID.test(decision.id)) throw new Error('the decision has no valid id');
    const buttons = decision.category === 'unknown' ? [...decideButtons(decision.id), ...unknownToolButtons(decision.id)] : decideButtons(decision.id);
    return api.sendMessage({ chatId: founder, text: renderCard(decision, heading), buttons });
  }

  const pushCard = (decision) => sendCard(decision, 'Decision needed');
  const notifyReminder = (decision) => sendCard(decision, 'Reminder: this is still waiting for you.');

  // ---- policy table ---------------------------------------------------------------

  async function askToConfirmRoutine(rule) {
    if (rule.status === 'active') return reply(`"${rule.tool}" already runs without asking you.`);
    const what = rule.access === 'read' ? 'only read things' : 'read and change things';
    return reply(`Let "${rule.tool}" run without asking you first? It would ${what} on its own.`, [
      [{ text: 'Yes, let it run', data: `pc:${rule.id}` }, { text: 'No, keep asking me', data: `pn:${rule.id}` }],
    ]);
  }

  async function addTool(tool, kind, third) {
    if (kind === 'ask') {
      const chosen = ASK_CATEGORIES[third?.toLowerCase()];
      if (!chosen) return reply(ADDTOOL_USAGE);
      const rule = await policyTools.propose({ tool, kind: 'ask', category: chosen.category, via: 'telegram' });
      return reply(`Done. "${rule.tool}" will always ask you first (${chosen.label}).`);
    }
    if (kind === 'routine') {
      const access = third?.toLowerCase();
      if (access !== 'read' && access !== 'write') return reply(ADDTOOL_USAGE);
      return askToConfirmRoutine(await policyTools.propose({ tool, kind: 'routine', access, via: 'telegram' }));
    }
    return reply(ADDTOOL_USAGE);
  }

  // ---- goals ----------------------------------------------------------------------------

  let goalsRunning = 0;

  /** Runs in the background. It never rejects: a failure goes to onError and the founder gets a plain sentence. */
  async function runGoal(goal) {
    try {
      await reply(describeRun(await orchestrator.submitGoal({ goal })));
    } catch (err) {
      onError(err);
      try {
        await reply(GENERIC_ERROR);
      } catch (replyErr) {
        onError(replyErr);
      }
    } finally {
      goalsRunning -= 1;
    }
  }

  async function startGoal(goal) {
    if (!orchestrator) return reply('Goals are not available right now.');
    if (goal === '') return reply(GOAL_USAGE);
    if (goal.length > MAX_GOAL_CHARS) return reply(`That goal is too long. Please keep it under ${MAX_GOAL_CHARS} characters.`);
    if (goalsRunning >= MAX_GOALS_AT_ONCE) return reply(`I am already working on ${MAX_GOALS_AT_ONCE} goals. Please wait for one to finish.`);
    goalsRunning += 1;
    runGoal(goal); // not awaited on purpose: planning takes a while, and taps must not wait behind it
    return reply('Working on it. I will message you here when the plan is ready or needs you.');
  }

  async function runCommand({ cmd, args, rest }) {
    switch (cmd) {
      case 'start':
      case 'help':
        return reply(HELP);
      case 'goal':
        return startGoal(rest);
      case 'brief':
      case 'status':
      case 'pause':
        return reply(NOT_YET[cmd]);
      case 'tools': {
        const rules = await policyTools.list();
        if (rules.length === 0) return reply('You have not added any tools. The built-in rules always apply.');
        return reply(`Tools you added:\n${rules.map((r) => `- ${r.tool}: ${describeRule(r)}`).join('\n')}`);
      }
      case 'addtool':
        if (args.length !== 3) return reply(ADDTOOL_USAGE);
        return addTool(args[0], args[1].toLowerCase(), args[2]);
      case 'removetool': {
        if (args.length !== 1) return reply(REMOVETOOL_USAGE);
        const removed = await policyTools.remove({ tool: args[0], via: 'telegram' });
        return reply(`Removed the rule for "${removed.tool}". It will ask you first again.`);
      }
      default:
        return reply(HINT);
    }
  }

  async function handleMessage(message) {
    if (!isFounderId(message.chat?.id, founder) || !isFounderId(message.from?.id, founder)) return;
    if (typeof message.text !== 'string') return;
    const command = parseCommand(message.text);
    if (!command) {
      await reply(HINT);
      return;
    }
    try {
      await runCommand(command);
    } catch (err) {
      onError(err); // the founder sees a safe sentence; the operator still gets the cause
      await reply(safeMessage(err));
    }
  }

  /**
   * Show the outcome of something that has ALREADY happened. Nothing here may claim it did not:
   * if the message cannot be edited the outcome is sent as a new message, and a failure to answer
   * the tap is only reported.
   */
  async function finish({ callbackId, messageId, text, toastText }) {
    try {
      await api.editMessage({ chatId: founder, messageId, text });
    } catch (err) {
      onError(err);
      try {
        await reply(text);
      } catch (err2) {
        onError(err2);
      }
    }
    try {
      await toast(callbackId, toastText);
    } catch (err) {
      onError(err);
    }
  }

  const usableToolName = (value) => (typeof value === 'string' && value.length <= MAX_TOOL_NAME_CHARS && TOOL_NAME.test(value) ? value : null);

  // ---- taps -------------------------------------------------------------------------

  async function handleDecide({ id, decision }, callbackId, messageId) {
    const result = await decisions.resolve({ id, decision, via: 'telegram' });
    const row = await decisions.get(id).catch(() => null);
    const title = clip(row?.card?.decide, MAX_FIELD_CHARS);
    const headline = result.changed
      ? `${decision === 'approved' ? 'Approved' : 'Rejected'}. You answered this on Telegram.`
      : `Already ${result.status}. It was answered before your tap, so nothing changed.`;
    await finish({
      callbackId,
      messageId,
      text: title ? `${headline}\n${title}` : headline,
      toastText: result.changed ? `${decision === 'approved' ? 'Approved' : 'Rejected'}.` : `Already ${result.status}.`,
    });
  }

  async function handleAddAsk({ id, category }, callbackId) {
    const row = await decisions.get(id);
    const tool = usableToolName(row?.action?.tool);
    if (!tool) {
      await toast(callbackId, ODD_TOOL);
      return;
    }
    const rule = await policyTools.propose({ tool, kind: 'ask', category, via: 'telegram' });
    await reply(`Done. "${rule.tool}" will always ask you first (${CATEGORY_LABEL[category]}).`);
    await toast(callbackId, 'Added.');
  }

  async function handleAddRoutine({ id, access }, callbackId) {
    const row = await decisions.get(id);
    const tool = usableToolName(row?.action?.tool);
    if (!tool) {
      await toast(callbackId, ODD_TOOL);
      return;
    }
    await askToConfirmRoutine(await policyTools.propose({ tool, kind: 'routine', access, via: 'telegram' }));
    await toast(callbackId, 'Please confirm.');
  }

  async function handleConfirm({ id }, callbackId, messageId) {
    const result = await policyTools.confirm({ id, via: 'telegram' });
    const text = result.changed ? `Done. "${result.tool}" now runs without asking you.` : `Nothing changed. That request is already ${result.status}.`;
    await finish({ callbackId, messageId, text, toastText: result.changed ? 'Confirmed.' : 'Nothing changed.' });
  }

  async function handleCancel({ id }, callbackId, messageId) {
    const result = await policyTools.cancel({ id, via: 'telegram' });
    const text = result.changed ? `Cancelled. "${result.tool}" will still ask you first.` : `Nothing changed. That request is already ${result.status}.`;
    await finish({ callbackId, messageId, text, toastText: result.changed ? 'Cancelled.' : 'Nothing changed.' });
  }

  const TAP_HANDLERS = { decide: handleDecide, addAsk: handleAddAsk, addRoutine: handleAddRoutine, confirm: handleConfirm, cancel: handleCancel };

  async function handleCallback(query) {
    if (!isFounderId(query.from?.id, founder) || !isFounderId(query.message?.chat?.id, founder)) return;
    if (typeof query.id !== 'string') return;

    const parsed = parseData(query.data);
    if (!parsed) {
      await toast(query.id, 'That button is no longer valid.');
      return;
    }
    try {
      await TAP_HANDLERS[parsed.kind](parsed, query.id, query.message.message_id);
    } catch (err) {
      await toast(query.id, safeMessage(err));
    }
  }

  /** Handle one Telegram update. Never throws: a failure goes to `onError`. */
  async function handleUpdate(update) {
    try {
      if (update?.callback_query) await handleCallback(update.callback_query);
      else if (update?.message) await handleMessage(update.message);
    } catch (err) {
      onError(err);
    }
  }

  return { handleUpdate, pushCard, notifyReminder };
}

module.exports = { createBot };
