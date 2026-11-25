'use strict';

// Git tools for ONE pod's own repository. Step 3.2: `git.status`, `git.log` and `git.diff` (read only). Step 3.3: `git.create_branch`, `git.commit` and
// `git.push_branch` (the work a pull request is made from). Graded by the `pod-isolation` and `engineering-tools` evals.
//
// The pod comes from the RUN (`context.podId`, set from the task by the agent loop), never from the arguments: the tools take no repository, no path and
// no branch, so there is nothing for a model to point at another pod with. Without a pod there is no repository, and they refuse.
//
//   - the repository is the one directly in the pod's folder: `.git` must be a real folder inside it (not a link), and git is told that is the whole
//     world (GIT_DIR, GIT_WORK_TREE and a ceiling at the folder's parent), so a pod folder that lost its `.git` never reads the repository of a folder above it
//   - git runs with no shell, no hooks, none of the machine's own settings, no pager and no lock writes. The read tools cannot change anything.
//   - the writing tools work only on a BRANCH of a safe shape (feature/..., fix/..., chore/..., docs/..., test/...): no tool can create, commit to or push
//     main, master or any other branch, so nothing reaches the live version by this route. Nothing is ever forced, fetched, checked out or merged.
//   - a commit is refused when a file that holds secrets is staged or the staged text looks like it holds a key or password (and nothing is kept staged)
//   - a push goes to the repository tied to the pod (`podRepo`), never to one the model names, with the token passed in the environment (never on a
//     command line and never saved in the repository's own settings)
//   - an error is one plain sentence, never git's own text or a real path

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { isDeniedName } = require('./filesystem');
const { redactDetail } = require('../audit');

const GIT_TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 19_000; // the loader cuts text at 20,000, so the notice below always fits
const SHORTENED_NOTICE = '\n[Shortened: there is more than fits.]';
const DEFAULT_LOG = 10;
const MAX_LOG = 50;
const NOT_HERE = 'The project history cannot be read.';
const NOT_DONE = 'That could not be done in the project history.';
const SECRET_FOUND = 'A file holds something that looks like a key or a password, so nothing was saved.';
const NO_REPO = 'This project has no GitHub repository, so there is nowhere to send the work.';
const NO_TOKEN = 'GitHub is not connected, so the work cannot be sent.';
const BRANCH_NAME = /^(feature|fix|chore|docs|test)\/[a-z0-9][a-z0-9._-]{0,60}$/;
const MAX_MESSAGE_CHARS = 500;
const ON_MAIN = 'You are not on a branch of your own, and work is only saved on a branch. Start one with git.create_branch first.';
// What the agent is told when a writing step is refused for a reason it can act on. It comes back as an ordinary result ("Not done: ..."), because the
// tool loader never shows an error's own text. Every other failure is the one plain sentence NOT_DONE, and a missing or odd pod is a plain refusal.
const REASONS = new Set([SECRET_FOUND, NO_REPO, NO_TOKEN, ON_MAIN]);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function noArgs(args) {
  if (!isObject(args)) return 'the arguments must be an object';
  const extra = Object.keys(args)[0];
  return extra ? `unknown argument: ${extra}` : null;
}

function runGit(folder, args, extraEnv = {}) {
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
        ...extraEnv,
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
function createGitTools({ podFolder, podRepo, githubToken, remoteUrl = (repo) => `https://github.com/${repo}.git` } = {}) {
  if (typeof podFolder !== 'function') return [];

  /** Who a commit is by: the agent's own name (letters, digits and a few marks), never anything else from the run. */
  const identity = (context) => {
    const name = String(context?.agent ?? '').replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 40) || 'sfactory agent';
    return ['-c', `user.name=${name}`, '-c', 'user.email=agent@sfactory.local'];
  };

  /** Run a writing step: a refusal the agent can act on comes back as a result, anything else becomes the one plain failure. */
  async function change(work) {
    try {
      return await work();
    } catch (err) {
      if (REASONS.has(err?.message)) return { text: `Not done: ${err.message}` };
      throw new Error(NOT_DONE);
    }
  }
  const branchOf = async (folder) => (await runGit(folder, ['branch', '--show-current'])).trim();

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
    Object.freeze({
      name: 'git.create_branch',
      access: 'write',
      podAccess: 'scoped',
      summary: 'Starts a new line of work in this project (a branch) and switches to it. The name must look like feature/short-name (or fix/, chore/, docs/, test/). Work is never saved on the main line.',
      args: '{ "name": for example "feature/contact-form" }',
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => k !== 'name');
        if (extra) return `unknown argument: ${extra}`;
        return typeof args.name === 'string' && BRANCH_NAME.test(args.name) && !args.name.includes('..') && !args.name.endsWith('.') && !args.name.endsWith('.lock') ? null : 'name must look like feature/short-name (or fix/, chore/, docs/, test/), in lower case';
      },
      run: ({ args, context }) => change(async () => {
        const folder = await repoFolder(podFolder, context);
        await runGit(folder, ['switch', '-c', args.name]); // fails if the branch exists
        return { text: `Now working on ${args.name}.` };
      }),
    }),
    Object.freeze({
      name: 'git.commit',
      access: 'write',
      podAccess: 'scoped',
      summary: 'Saves every change in this project as one new version on the branch you are working on, with your message. It refuses on the main line, and refuses if a file holds a key or password.',
      args: `{ "message": what changed, in a sentence, up to ${MAX_MESSAGE_CHARS} characters }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => k !== 'message');
        if (extra) return `unknown argument: ${extra}`;
        return typeof args.message === 'string' && args.message.trim() !== '' && args.message.length <= MAX_MESSAGE_CHARS && !args.message.includes('\u0000') ? null : `message must be text of 1 to ${MAX_MESSAGE_CHARS} characters`;
      },
      run: ({ args, context }) => change(async () => {
        const folder = await repoFolder(podFolder, context);
        if (!BRANCH_NAME.test(await branchOf(folder))) throw new Error(ON_MAIN); // never on the main line, or on a branch of an odd shape
        await runGit(folder, ['add', '-A']);
        const names = (await runGit(folder, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
        const text = names.length > 0 ? await runGit(folder, ['diff', '--cached', '--no-color', '--no-ext-diff']) : '';
        if (names.some((n) => n.split('/').some(isDeniedName)) || redactDetail(text) !== text) {
          await runGit(folder, ['reset', '-q']); // nothing stays staged
          throw new Error(SECRET_FOUND);
        }
        if (names.length === 0) return { text: 'Nothing to save: no files changed.' };
        await runGit(folder, [...identity(context), 'commit', '-q', '--no-verify', '--no-gpg-sign', '-m', args.message.trim()]);
        const sha = (await runGit(folder, ['rev-parse', '--short', 'HEAD'])).trim();
        return { text: `Saved ${names.length} file${names.length === 1 ? '' : 's'} on ${await branchOf(folder)} as ${sha}.` };
      }),
    }),
    Object.freeze({
      name: 'git.push_branch',
      access: 'write',
      podAccess: 'scoped',
      summary: "Sends the branch you are working on to this project's GitHub repository, so a pull request can be opened from it. It never sends the main line and never forces anything.",
      args: '{}',
      checkArgs: noArgs,
      run: ({ context }) => change(async () => {
        const folder = await repoFolder(podFolder, context);
        const branch = await branchOf(folder);
        if (!BRANCH_NAME.test(branch)) throw new Error(ON_MAIN);
        const repo = typeof podRepo === 'function' ? await podRepo(context.podId) : null;
        if (typeof repo !== 'string' || repo === '') throw new Error(NO_REPO);
        const url = remoteUrl(repo);
        const web = /^https:\/\//.test(url);
        if (web && !githubToken) throw new Error(NO_TOKEN);
        const header = web ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}` } : {};
        const only = web ? ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'] : [];
        await runGit(folder, [...only, 'push', '--no-verify', url, `refs/heads/${branch}:refs/heads/${branch}`], header);
        return { text: `Sent ${branch} to ${repo}.` };
      }),
    }),
  ];
}

module.exports = { createGitTools, runGit };
