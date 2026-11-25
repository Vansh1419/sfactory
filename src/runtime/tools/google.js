'use strict';

// The Gmail and Drive tools (PLAN.md step 2.3: "Gmail and Drive"). Graded by the `google-tools` eval.
//
//   gmail.search        { query, count? }            read    finds messages in the founder's mailbox: date, sender, subject, snippet
//   gmail.create_draft  { to, subject, body }        write   puts a DRAFT in the founder's Drafts folder. It is NEVER sent from here
//   drive.list_files    { name?, count? }            read    lists files, newest first
//   drive.save_file     { name, content }            write   saves a plain text file (a proposal, a note)
//
// Sending mail is not part of these tools at all: nothing here calls a send endpoint (an invariant checks the source), so
// "drafts only" holds whatever an agent asks for. A client email still goes out only through email.submit and email.send, which
// review it and, while the setting says so, wait for the founder's card.
//
//   - With any of GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or GOOGLE_REFRESH_TOKEN missing there are no tools.
//   - Requests go only to oauth2.googleapis.com, gmail.googleapis.com and www.googleapis.com, with the short-lived access
//     token in ONE header; a redirect is never followed. The agent never chooses an address.
//   - A draft is checked like any client email first (one address, one-line subject, no key, no [placeholders]).
//   - Mail, file names and text from Google are data. An error is one plain sentence: never a token, Google's own message or the
//     system's error text.

const crypto = require('node:crypto');
const { checkMessage } = require('../outbound/review');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TIMEOUT_MS = 10_000;
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const MAX_QUERY_CHARS = 200;
const MAX_FIELD_CHARS = 300;
const MAX_FILE_CHARS = 100_000;
const MAX_TEXT_CHARS = 19_000; // the loader cuts text at 20,000
const FAILED = 'Google did not accept that request.';
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (args, keys) => Object.keys(args).find((k) => !keys.includes(k));
const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const plainQuery = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= MAX_QUERY_CHARS && !/[\u0000-\u001f\u007f]/.test(v);
const countOk = (v) => v === undefined || (Number.isInteger(v) && v >= 1 && v <= MAX_COUNT);
const base64url = (buffer) => Buffer.from(buffer).toString('base64url');

/** The message as the lines Gmail wants for a draft (headers, then a base64 body so any language travels safely). */
function rfc822({ to, subject, body }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const encodedBody = Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return ['MIME-Version: 1.0', `To: ${to}`, `Subject: ${encodedSubject}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodedBody].join('\r\n');
}

function createGoogleTools({ clientId, clientSecret, refreshToken, fetchImpl = fetch, now = () => Date.now() } = {}) {
  for (const v of [clientId, clientSecret, refreshToken]) if (typeof v !== 'string' || v.trim() === '') return [];

  let token = null; // { value, expiresAt }

  async function send(url, init) {
    let res;
    try {
      res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
    } catch {
      throw new Error(FAILED);
    }
    if (!res || !res.ok) throw new Error(FAILED);
    try {
      return JSON.parse(await res.text());
    } catch {
      throw new Error(FAILED);
    }
  }

  async function accessToken() {
    if (token && token.expiresAt > now() + EXPIRY_MARGIN_MS) return token.value;
    const data = await send(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }).toString(),
    });
    if (!isObject(data) || typeof data.access_token !== 'string' || data.access_token === '') throw new Error(FAILED);
    const seconds = Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : 300;
    token = { value: data.access_token, expiresAt: now() + seconds * 1000 };
    return token.value;
  }

  async function call(url, init = {}) {
    const bearer = await accessToken();
    return send(url, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}), Authorization: `Bearer ${bearer}` } });
  }

  const gmailSearch = {
    name: 'gmail.search',
    access: 'read',
    summary: 'Searches the founder\'s mailbox (the same words as the Gmail search box) and gives back date, sender, subject and a short snippet, one message per line. Read-only.',
    args: `{ "query": what to search for, "count": optional 1 to ${MAX_COUNT} (default ${DEFAULT_COUNT}) }`,
    checkArgs(args) {
      if (!isObject(args)) return 'the arguments must be an object';
      if (onlyKeys(args, ['query', 'count'])) return 'unknown argument';
      if (!plainQuery(args.query)) return `query must be plain words, at most ${MAX_QUERY_CHARS} characters`;
      if (!countOk(args.count)) return `count must be a whole number from 1 to ${MAX_COUNT}`;
      return null;
    },
    async run({ args }) {
      const found = await call(`${GMAIL}/messages?${new URLSearchParams({ q: args.query.trim(), maxResults: String(args.count ?? DEFAULT_COUNT) })}`);
      const ids = (Array.isArray(found?.messages) ? found.messages : []).map((m) => m?.id).filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)).slice(0, args.count ?? DEFAULT_COUNT);
      if (ids.length === 0) return { text: 'No messages found.' };
      const lines = [];
      for (const id of ids) {
        const m = await call(`${GMAIL}/messages/${id}?${new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'From'], ['metadataHeaders', 'Subject'], ['metadataHeaders', 'Date']])}`);
        const header = (name) => oneLine((Array.isArray(m?.payload?.headers) ? m.payload.headers : []).find((h) => String(h?.name).toLowerCase() === name)?.value, MAX_FIELD_CHARS);
        lines.push(`${header('date')} | ${header('from')} | ${header('subject')} | ${oneLine(m?.snippet, MAX_FIELD_CHARS)}`);
      }
      const text = lines.join('\n');
      return { text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text };
    },
  };

  const gmailCreateDraft = {
    name: 'gmail.create_draft',
    access: 'write',
    summary: 'Puts a draft email in the founder\'s Gmail Drafts folder. It is NOT sent, and it is not the way to email a client: use email.submit for that.',
    args: '{ "to": one email address, "subject": one line, "body": the full text, finished (no [placeholders]) }',
    checkArgs(args) {
      if (!isObject(args)) return 'the arguments must be an object';
      if (onlyKeys(args, ['to', 'subject', 'body'])) return 'unknown argument';
      if (typeof args.to !== 'string' || typeof args.subject !== 'string' || typeof args.body !== 'string') return 'to, subject and body must be text';
      const checked = checkMessage({ to: args.to, subject: args.subject, body: args.body });
      return checked.ok ? null : checked.problems.join(' ');
    },
    async run({ args }) {
      const data = await call(`${GMAIL}/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { raw: base64url(rfc822({ to: args.to.trim(), subject: args.subject, body: args.body })) } }),
      });
      if (!isObject(data) || typeof data.id !== 'string') throw new Error(FAILED);
      return { text: 'The draft is in the founder\'s Gmail Drafts folder. It has not been sent.' };
    },
  };

  const driveList = {
    name: 'drive.list_files',
    access: 'read',
    summary: 'Lists files the company has saved in Google Drive, newest first: name, id and when it changed. Read-only.',
    args: `{ "name": optional, part of the file name, "count": optional 1 to ${MAX_COUNT} (default ${DEFAULT_COUNT}) }`,
    checkArgs(args) {
      if (!isObject(args)) return 'the arguments must be an object';
      if (onlyKeys(args, ['name', 'count'])) return 'unknown argument';
      if (args.name !== undefined && !plainQuery(args.name)) return 'name must be plain words';
      if (!countOk(args.count)) return `count must be a whole number from 1 to ${MAX_COUNT}`;
      return null;
    },
    async run({ args }) {
      const escaped = args.name === undefined ? null : args.name.trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const q = `trashed = false${escaped === null ? '' : ` and name contains '${escaped}'`}`;
      const data = await call(`${DRIVE}?${new URLSearchParams({ q, orderBy: 'modifiedTime desc', pageSize: String(args.count ?? DEFAULT_COUNT), fields: 'files(id,name,modifiedTime)' })}`);
      const files = Array.isArray(data?.files) ? data.files : [];
      if (files.length === 0) return { text: 'No files found.' };
      const text = files.slice(0, MAX_COUNT).map((f) => `${oneLine(f?.name, MAX_FIELD_CHARS)} | ${oneLine(f?.id, 80)} | ${oneLine(f?.modifiedTime, 40)}`).join('\n');
      return { text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text };
    },
  };

  const driveSave = {
    name: 'drive.save_file',
    access: 'write',
    summary: 'Saves a plain text file (for example a proposal) in the company\'s Google Drive. It is private: nothing is shared with anyone.',
    args: `{ "name": a plain file name such as "Acme proposal.txt", "content": the text (at most ${MAX_FILE_CHARS} characters) }`,
    checkArgs(args) {
      if (!isObject(args)) return 'the arguments must be an object';
      if (onlyKeys(args, ['name', 'content'])) return 'unknown argument';
      if (typeof args.name !== 'string' || !FILE_NAME.test(args.name) || args.name.includes('..')) return 'name must be a plain file name (letters, numbers, spaces, dots, dashes)';
      if (typeof args.content !== 'string' || args.content.trim() === '' || args.content.length > MAX_FILE_CHARS) return `content must be text of at most ${MAX_FILE_CHARS} characters`;
      return null;
    },
    async run({ args }) {
      const boundary = `b${crypto.randomBytes(16).toString('hex')}`;
      const body = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify({ name: args.name }), `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', args.content, `--${boundary}--`].join('\r\n');
      const data = await call(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
      if (!isObject(data) || typeof data.id !== 'string') throw new Error(FAILED);
      return { text: `Saved "${args.name}" in Google Drive.` };
    },
  };

  return [gmailSearch, gmailCreateDraft, driveList, driveSave].map((t) => Object.freeze(t));
}

module.exports = { createGoogleTools };
