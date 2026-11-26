'use strict';

// Vercel deploys (PLAN.md step 4.5). Graded by the `deploy-tools` eval.
//
//   createVercelApi({ token, teamId?, fetchImpl? })
//     .configured                                          true when there is a token
//     .createDeployment({ repo, ref, production? })        -> { ok: true, url, target } | { ok: false, reason: 'not_connected' | 'rejected' | 'not_found' | 'failed' }
//   createVercelTools({ api, podRepo })                    -> [ `vercel.deploy` ] (none without a token)
//
// The tool starts a PREVIEW of one branch of the project's own repository, and nothing else. It cannot start a production deploy, even if it is called
// directly: that is the founder's decision, asked on a card (the policy stops an agent that reaches for it), and AFTER the founder approves, trusted code
// (deployer.js, never an agent) starts it through `createDeployment({ production: true })`.
//
// The repository comes from the PROJECT the run belongs to (`podRepo`), never from an argument, so a model cannot point a deploy at another project. A
// preview is one request to Vercel's API, `POST /v13/deployments`, with a git source and no `target` (Vercel's default is a preview); if Vercel nonetheless
// answers that it made a production deployment, the agent is told plainly to tell the founder at once. Vercel's own words and the token never reach the agent:
// every failure is one plain sentence.

const API = 'https://api.vercel.com/v13/deployments';
const TIMEOUT_MS = 15_000;
const REPO = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const BRANCH = /^(feature|fix|chore|docs|test)\/[a-z0-9][a-z0-9._-]{0,60}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createVercelApi({ token, teamId, fetchImpl = fetch } = {}) {
  const configured = typeof token === 'string' && token.trim() !== '';

  async function createDeployment({ repo, ref, production = false } = {}) {
    if (!configured) return { ok: false, reason: 'not_connected' };
    const match = typeof repo === 'string' ? REPO.exec(repo) : null;
    if (!match || typeof ref !== 'string' || ref === '') return { ok: false, reason: 'not_found' };
    const [, org, name] = match;
    const url = `${API}${typeof teamId === 'string' && teamId.trim() !== '' ? `?teamId=${encodeURIComponent(teamId.trim())}` : ''}`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.toLowerCase(), gitSource: { type: 'github', org, repo: name, ref }, ...(production ? { target: 'production' } : {}) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: 'failed' };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'rejected' };
    if (res.status === 400 || res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'failed' };
    let data;
    try {
      data = JSON.parse(await res.text());
    } catch {
      return { ok: false, reason: 'failed' };
    }
    if (!isObject(data) || typeof data.url !== 'string' || data.url === '' || /[\s/]/.test(data.url)) return { ok: false, reason: 'failed' };
    return { ok: true, url: data.url, target: typeof data.target === 'string' ? data.target : null };
  }

  return { configured, createDeployment };
}

const NOT_DONE = Object.freeze({
  not_connected: 'Not done: Vercel is not connected, so nothing was deployed.',
  rejected: 'Not done: Vercel did not accept the access token, so nothing was deployed. Tell the founder.',
  not_found: 'Not done: Vercel could not find that project or branch. The project must exist in Vercel and the branch must have been sent to GitHub first.',
  failed: 'Not done: The deploy could not be started.',
});

function createVercelTools({ api, podRepo } = {}) {
  if (!api?.configured || typeof podRepo !== 'function') return [];

  return [
    Object.freeze({
      name: 'vercel.deploy',
      access: 'write',
      podAccess: 'scoped',
      summary: "Starts a PREVIEW of one branch of this project's own repository on Vercel and gives back its address. Nothing goes live. It cannot deploy to production: that is the founder's decision, asked on a card.",
      args: '{ "target": "preview", "branch": the branch you sent to GitHub, for example "feature/contact-page" }',
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => !['target', 'branch'].includes(k));
        if (extra) return `unknown argument: ${extra}`;
        if (args.target !== 'preview') return 'target must be exactly "preview"';
        if (typeof args.branch !== 'string' || !BRANCH.test(args.branch) || args.branch.includes('..') || args.branch.endsWith('.') || args.branch.endsWith('.lock')) return 'branch must look like feature/short-name (or fix/, chore/, docs/, test/), in lower case';
        return null;
      },
      async run({ args, context }) {
        if (args?.target !== 'preview') return { text: 'Not done: a production deploy is the founder\'s decision. It is asked on a card, and the system starts it after the founder approves.' };
        if (context?.podId === undefined) throw new Error('That deploy cannot be started.');
        const repo = await podRepo(context.podId);
        if (typeof repo !== 'string' || repo === '') return { text: 'Not done: This project has no GitHub repository, so there is nothing to deploy.' };
        const made = await api.createDeployment({ repo, ref: args.branch });
        if (!made.ok) return { text: NOT_DONE[made.reason] ?? NOT_DONE.failed };
        if (made.target === 'production') return { text: `Warning: Vercel treated this as a PRODUCTION deploy (https://${made.url}). Tell the founder at once, and do not deploy again.` };
        return { text: `Preview deploy started: https://${made.url} (it may take a minute to be ready). Nothing is live.` };
      },
    }),
  ];
}

module.exports = { createVercelApi, createVercelTools };
