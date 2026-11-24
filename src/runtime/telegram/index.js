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
function createTelegramService({ env, decisions, policyTools, orchestrator, runtime, store, fetchImpl, sleep, onError = () => {} }) {
  if (telegramProblem(env) !== null) return null;
  const token = clean(env.TELEGRAM_BOT_TOKEN);
  const chatId = clean(env.TELEGRAM_FOUNDER_CHAT_ID);
  if (!token || !chatId) return null;

  const api = createTelegramApi({ token, fetchImpl });
  const bot = createBot({ api, founderChatId: chatId, decisions, policyTools, orchestrator, onError });
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
    },

    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribeRuns?.();
      reminders?.stop();
      poller.stop();
      unsubscribe = null;
      unsubscribeRuns = null;
      reminders = null;
    },
  };
}

module.exports = { createTelegramService, telegramProblem };
