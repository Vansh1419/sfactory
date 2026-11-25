'use strict';

// Read-only git tools for ONE pod's own repository (PLAN.md step 3.2): `git.status`, `git.log` and `git.diff`. Graded by the `pod-isolation` eval.
//
// The pod comes from the RUN (`context.podId`, set from the task by the agent loop), never from the arguments: the tools take no repository, no path and
// no branch, so there is nothing for a model to point at another pod with. Without a pod there is no repository, and they refuse.
//
//   - the repository is the one directly in the pod's folder: `.git` must be a real folder inside it (not a link), and git is told that is the whole
//     world (GIT_DIR, GIT_WORK_TREE and a ceiling at the folder's parent), so a pod folder that lost its `.git` never reads the repository of a folder above it
//   - git runs with no shell, no hooks, none of the machine's own settings, no pager and no lock writes, and can only read: status, log and a diff against
//     the last commit. There is no commit, push, fetch or checkout here: those need the Engineering team's rules (step 3.3)
//   - an error is one plain sentence, never git's own text or a real path

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const GIT_TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 19_000; // the loader cuts text at 20,000, so the notice below always fits
const SHORTENED_NOTICE = '\n[Shortened: there is more than fits.]';
const DEFAULT_LOG = 10;
const MAX_LOG = 50;
const NOT_HERE = 'The project history cannot be read.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function noArgs(args) {
  if (!isObject(args)) return 'the arguments must be an object';
  const extra = Object.keys(args)[0];
  return extra ? `unknown argument: ${extra}` : null;
}

function runGit(folder, args) {
  const { PATH } = process.env;
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', ...args], {
      cwd: folder,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4_000_000,
      env: {
        PATH,
        HOME: folder,
        GIT_DIR: path.join(folder, '.git'),
        GIT_WORK_TREE: folder,
        GIT_CEILING_DIRECTORIES: path.dirname(folder),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_EXTERNAL_DIFF: '',
      },
    }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** The pod's own folder, only if it has a real `.git` folder of its own. */
async function repoFolder(podFolder, context) {
  if (context?.podId === undefined || typeof podFolder !== 'function') throw new Error(NOT_HERE);
  const folder = await podFolder(context.podId);
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error(NOT_HERE);
  const info = fs.lstatSync(path.join(folder, '.git'), { throwIfNoEntry: false });
  if (!info || !info.isDirectory()) throw new Error(NOT_HERE); // missing, a file, or a link to somewhere else
  return folder;
}

const cut = (text) => (text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}${SHORTENED_NOTICE}` : text);

/** The three tools. `podFolder(podId)` gives a pod's absolute folder, or null. Without it there are none. */
function createGitTools({ podFolder } = {}) {
  if (typeof podFolder !== 'function') return [];

  async function show(context, args) {
    try {
      const folder = await repoFolder(podFolder, context);
      const out = (await runGit(folder, args)).trim();
      return { text: out === '' ? 'Nothing to show.' : cut(out) };
    } catch {
      throw new Error(NOT_HERE);
    }
  }

  return [
    Object.freeze({
      name: 'git.status',
      access: 'read',
      podAccess: 'scoped',
      summary: "Shows which files changed since the last saved version of this project's history. Read-only, and only for the project you are working in.",
      args: '{}',
      checkArgs: noArgs,
      run: ({ context }) => show(context, ['status', '--short', '--branch']),
    }),
    Object.freeze({
      name: 'git.log',
      access: 'read',
      podAccess: 'scoped',
      summary: "Lists the latest saved versions in this project's history: short id, who, date and the message. Read-only, and only for the project you are working in.",
      args: `{ "limit": optional 1 to ${MAX_LOG} (default ${DEFAULT_LOG}) }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => k !== 'limit');
        if (extra) return `unknown argument: ${extra}`;
        if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= MAX_LOG)) return `limit must be a whole number from 1 to ${MAX_LOG}`;
        return null;
      },
      run: ({ args, context }) => show(context, ['log', '--no-color', '--date=short', '--format=%h %an %ad %s', '-n', String(args.limit ?? DEFAULT_LOG)]),
    }),
    Object.freeze({
      name: 'git.diff',
      access: 'read',
      podAccess: 'scoped',
      summary: "Shows what changed in this project's files since the last saved version. Read-only, and only for the project you are working in.",
      args: '{}',
      checkArgs: noArgs,
      run: ({ context }) => show(context, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--']),
    }),
  ];
}

module.exports = { createGitTools };
