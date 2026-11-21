#!/usr/bin/env node
'use strict';

// PLAN.md step 0.1: checks that the accounts and keys in .env work, with one
// harmless read-only call each. Never prints a secret value.
//
//   npm run check:keys                      check everything
//   npm run check:keys -- --find-telegram-chat   list chats that messaged your bot
//
// Exit code 1 when a required item is not OK. Optional items only warn.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TIMEOUT_MS = 8000;

/** Replace every secret value in `text` so errors can be printed safely. */
function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}

// One shared copy, also used by the runtime.
const { supabaseUrlAllowed } = require('../src/shared/supabase-url');

const ok = (name, detail) => ({ name, status: 'ok', detail });
const fail = (name, detail, required = true) => ({ name, status: required ? 'fail' : 'warn', detail });
const missing = (name, detail, required = true) => ({ name, status: required ? 'missing' : 'warn', detail });

async function call(url, options, secrets, fetchImpl) {
  try {
    return { res: await fetchImpl(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) }) };
  } catch (err) {
    return { error: redact(err.cause?.code || err.message, secrets) };
  }
}

async function checkGroq(env, fetchImpl = fetch) {
  const name = 'Groq key (GROQ_API_KEY)';
  const key = env.GROQ_API_KEY;
  if (!key) return missing(name, 'not set: get a key at console.groq.com, under API Keys');
  const { res, error } = await call(
    'https://api.groq.com/openai/v1/models',
    { headers: { Authorization: `Bearer ${key}` } },
    [key],
    fetchImpl,
  );
  if (error) return fail(name, `could not reach Groq (${error})`);
  if (res.status === 401) return fail(name, 'Groq rejected the key (401): check it was copied in full');
  if (!res.ok) return fail(name, `Groq answered ${res.status}`);
  const body = await res.json().catch(() => ({}));
  return ok(name, `key accepted, ${body.data?.length ?? '?'} models available`);
}

async function checkTelegramToken(env, fetchImpl = fetch) {
  const name = 'Telegram bot token (TELEGRAM_BOT_TOKEN)';
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return missing(name, 'not set: message @BotFather on Telegram, send /newbot, copy the token');
  const { res, error } = await call(`https://api.telegram.org/bot${token}/getMe`, {}, [token], fetchImpl);
  if (error) return fail(name, `could not reach Telegram (${error})`);
  if (res.status === 401 || res.status === 404) return fail(name, 'Telegram rejected the token: check it was copied in full');
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) return fail(name, `Telegram answered ${res.status}`);
  return ok(name, `bot @${body.result.username}`);
}

async function checkTelegramChat(env, fetchImpl = fetch) {
  const name = 'Founder chat ID (TELEGRAM_FOUNDER_CHAT_ID)';
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_FOUNDER_CHAT_ID;
  if (!chat) return missing(name, 'not set: send your bot a message, then run: npm run check:keys -- --find-telegram-chat');
  if (!/^-?\d+$/.test(chat)) return fail(name, 'must be a number, such as 123456789');
  if (!token) return missing(name, 'cannot check without TELEGRAM_BOT_TOKEN');
  const { res, error } = await call(
    `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chat)}`,
    {},
    [token],
    fetchImpl,
  );
  if (error) return fail(name, `could not reach Telegram (${error})`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) return fail(name, 'the bot cannot see that chat: send your bot a message first, or the ID is wrong');
  return ok(name, `${body.result.type} chat`);
}

async function checkSupabase(env, fetchImpl = fetch) {
  const name = 'Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)';
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = env;
  if (!url || !key) return missing(name, 'not set: create a project at supabase.com, then copy the URL and the service_role key from Project Settings, API');
  if (!supabaseUrlAllowed(url)) {
    return fail(name, 'SUPABASE_URL must look like https://<project>.supabase.co; the key was NOT sent anywhere');
  }
  const { res, error } = await call(
    `${url.replace(/\/$/, '')}/rest/v1/`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    [key],
    fetchImpl,
  );
  if (error) return fail(name, `could not reach Supabase (${error})`);
  if (res.status === 401 || res.status === 403) return fail(name, `Supabase rejected the key (${res.status}): check it is the service_role key`);
  if (!res.ok) return fail(name, `Supabase answered ${res.status}`);
  return ok(name, 'project reachable, key accepted');
}

async function checkOllama(env, fetchImpl = fetch) {
  const name = 'Ollama (local fallback)';
  const base = env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const { res, error } = await call(`${base.replace(/\/$/, '')}/api/tags`, {}, [], fetchImpl);
  if (error || !res.ok) return fail(name, `not reachable at ${base}: start it with "ollama serve"`, false);
  const body = await res.json().catch(() => ({}));
  const cloud = (body.models || []).filter((m) => /:cloud$/.test(m.name)).length;
  return ok(name, `${body.models?.length ?? 0} models${cloud ? ` (${cloud} are :cloud models and not private)` : ''}`);
}

function checkClaudeCli() {
  const name = 'Claude Code CLI (last fallback)';
  try {
    const v = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: TIMEOUT_MS }).trim();
    return ok(name, v);
  } catch {
    return fail(name, '`claude` not found on PATH', false);
  }
}

function checkGitHygiene() {
  const name = 'Secrets stay out of git';
  try {
    const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    let ignored = true;
    try {
      git('check-ignore', '-q', '.env');
    } catch {
      ignored = false;
    }
    const tracked = git('ls-files').split('\n').filter((f) => /(^|\/)\.env($|\.)/.test(f) && !f.endsWith('.env.example'));
    if (!ignored) return fail(name, '.env is NOT gitignored');
    if (tracked.length) return fail(name, `tracked secret files: ${tracked.join(', ')}`);
    return ok(name, '.env is ignored and no .env file is tracked');
  } catch (err) {
    return fail(name, `could not run git (${err.message})`, false);
  }
}

async function findTelegramChats(env, fetchImpl = fetch) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { error: 'Set TELEGRAM_BOT_TOKEN in .env first.' };
  const { res, error } = await call(`https://api.telegram.org/bot${token}/getUpdates`, {}, [token], fetchImpl);
  if (error) return { error: `could not reach Telegram (${error})` };
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) return { error: `Telegram answered ${res.status}` };
  const chats = new Map();
  for (const u of body.result) {
    const c = (u.message || u.edited_message || u.channel_post || {}).chat;
    if (c) chats.set(c.id, { id: c.id, type: c.type, who: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || c.username || '' });
  }
  return { chats: [...chats.values()] };
}

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return null;
  process.loadEnvFile(file);
  return process.env;
}

const ICON = { ok: 'OK     ', fail: 'FAIL   ', missing: 'MISSING', warn: 'WARN   ' };

async function main(argv) {
  const env = loadEnv();
  if (!env) {
    const git = checkGitHygiene();
    console.log('No .env yet. Create it with:  cp .env.example .env   then fill in the values.');
    console.log(`${ICON[git.status]} ${git.name}: ${git.detail}`);
    return 1;
  }

  if (argv.includes('--find-telegram-chat')) {
    const { chats, error } = await findTelegramChats(env);
    if (error) {
      console.log(error);
      return 1;
    }
    if (!chats.length) {
      console.log('No messages found. Open your bot in Telegram, press Start (or send "hi"), then run this again.');
      return 1;
    }
    console.log('Chats that messaged your bot (put YOUR chat id in TELEGRAM_FOUNDER_CHAT_ID):');
    for (const c of chats) console.log(`  ${c.id}  ${c.type}  ${c.who}`);
    return 0;
  }

  const results = [
    await checkGroq(env),
    await checkTelegramToken(env),
    await checkTelegramChat(env),
    await checkSupabase(env),
    await checkOllama(env),
    checkClaudeCli(),
    checkGitHygiene(),
  ];
  for (const r of results) console.log(`${ICON[r.status]} ${r.name}: ${r.detail}`);
  const bad = results.filter((r) => r.status === 'fail' || r.status === 'missing');
  console.log(bad.length ? `\n${bad.length} item(s) need attention before step 0.1 is done.` : '\nStep 0.1 checks all pass.');
  return bad.length ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = {
  redact,
  supabaseUrlAllowed,
  checkGroq,
  checkTelegramToken,
  checkTelegramChat,
  checkSupabase,
  checkOllama,
  findTelegramChats,
};
