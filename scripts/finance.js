'use strict';

// Give the Finance, Legal and Ops team one task (PLAN.md step 3.4), with your real accounts from .env:
//
//   npm run finance -- --title "Invoice Acme Studio" --description "One item, website design, ₹1,00,000. Acme is in Karnataka (29), we are in Maharashtra (27). GST 18%." [--pod <pod id>]
//
// The team drafts an invoice (the GST is worked out by the invoice tool, in code), writes up an expense, reads a contract or checks what personal data a
// plan collects, and reports in plain words. Add --pod to make it one project's work (find the id with `npm run pod -- list`); the team then sees only that
// project. Nothing is paid, signed, sent or issued: the team holds no payment account, and if it reaches for a payout, a signature or a legal document it is
// stopped and a card waits for you (in the window and on Telegram).
//
// It starts the same runtime as the app, so it needs the same settings (Supabase and a model provider; PODS_ROOT with --pod) and prints only plain words:
// never a key, never the text of an error from a service.

const path = require('node:path');
const { createApp } = require('../src/runtime');

const ROOT = path.join(__dirname, '..');
const OPTIONS = { title: 'title', description: 'description', pod: 'podId' };
const SAYS = {
  done: 'The team finished its work.',
  blocked: 'The team could not finish this task.',
  needs_founder: 'An agent reached something only you can decide. A card is waiting for your answer.',
  failed: 'The task could not be worked.',
};
const REASONS = {
  bad_task: 'The task details are not valid.',
  bad_pod: 'There is no open project with that id.',
  team_unavailable: 'The Finance, Legal and Ops team could not be started.',
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
  if (!task || task.title === undefined) {
    console.error('Usage: npm run finance -- --title "Invoice Acme Studio" [--description "…"] [--pod <pod id>]\n       (find a pod id with: npm run pod -- list)');
    return 2;
  }
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // No .env: the runtime says exactly what is missing.
  }
  if (task.podId !== undefined && !process.env.PODS_ROOT) {
    console.error('PODS_ROOT is not set in .env. Set it to the same absolute folder the app uses for project spaces.');
    return 1;
  }

  const app = createApp({ env: process.env, version: 'finance', filesystemRoot: ROOT, toolConfigDir: path.join(ROOT, 'config', 'mcp'), skillsDir: path.join(ROOT, '.claude', 'skills'), podTemplatesDir: path.join(ROOT, 'config', 'pods') });
  if (app.problems.length > 0) {
    console.error(`The runtime is not set up: ${app.problems.join('; ')}.`);
    return 1;
  }
  const started = await app.start();
  if (!started.ok) {
    console.error('The runtime could not start. Check the database settings and that the migrations are applied (npm run check:db).');
    await app.stop();
    return 1;
  }

  let code = 0;
  try {
    const result = await app.finance.workTask(task);
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
