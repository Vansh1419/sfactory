'use strict';

// Add a support ticket and give it to the Support team (PLAN.md step 2.4), with your real accounts from .env:
//
//   npm run ticket -- add --email ann@example.com --subject "Where is my invoice?" --message "I cannot find it." [--name Ann]
//   npm run ticket -- work [--id <ticket id>]        works that ticket, or the oldest open one
//   npm run ticket -- list                           shows the latest tickets and where each stands
//
// A routine ticket is answered: the reply is reviewed and, while the founder's approval is required, waits on a card. A refund,
// discount, complaint or legal ticket becomes a founder card and the team writes nothing to the customer. Nothing is sent to anyone:
// no mail account is connected yet.
//
// It starts the same runtime as the app, so it needs the same settings (Supabase, a model provider) and prints only plain words:
// never a key, never the text of an error from a service. The `tickets` table must exist (`npm run db:migrate`).

const path = require('node:path');
const { createApp } = require('../src/runtime');

const ROOT = path.join(__dirname, '..');
const USAGE = [
  'Usage:',
  '  npm run ticket -- add --email ann@example.com --subject "Where is my invoice?" --message "I cannot find it." [--name Ann]',
  '  npm run ticket -- work [--id <ticket id>]',
  '  npm run ticket -- list',
].join('\n');
const SAYS = {
  done: 'The ticket was answered. The reply is waiting for your approval or is ready; nothing was sent.',
  needs_founder: 'The ticket needs your decision. A card is waiting for your answer, and nothing was written to the customer.',
  blocked: 'The team could not finish this ticket.',
  failed: 'The ticket could not be worked.',
  none: 'There are no open tickets.',
};
const FLAGS = { add: ['email', 'subject', 'message', 'name'], work: ['id'], list: [] };

function readFlags(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!allowed.includes(key) || argv[i + 1] === undefined) return null;
    out[key] = argv[i + 1];
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = FLAGS[command] ? readFlags(rest, FLAGS[command]) : null;
  if (!flags || (command === 'add' && !(flags.email && flags.subject && flags.message))) {
    console.error(USAGE);
    return 2;
  }
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // No .env: the runtime says exactly what is missing.
  }

  const app = createApp({ env: process.env, version: 'ticket', filesystemRoot: ROOT, toolConfigDir: path.join(ROOT, 'config', 'mcp'), skillsDir: path.join(ROOT, '.claude', 'skills') });
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
    if (command === 'add') {
      const made = await app.store.insert('tickets', { customer_email: flags.email, subject: flags.subject, body: flags.message, ...(flags.name ? { customer_name: flags.name } : {}) });
      console.log(`Ticket added. Id: ${made.id}`);
    } else if (command === 'list') {
      const rows = await app.store.select('tickets', { order: 'created_at.desc', limit: 15 });
      if (rows.length === 0) console.log('There are no tickets.');
      for (const t of rows) console.log(`${t.id}  ${t.status.padEnd(11)} ${String(t.created_at).slice(0, 16)}  ${t.subject.slice(0, 60)}`);
    } else {
      const result = flags.id ? await app.support.workTicket({ ticketId: flags.id }) : await app.support.workNext();
      console.log(SAYS[result.status] ?? 'The ticket was worked.');
      if (result.reason) console.log(`Reason: ${result.reason}`);
      for (const out of result.outputs ?? []) console.log(`\n${out.worker}: ${out.output}`);
      if (!['done', 'needs_founder', 'none'].includes(result.status)) code = 1;
    }
  } catch {
    console.error('That did not work. If the tickets table is missing, run npm run db:migrate.');
    code = 1;
  }
  await app.stop();
  return code;
}

main().then((code) => process.exit(code));
