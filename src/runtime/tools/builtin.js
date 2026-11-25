'use strict';

// The tools that ship with the app. Each has a policy rule in src/runtime/policy.js; the loader refuses any
// tool that does not. Graded by the `tool-loader` eval.
//
// docs.create_draft writes a draft (a note, an email, a script) and RETURNS ITS TEXT AND A FILE, so a task can hand
// a result back to the founder (the window offers the file for download). It is a routine write in the policy: it changes nothing outside the app, so it
// needs no approval.

const { sanitizeFileName } = require('./files');

const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_CHARS = 10_000;
const ALLOWED_KEYS = ['title', 'content'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const docsCreateDraft = Object.freeze({
  name: 'docs.create_draft',
  access: 'write',
  podAccess: 'neutral', // writes only the text it is given: it reads nothing
  summary: 'Writes a draft document, note, message or script and gives its text back to the founder.',
  args: `{ "title": a short title or file name (up to ${MAX_TITLE_CHARS} characters), "content": the full text of the draft (up to ${MAX_CONTENT_CHARS} characters) }`,

  checkArgs(args) {
    if (!isObject(args)) return 'the arguments must be an object';
    const extra = Object.keys(args).find((k) => !ALLOWED_KEYS.includes(k));
    if (extra) return `unknown argument: ${extra}`;
    if (typeof args.title !== 'string' || args.title.trim() === '' || args.title.length > MAX_TITLE_CHARS) return `title must be text of 1 to ${MAX_TITLE_CHARS} characters`;
    if (typeof args.content !== 'string' || args.content.trim() === '' || args.content.length > MAX_CONTENT_CHARS) return `content must be text of 1 to ${MAX_CONTENT_CHARS} characters`;
    return null;
  },

  async run({ args }) {
    // The content is returned exactly as written: indentation and line breaks matter in a script.
    // It is also a file the founder can download: named by the title (".txt" added when the title has no extension).
    const safe = sanitizeFileName(args.title);
    const name = safe !== null && !/\.[A-Za-z0-9]{1,8}$/.test(safe) ? `${safe}.txt` : safe;
    const text = `${args.title}\n\n${args.content}`;
    return name === null ? { text } : { text, file: { name, content: args.content } };
  },
});

const BUILTIN_TOOLS = Object.freeze([docsCreateDraft]);

module.exports = { BUILTIN_TOOLS };
