'use strict';

// Ask for a new project space (PLAN.md step 3.1), with your real accounts from .env:
//
//   npm run pod -- propose --name "Acme site" --template agency_client [--client-id <id>] [--service web_development] [--priority P1] [--deadline 2026-12-31] [--note "…"]
//   npm run pod -- list
//
// `propose` puts one plain-language card in front of you (in the window and on Telegram) and writes nothing else: no project, no folder.
// When you approve it, the app that is running opens the space (its folder, its git history, a first memory note and its agents); this
// script is closed by then, and an approved card is also opened the next time the app starts. Needs PODS_ROOT in .env (an absolute path),
// so that this script and the app agree on where the spaces live. It prints only plain words, never a key and never a service's error text.

const path = require('node:path');
const { createApp } = require('../src/runtime');

const ROOT = path.join(__dirname, '..');
const OPTIONS = { name: 'name', template: 'template', 'client-id': 'clientId', service: 'service', priority: 'priority', deadline: 'deadline', note: 'note', 'github-repo': 'githubRepo' };
const USAGE = 'Usage: npm run pod -- propose --name "Acme site" --template agency_client|saas_product [--client-id <id>] [--service web_development|ai_automation|marketing|content] [--priority P1|P2|P3] [--deadline 2026-12-31] [--note "…"] [--github-repo owner/name]\n       npm run pod -- list';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readProposal(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = OPTIONS[argv[i]?.replace(/^--/, '')];
    if (!key || argv[i + 1] === undefined) return null;
    out[key] = argv[i + 1];
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const proposal = command === 'propose' ? readProposal(rest) : null;
  if (!(command === 'list' && rest.length === 0) && !proposal) {
    console.error(USAGE);
    return 2;
  }
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // No .env: the runtime says exactly what is missing.
  }
  if (!process.env.PODS_ROOT) {
    console.error('PODS_ROOT is not set in .env. Set it to an absolute folder path (for example /home/you/sfactory-projects), so this script and the app agree on where the project spaces live.');
    return 1;
  }

  const app = createApp({ env: process.env, version: 'pod', filesystemRoot: ROOT, toolConfigDir: path.join(ROOT, 'config', 'mcp'), skillsDir: path.join(ROOT, '.claude', 'skills'), podTemplatesDir: path.join(ROOT, 'config', 'pods') });
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
    if (command === 'list') {
      const pods = await app.pods.list();
      if (pods.length === 0) console.log('No project spaces yet.');
      for (const p of pods) console.log(`${p.name} (${p.template === 'agency_client' ? 'client project' : 'own product'}, ${p.priority}, ${p.status}) id ${p.id}, in ${p.folder}`);
    } else {
      await app.pods.propose(proposal);
      console.log('A card is waiting for your answer (in the window and on Telegram). Nothing has been made yet.');
      await sleep(1500); // the card is sent to Telegram in the background
    }
  } catch (err) {
    // Our own errors are written for the founder; anything else stays generic.
    console.error(err?.name === 'PodError' || err?.name === 'DecisionError' ? err.message : 'The request could not be made.');
    if (Array.isArray(err?.problems)) console.error(err.problems.join('\n'));
    code = 1;
  }
  await app.stop();
  return code;
}

main().then((code) => process.exit(code));
