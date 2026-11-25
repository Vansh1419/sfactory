'use strict';

// Autoscaling by hand (PLAN.md step 4.1), with your real accounts from .env:
//
//   npm run scale            what each team's queue looks like and what the autoscaler would do (changes nothing)
//   npm run scale -- run     one pass: adds or removes agents, asks you on a card past a cap, closes finished projects
//
// It starts the same runtime as the app, so it needs the same settings, and it prints only plain words: never a key, never the text of an error.

const path = require('node:path');
const { createApp } = require('../src/runtime');

const ROOT = path.join(__dirname, '..');
const STATE = { ok: 'fine', busy: 'busy: would add an agent', at_cap: 'busy and at its limit: would ask you' };

async function main() {
  const command = process.argv[2] ?? 'status';
  if (!['status', 'run'].includes(command)) {
    console.error('Usage: npm run scale            (look)\n       npm run scale -- run     (one pass)');
    return 2;
  }
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // No .env: the runtime says exactly what is missing.
  }
  const app = createApp({ env: { ...process.env, AUTOSCALE_EVERY_SECONDS: 'off' }, version: 'scale', filesystemRoot: ROOT, toolConfigDir: path.join(ROOT, 'config', 'mcp'), skillsDir: path.join(ROOT, '.claude', 'skills'), podTemplatesDir: path.join(ROOT, 'config', 'pods') });
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
    const groups = await app.autoscaler.status();
    if (groups.length === 0) console.log('No team has agents of a kind that can be scaled yet.');
    for (const g of groups) console.log(`${g.team} ${g.role}s: ${g.agents} (limit ${g.max}), ${g.queued} waiting (${g.perAgent} each, oldest ${g.waitMinutes} min), ${STATE[g.state]}`);
    if (command === 'run') {
      const result = await app.autoscaler.tick();
      if (result.skipped) console.log('Nothing was done: the runtime is blocked or another pass is running.');
      else console.log(`Done: ${result.added.length} added, ${result.removed.length} removed, ${result.moved} tasks moved, ${result.carded.length} card(s) for you, ${result.closed.length} project space(s) closed.`);
    }
  } catch {
    console.error('That could not be done.');
    code = 1;
  }
  await app.stop();
  return code;
}

main().then((code) => process.exit(code));
