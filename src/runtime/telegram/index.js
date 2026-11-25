'use strict';

// Ties the Telegram bot to the runtime (PLAN.md step 1.8): polls for the founder's
// messages and taps, pushes each new decision card to the phone, and chases cards that
// are still waiting. It does nothing unless both settings are present, so a missing
// token or chat id never stops the rest of the app (telegramProblem says what is wrong).
//
// Delivery: a card whose send fails is retried a few times with a growing wait; cards
// that were already waiting when the app started are pushed once on start; and a card
// the founder has never been sent is sent as a card, not as a "reminder" for something
// they never saw. After a restart a card that is still waiting is sent again, which is
// safe (answering twice changes nothing) and better than a card that never arrives.

const { startReminderJob } = require('../decisions');
const { createTelegramApi } = require('./api');
const { createBot } = require('./bot');
const { createPoller } = require('./poller');
const { renderBriefText } = require('../brief');
const { renderStatusText } = require('../teams/overview');
const { parseDigestTime, startDigestJob } = require('./digest');

const MAX_PUSH_RETRIES = 3;
const PUSH_RETRY_MS = 2000;
const MAX_PENDING_ON_START = 20;

const clean = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
// A private chat id is a plain positive number. A group id is negative, and a bot that
// compares the sender with the group could never match, so it is refused up front.
const CHAT_ID = /^\d+$/;

/**
 * Why Telegram will not start, in a sentence that names the setting and never its value;
 * null when it is fine or deliberately off (neither setting present).
 */
function telegramProblem(env) {
  const token = clean(env.TELEGRAM_BOT_TOKEN);
  const chatId = clean(env.TELEGRAM_FOUNDER_CHAT_ID);
  if (!token && !chatId) return null;
  if (!token) return 'TELEGRAM_BOT_TOKEN is not set, so the Telegram bot is off.';
  if (!chatId) return 'TELEGRAM_FOUNDER_CHAT_ID is not set, so the Telegram bot is off.';
  if (!CHAT_ID.test(chatId)) {
    return 'TELEGRAM_FOUNDER_CHAT_ID must be the number of your private chat with the bot (a group chat will not work), so the Telegram bot is off.';
  }
  return null;
}

/** Returns null when Telegram is not set up. `start()` begins work; `stop()` ends it. */
function createTelegramService({ env, decisions, policyTools, orchestrator, runtime, store, fetchImpl, sleep, brief, teams, sales, support, audit, onError = () => {} }) {
  if (telegramProblem(env) !== null) return null;
  const token = clean(env.TELEGRAM_BOT_TOKEN);
  const chatId = clean(env.TELEGRAM_FOUNDER_CHAT_ID);
  if (!token || !chatId) return null;

  const api = createTelegramApi({ token, fetchImpl });
  // /brief and the morning digest send the same text the window shows: it is built from the brief's own lines.
  const briefText = brief ? async () => renderBriefText(await brief.get()) : undefined;
  // /status shows the same overview as the window's Teams page.
  const statusText = teams ? async (query) => renderStatusText(await teams.list(), query) : undefined;
  const bot = createBot({ api, founderChatId: chatId, decisions, policyTools, orchestrator, briefText, statusText, sales, support, onError });
  const digestSetting = parseDigestTime(env.DIGEST_TIME_IST);
  // A day's send is written to the audit log, so a restart the same day does not send it again.
  const ledger = store && audit ? {
    async lastSentDate() {
      const [row] = await store.select('audit_log', { where: { action: 'digest.sent' }, order: 'id.desc', limit: 1 });
      return typeof row?.detail?.date === 'string' ? row.detail.date : null;
    },
    record: (action, detail) => audit.append({ actorType: 'system', action, detail }),
  } : null;
  let digest = null;
  const poller = createPoller({ api, handle: bot.handleUpdate, sleep, onError });

  const delivered = new Set(); // ids of cards sent to the phone during this run
  let unsubscribe = null;
  let unsubscribeRuns = null;
  let reminders = null;
  let stopped = true;

  async function push(decision) {
    const sent = await bot.pushCard(decision);
    if (sent) delivered.add(decision.id);
    return sent;
  }

  /** A reminder for a card never sent is sent as the card itself. */
  const notifyReminder = (decision) => (delivered.has(decision.id) ? bot.notifyReminder(decision) : push(decision));

  async function deliver(id, attempt = 0) {
    try {
      await push(await decisions.get(id));
    } catch (err) {
      onError(err);
      if (attempt < MAX_PUSH_RETRIES && !stopped) {
        await sleep(PUSH_RETRY_MS * 2 ** attempt);
        if (!stopped) await deliver(id, attempt + 1);
      }
    }
  }

  async function pushWaitingCards() {
    try {
      const waiting = await store.select('decisions', { where: { status: 'pending' }, order: 'created_at.asc', limit: MAX_PENDING_ON_START });
      for (const decision of waiting) {
        if (stopped) return;
        if (!delivered.has(decision.id)) await deliver(decision.id);
      }
    } catch (err) {
      onError(err);
    }
  }

  return {
    bot,
    notifyReminder,

    start() {
      stopped = false;
      unsubscribe = runtime.on('decision.created', ({ id }) => deliver(id));
      // A run that ends after the founder's answer (a tap on the phone or a click on the dashboard) is reported here.
      unsubscribeRuns = orchestrator?.onRunFinished?.((result) => bot.announceRun(result).catch(onError)) ?? null;
      reminders = startReminderJob({ service: decisions, notify: notifyReminder, onError });
      poller.start().catch(onError); // runs until stop()
      if (store) pushWaitingCards();
      // The morning digest: once a day at DIGEST_TIME_IST (default 09:00 IST, "off" turns it off). Needs the brief and the audit log.
      if (briefText && ledger && digestSetting.ok && !digestSetting.off) {
        digest = startDigestJob({ time: digestSetting.time, getText: briefText, send: bot.announce, ledger, onError });
      }
    },

    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribeRuns?.();
      reminders?.stop();
      digest?.stop();
      digest = null;
      poller.stop();
      unsubscribe = null;
      unsubscribeRuns = null;
      reminders = null;
    },
  };
}

/** Why the morning digest will not run, in a sentence that names the setting and never its value; null when it is fine or deliberately off. */
function digestProblem(env) {
  return parseDigestTime(env?.DIGEST_TIME_IST).problem ?? null;
}

module.exports = { createTelegramService, telegramProblem, digestProblem };
