'use strict';

// The one tool that writes a project's files (PLAN.md step 3.3): `pod.write_file`. Graded by the `engineering-tools` and `pod-isolation` evals.
//
// It writes ONLY inside the folder of the pod the run belongs to (`context.podId`, set from the task, never from the arguments). A run with no pod
// cannot use it: there is no company-wide write. The same name rules as the read tools apply: nothing that holds secrets, no `.git`, no `node_modules`.
//
//   - the path is checked as written (no "..", no absolute path, no "~"), and again after the system has followed every link: the folder the file would
//     land in must really be inside the pod folder, and an existing link is never written through
//   - a file the founder has open in the project view (step 3.6, `isLocked`) is refused with a plain "Not done" result until it is saved or closed
//   - folders that do not exist yet are made inside the pod folder; the text is plain (no NUL bytes) and up to 100,000 characters
//   - an error is one plain sentence, never a real path or the system's own error text

const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeniedName } = require('./filesystem');

const MAX_PATH_CHARS = 300;
const MAX_CONTENT_CHARS = 100_000;
const CANNOT_WRITE = 'That file cannot be written.';
const LOCKED = 'Not done: the founder is editing that file right now. Leave it alone, or do your work in another file; it can be changed again once the founder has saved it.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** The deepest folder of `target`'s parents that already exists, as a real path. */
async function deepestExisting(target) {
  let here = path.dirname(target);
  for (;;) {
    try {
      return await fs.realpath(here);
    } catch {
      const up = path.dirname(here);
      if (up === here) throw new Error(CANNOT_WRITE);
      here = up;
    }
  }
}

/**
 * Where `wanted` (a path written relative to the project folder) lands, or an error. `root` must already be a real path. The path is checked as written and
 * again after every link on the way has been followed. `existing` is what is there now (null when nothing is). Nothing is made or changed.
 */
async function checkTarget(root, wanted) {
  const written = String(wanted).replace(/\\/g, '/');
  if (written === '' || path.isAbsolute(written) || written.startsWith('~') || written.endsWith('/')) throw new Error(CANNOT_WRITE);
  const target = path.resolve(root, written);
  if (!inside(root, target)) throw new Error(CANNOT_WRITE);
  const rel = path.relative(root, target).split(path.sep);
  if (rel.some((part) => part === '' || isDeniedName(part))) throw new Error(CANNOT_WRITE);
  const nearest = await deepestExisting(target);
  if (nearest !== root && !inside(root, nearest)) throw new Error(CANNOT_WRITE);
  const existing = await fs.lstat(target).catch(() => null);
  if (existing && !existing.isFile()) throw new Error(CANNOT_WRITE); // a link, a folder or anything else is never written through
  return { target, rel: rel.join('/'), existing };
}

/** Make the folders a file needs, and check that the folder it lands in is really inside the project. */
async function prepareFolder(root, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const landed = await fs.realpath(path.dirname(target));
  if (landed !== root && !inside(root, landed)) throw new Error(CANNOT_WRITE);
}

function createPodFileTools({ podFolder, isLocked = () => false } = {}) {
  if (typeof podFolder !== 'function') return [];

  return [
    Object.freeze({
      name: 'pod.write_file',
      access: 'write',
      podAccess: 'scoped',
      summary: 'Writes one text file inside the project folder (a new file, or replaces an existing one). It cannot write outside the project, secrets or the history folder.',
      args: `{ "path": the file's path relative to the project folder, for example "src/app.js", "content": the whole text of the file, up to ${MAX_CONTENT_CHARS} characters }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => !['path', 'content'].includes(k));
        if (extra) return `unknown argument: ${extra}`;
        if (typeof args.path !== 'string' || args.path.trim() === '' || args.path.length > MAX_PATH_CHARS || args.path.includes('\u0000')) return `path must be text of 1 to ${MAX_PATH_CHARS} characters, relative to the project folder`;
        if (typeof args.content !== 'string' || args.content.length > MAX_CONTENT_CHARS || args.content.includes('\u0000')) return `content must be plain text of up to ${MAX_CONTENT_CHARS} characters`;
        return null;
      },
      async run({ args, context }) {
        try {
          if (context?.podId === undefined) throw new Error(CANNOT_WRITE);
          const given = await podFolder(context.podId);
          if (typeof given !== 'string' || !path.isAbsolute(given)) throw new Error(CANNOT_WRITE);
          const root = await fs.realpath(given);

          const { target, rel } = await checkTarget(root, args.path);
          // A file the founder has open is the founder's until it is saved or closed: it comes back as a result the agent can act on.
          if (isLocked({ podId: context.podId, path: rel })) return { text: LOCKED };
          await prepareFolder(root, target);

          await fs.writeFile(target, args.content, { encoding: 'utf8', mode: 0o644 });
          return { text: `Saved ${rel} (${Buffer.byteLength(args.content)} bytes).` };
        } catch {
          throw new Error(CANNOT_WRITE);
        }
      },
    }),
  ];
}

module.exports = { createPodFileTools, checkTarget, prepareFolder, deepestExisting, inside, CANNOT_WRITE };
