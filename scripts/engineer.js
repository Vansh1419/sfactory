'use strict';

// Give the Engineering team one task inside one project (PLAN.md step 3.3), with your real accounts from .env:
//
//   npm run engineer -- --pod <pod id> --title "Add a contact form" [--description "…"]
//
// Find the pod id with `npm run pod -- list`. The team works only inside that project: Dev makes the change on a branch, saves it, sends it to the
// project's GitHub repository (when it has one) and opens a pull request; Tess reviews it. Nothing goes live and nothing is merged: if the team reaches
// for a merge or a production deploy, it is stopped and a card waits for you (in the window and on Telegram).
//
// It starts the same runtime as the app, so it needs the same settings (Supabase, a model provider, PODS_ROOT and, to open pull requests, GITHUB_TOKEN
// and GITHUB_REPOS) and prints only plain words: never a key, never the text of an error from a service.

const path = require('node:path');
const { createApp } = require('../src/runtime');

const ROOT = path.join(__dirname, '..');
const OPTIONS = { pod: 'podId', title: 'title', description: 'description' };
const SAYS = {
  done: 'The team finished its work.',
  blocked: 'The team could not finish this task.',
  needs_founder: 'An agent reached something only you can decide. A card is waiting for your answer.',
  failed: 'The task could not be worked.',
};
const REASONS = {
  bad_task: 'The task details are not valid.',
  bad_pod: 'There is no open project with that id.',
  team_unavailable: 'The Engineering team could not be started.',
  card_failed: 'A card for you could not be made.',
};

function readArgs(argv) {
  const task = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = OPTIONS[argv[i]?.replace(/^--/, '')];
    if (!key || argv[i + 1] === undefined) return null;
    task[key] = argv[i + 1];
  }
  return task;
}

async function main() {
  const task = readArgs(process.argv.slice(2));
  if (!task || task.podId === undefined || task.title === undefined) {
    console.error('Usage: npm run engineer -- --pod <pod id> --title "Add a contact form" [--description "…"]\n       (find the pod id with: npm run pod -- list)');
    return 2;
  }
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // No .env: the runtime says exactly what is missing.
  }
  if (!process.env.PODS_ROOT) {
    console.error('PODS_ROOT is not set in .env. Set it to the same absolute folder the app uses for project spaces.');
    return 1;
  }

  const app = createApp({ env: process.env, version: 'engineer', filesystemRoot: ROOT, toolConfigDir: path.join(ROOT, 'config', 'mcp'), skillsDir: path.join(ROOT, '.claude', 'skills'), podTemplatesDir: path.join(ROOT, 'config', 'pods') });
  if (app.problems.length > 0) {
    console.error(`The runtime is not set up: ${app.problems.join('; ')}.`);
    return 1;
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOS) console.warn('Note: GITHUB_TOKEN or GITHUB_REPOS is not set, so the team has no GitHub tools and cannot open a pull request.');
  const started = await app.start();
  if (!started.ok) {
    console.error('The runtime could not start. Check the database settings and that the migrations are applied (npm run check:db).');
    await app.stop();
    return 1;
  }

  let code = 0;
  try {
    const result = await app.engineering.workTask(task);
    console.log(SAYS[result.status] ?? 'The task was worked.');
    if (result.reason) console.log(`Reason: ${REASONS[result.reason] ?? result.reason}`);
    if (Array.isArray(result.problems) && result.problems.length > 0) console.log(result.problems.join('\n'));
    for (const out of result.outputs ?? []) console.log(`\n${out.worker}: ${out.output}`);
    if (result.status !== 'done' && result.status !== 'needs_founder') code = 1;
  } catch {
    console.error('The task could not be worked.');
    code = 1;
  }
  await app.stop();
  return code;
}

main().then((code) => process.exit(code));
