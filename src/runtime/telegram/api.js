'use strict';

// A thin client for the Telegram Bot API (PLAN.md step 1.8). The token has to be in the
// URL path (that is how Telegram works), so it is kept out of every other place: no
// error message, stack or log line made here ever holds it, and nor does a response body.

const API_ROOT = 'https://api.telegram.org';
const REQUEST_SLACK_SECONDS = 10; // a long poll may legitimately take its full timeout

function createTelegramApi({ token, fetchImpl = globalThis.fetch } = {}) {
  async function call(method, body, timeoutSeconds = 30) {
    const key = typeof token === 'string' ? token.trim() : '';
    if (!key) throw new Error('telegram is not configured');

    let response;
    try {
      response = await fetchImpl(`${API_ROOT}/bot${key}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout((timeoutSeconds + REQUEST_SLACK_SECONDS) * 1000),
      });
    } catch {
      throw new Error(`telegram ${method} failed (network)`);
    }
    if (!response.ok) throw new Error(`telegram ${method} failed (${response.status})`);

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`telegram ${method} returned an unreadable answer`);
    }
    if (!data || data.ok !== true) throw new Error(`telegram ${method} was refused (${Number.isInteger(data?.error_code) ? data.error_code : 'no code'})`);
    return data.result;
  }

  const keyboard = (buttons) => ({ inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) });

  return {
    async getUpdates({ offset = 0, timeout = 25 } = {}) {
      const result = await call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, timeout);
      return Array.isArray(result) ? result : [];
    },

    async sendMessage({ chatId, text, buttons }) {
      const body = { chat_id: chatId, text, link_preview_options: { is_disabled: true } };
      if (buttons && buttons.length > 0) body.reply_markup = keyboard(buttons);
      const result = await call('sendMessage', body);
      return { messageId: result?.message_id };
    },

    /** Replaces a message's text. Leaving `buttons` out removes the buttons. */
    async editMessage({ chatId, messageId, text, buttons }) {
      const body = { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true } };
      if (buttons && buttons.length > 0) body.reply_markup = keyboard(buttons);
      await call('editMessageText', body);
    },

    async answerCallback({ id, text }) {
      const body = { callback_query_id: id };
      if (text) body.text = text;
      await call('answerCallbackQuery', body);
    },
  };
}

module.exports = { createTelegramApi };
