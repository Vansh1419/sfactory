'use strict';

// The GitHub tools (PLAN.md step 1.10): read a file, list pull requests, open a pull request, merge one. Graded by the
// `github-tools` eval.
//
//   - Only the repositories the founder named (GITHUB_REPOS, "owner/name" each) can be used; with no token or no
//     repositories there are no tools. An argument that is refused never causes a request.
//   - Every request goes to https://api.github.com/repos/<named repository>/ and carries the token in ONE header; a
//     redirect is never followed (so the token cannot be sent anywhere else).
//   - Reading refuses paths that leave the repository and names that hold secrets (the same list the Filesystem tools
//     use), folders, links, binary files and very large files.
//   - Opening a pull request is routine (it ships nothing). MERGING always asks the founder: that is the policy's rule
//     for `github.merge_pull_request`, and the graph only runs the tool after an approval.
//   - Inside a pod (step 3.3) the reading tools and the one that opens a pull request work ONLY on the repository tied to that pod (`podRepo`), and any
//     other repository the model names is refused; a pull request cannot be opened from the main line. Merging is not available to a pod at all.
//   - An error is one plain sentence: never the token, GitHub's own message or the system's error text.

const { isDeniedName } = require('./filesystem');

const API = 'https://api.github.com/repos';
const TIMEOUT_MS = 10_000;
const MAX_FILE_BYTES = 200_000;
const MAX_TEXT_CHARS = 19_000; // the loader cuts text at 20,000, so the notice below always fits
const SHORTENED_NOTICE = '\n[Shortened: the file is larger than this.]';
const MAX_PATH_CHARS = 300;
const MAX_TITLE_CHARS = 256;
const MAX_BODY_CHARS = 10_000;
const MAX_PR_NUMBER = 1_000_000_000;
const PR_STATES = ['open', 'closed', 'all'];
const FAILED = 'GitHub did not accept that request.';
const PROTECTED_HEAD = /^(main|master|develop|production|prod|staging|release.*)$/i;

const REPO_SHAPE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_SHAPE = /^[A-Za-z0-9._/-]{1,100}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const onlyKeys = (args, keys) => Object.keys(args).find((k) => !keys.includes(k));

function isBranchName(v) {
  return typeof v === 'string' && BRANCH_SHAPE.test(v) && !v.includes('..') && !v.startsWith('/') && !v.endsWith('/');
}

/** A path inside a repository, as the parts to put in the address, or null. */
function safePathParts(p) {
  if (typeof p !== 'string' || p === '' || p.trim() !== p || p.length > MAX_PATH_CHARS) return null;
  if (/[\u0000-\u001f\u007f\\?#%]/.test(p) || p.startsWith('/')) return null;
  const parts = p.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || isDeniedName(part))) return null;
  return parts;
}

function createGitHubTools({ token, repos, fetchImpl = fetch, podRepo } = {}) {
  if (typeof token !== 'string' || token.trim() === '' || !Array.isArray(repos)) return [];
  const allowed = new Map();
  for (const r of repos) {
    if (typeof r === 'string' && REPO_SHAPE.test(r) && !r.split('/').some((part) => /^\.+$/.test(part))) allowed.set(r.toLowerCase(), r);
  }
  if (allowed.size === 0) return [];

  const repoOf = (value) => (typeof value === 'string' && REPO_SHAPE.test(value) ? allowed.get(value.toLowerCase()) ?? null : null);

  /** The repository a run works on. In a pod run it is the pod's own, and a different one is refused. Outside a pod it is the one named. */
  async function repoFor(args, context) {
    const named = repoOf(args.repo);
    if (context?.podId === undefined) return named;
    const own = typeof podRepo === 'function' ? repoOf(await podRepo(context.podId)) : null;
    if (!own || named !== own) throw new Error(FAILED);
    return own;
  }

  async function call(repo, method, apiPath, body) {
    let res;
    try {
      res = await fetchImpl(`${API}/${repo}${apiPath}`, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'sfactory',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(FAILED);
    }
    if (!res.ok) throw new Error(FAILED); // includes every redirect, which is never followed
    try {
      return JSON.parse(await res.text());
    } catch {
      throw new Error(FAILED);
    }
  }

  const repoProblem = (args) => (repoOf(args.repo) ? null : 'repo must be one of the repositories you named, written owner/name');
  const objectProblem = (args) => (isObject(args) ? null : 'the arguments must be an object');

  const readFile = {
    name: 'github.read_file',
    access: 'read',
    podAccess: 'scoped',
    summary: 'Reads one text file from one of the named GitHub repositories and gives back its text. Secrets and binary files are refused.',
    args: '{ "repo": "owner/name", "path": the file\'s path in the repository, "ref": optional branch or tag }',
    checkArgs(args) {
      return objectProblem(args)
        ?? (onlyKeys(args, ['repo', 'path', 'ref']) ? 'unknown argument' : null)
        ?? repoProblem(args)
        ?? (safePathParts(args.path) ? null : 'path must be a plain file path inside the repository')
        ?? (args.ref === undefined || isBranchName(args.ref) ? null : 'ref must be a branch or tag name');
    },
    async run({ args, context }) {
      const repo = await repoFor(args, context);
      const encoded = safePathParts(args.path).map(encodeURIComponent).join('/');
      const data = await call(repo, 'GET', `/contents/${encoded}${args.ref === undefined ? '' : `?ref=${encodeURIComponent(args.ref)}`}`);
      if (!isObject(data) || data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error(FAILED);
      if (!Number.isInteger(data.size) || data.size > MAX_FILE_BYTES) throw new Error(FAILED);
      const bytes = Buffer.from(data.content.replace(/\s/g, ''), 'base64');
      if (bytes.includes(0)) throw new Error(FAILED); // binary
      const text = bytes.toString('utf8');
      return { text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}${SHORTENED_NOTICE}` : text };
    },
  };

  const listPullRequests = {
    name: 'github.list_pull_requests',
    access: 'read',
    podAccess: 'scoped',
    summary: 'Lists the 20 most recent pull requests of one of the named GitHub repositories, one per line.',
    args: '{ "repo": "owner/name", "state": optional "open", "closed" or "all" (default "open") }',
    checkArgs(args) {
      return objectProblem(args)
        ?? (onlyKeys(args, ['repo', 'state']) ? 'unknown argument' : null)
        ?? repoProblem(args)
        ?? (args.state === undefined || PR_STATES.includes(args.state) ? null : 'state must be open, closed or all');
    },
    async run({ args, context }) {
      const data = await call(await repoFor(args, context), 'GET', `/pulls?state=${args.state ?? 'open'}&per_page=20`);
      if (!Array.isArray(data)) throw new Error(FAILED);
      const lines = data.filter(isObject).slice(0, 20).map((pr) => `#${Number(pr.number) || 0} ${oneLine(pr.title, 200)} (${pr.merged_at ? 'merged' : oneLine(pr.state, 20)}, by ${oneLine(pr.user?.login, 60)})`);
      return { text: lines.length > 0 ? lines.join('\n') : 'No pull requests.' };
    },
  };

  const createPullRequest = {
    name: 'github.create_pull_request',
    access: 'write',
    podAccess: 'scoped',
    summary: 'Opens a pull request in one of the named GitHub repositories. It ships nothing: a person still has to merge it.',
    args: '{ "repo": "owner/name", "title": the title, "head": the branch with the changes, "base": the branch to merge into, "body": optional description }',
    checkArgs(args) {
      return objectProblem(args)
        ?? (onlyKeys(args, ['repo', 'title', 'head', 'base', 'body']) ? 'unknown argument' : null)
        ?? repoProblem(args)
        ?? (typeof args.title === 'string' && args.title.trim() !== '' && args.title.length <= MAX_TITLE_CHARS ? null : `title must be text of 1 to ${MAX_TITLE_CHARS} characters`)
        ?? (isBranchName(args.head) ? null : 'head must be a branch name')
        ?? (isBranchName(args.base) ? null : 'base must be a branch name')
        ?? (args.body === undefined || (typeof args.body === 'string' && args.body.length <= MAX_BODY_CHARS) ? null : `body must be text of up to ${MAX_BODY_CHARS} characters`);
    },
    async run({ args, context }) {
      const repo = await repoFor(args, context);
      if (context?.podId !== undefined && PROTECTED_HEAD.test(args.head)) throw new Error(FAILED); // a pod never opens a pull request from the main line
      const payload = { title: args.title, head: args.head, base: args.base, ...(args.body === undefined ? {} : { body: args.body }) };
      const data = await call(repo, 'POST', '/pulls', payload);
      if (!isObject(data) || !Number.isInteger(data.number)) throw new Error(FAILED);
      const url = typeof data.html_url === 'string' && data.html_url.startsWith('https://github.com/') ? `: ${data.html_url}` : '';
      return { text: `Opened pull request #${data.number}${url}` };
    },
  };

  const mergePullRequest = {
    name: 'github.merge_pull_request',
    access: 'write',
    summary: 'Merges one pull request in one of the named GitHub repositories. This can change what goes live, so it always asks the founder first.',
    args: '{ "repo": "owner/name", "number": the pull request number }',
    checkArgs(args) {
      return objectProblem(args)
        ?? (onlyKeys(args, ['repo', 'number']) ? 'unknown argument' : null)
        ?? repoProblem(args)
        ?? (Number.isInteger(args.number) && args.number >= 1 && args.number <= MAX_PR_NUMBER ? null : 'number must be a whole pull request number');
    },
    async run({ args }) {
      const data = await call(repoOf(args.repo), 'PUT', `/pulls/${args.number}/merge`);
      if (!isObject(data) || data.merged !== true) throw new Error(FAILED);
      return { text: `Merged pull request #${args.number}.` };
    },
  };

  return [readFile, listPullRequests, createPullRequest, mergePullRequest].map((t) => Object.freeze(t));
}

module.exports = { createGitHubTools };
