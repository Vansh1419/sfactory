'use strict';

// Error reports from a live product (PLAN.md step 4.5, "Sentry for live products"). Graded by the `deploy-tools` eval.
//
//   createSentryTools({ token, org, fetchImpl?, podRepo }) -> [ `sentry.list_issues` ]   (none without a token and an organisation)
//
// Read only. It lists the recent unresolved problems Sentry has seen for the project the run belongs to. The Sentry project is the project's repository name
// (the same name the Vercel project has), taken from the PROJECT (`podRepo`), never from an argument, so a model cannot read another project's errors.
// Each problem is one plain line (how bad, what, how many times, when, where). Sentry's own words and the token never reach the agent: a failure is one
// plain sentence. A page of problems is short, so it is shown whole (50 at most).

const TIMEOUT_MS = 12_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;
const ORG = /^[A-Za-z0-9_-]{1,100}$/;
const SLUG = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_LINE_CHARS = 300;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const plain = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function createSentryTools({ token, org, fetchImpl = fetch, podRepo } = {}) {
  if (typeof token !== 'string' || token.trim() === '' || typeof org !== 'string' || !ORG.test(org) || typeof podRepo !== 'function') return [];

  return [
    Object.freeze({
      name: 'sentry.list_issues',
      access: 'read',
      podAccess: 'scoped',
      summary: "Lists the recent unresolved problems Sentry has seen for this project's live product: how bad, what, how many times, when, and where. Read-only, and only for this project.",
      args: `{ "hours": optional, how far back, 1 to ${MAX_HOURS} (default ${DEFAULT_HOURS}), "limit": optional, 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT}) }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => !['hours', 'limit'].includes(k));
        if (extra) return `unknown argument: ${extra}`;
        if (args.hours !== undefined && !(Number.isInteger(args.hours) && args.hours >= 1 && args.hours <= MAX_HOURS)) return `hours must be a whole number from 1 to ${MAX_HOURS}`;
        if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= MAX_LIMIT)) return `limit must be a whole number from 1 to ${MAX_LIMIT}`;
        return null;
      },
      async run({ args, context }) {
        if (context?.podId === undefined) throw new Error('The error list could not be read.');
        const repo = await podRepo(context.podId);
        const slug = typeof repo === 'string' ? repo.split('/')[1] : undefined;
        if (!slug || !SLUG.test(slug)) return { text: 'Not done: This project has no GitHub repository, so there is no live product to look up.' };
        const hours = args.hours ?? DEFAULT_HOURS;
        const limit = args.limit ?? DEFAULT_LIMIT;
        const query = new URLSearchParams({ statsPeriod: `${hours}h`, query: 'is:unresolved', limit: String(limit) });
        let res;
        try {
          res = await fetchImpl(`https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(slug.toLowerCase())}/issues/?${query}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!res.ok) throw new Error('not ok');
        } catch {
          throw new Error('The error list could not be read.');
        }
        let issues;
        try {
          issues = JSON.parse(await res.text());
        } catch {
          throw new Error('The error list could not be read.');
        }
        if (!Array.isArray(issues)) throw new Error('The error list could not be read.');
        if (issues.length === 0) return { text: `No recent errors were reported for this project in the last ${hours} hours.` };
        const lines = issues.filter(isObject).slice(0, limit).map((i, n) => plain(`${n + 1}. [${plain(i.level, 12) || 'error'}] ${plain(i.title, 140)} (${plain(i.count, 10) || '?'} times, last ${plain(i.lastSeen, 30) || 'unknown'})${i.culprit ? ` in ${plain(i.culprit, 80)}` : ''}`, MAX_LINE_CHARS));
        return { text: `Recent problems in the last ${hours} hours (newest first):\n${lines.join('\n')}` };
      },
    }),
  ];
}

module.exports = { createSentryTools };
