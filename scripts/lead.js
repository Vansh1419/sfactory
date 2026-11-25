'use strict';

// Give the Marketing and Sales team one lead (PLAN.md step 2.3), with your real accounts from .env:
//
//   npm run lead -- --company "Acme Ltd" --website https://acme.example/ --email hello@acme.example [--price "₹50,000"]
//
// The team researches the company on the web (needs TAVILY_API_KEY), saves it in the lead list, writes a proposal, and puts
// the email through the review and the founder's approval. Only --company is required. Nothing is sent to the company: the email
// waits on a card (in the window and on Telegram) until you approve it, and no mail account is connected to send it yet.
//
// It starts the same runtime as the app, so it needs the same settings (Supabase, a model provider) and prints only plain words:
// never a key, never the text of an error from a service.

const path = require('node:path');
const { createApp } = require('../src/runtime');

const ROOT = path.join(__dirname, '..');
const OPTIONS = ['company', 'website', 'email', 'price'];
const SAYS = {
  done: 'The team finished. The email is waiting for your approval (check the card), or is ready to send.',
  blocked: 'The team could not finish this lead.',
  needs_founder: 'An agent reached something only you can decide. A card is waiting for your answer.',
  failed: 'The lead could not be worked.',
};

function readArgs(argv) {
  const lead = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!OPTIONS.includes(key) || argv[i + 1] === undefined) return null;
    lead[key] = argv[i + 1];
  }
  return lead;
}

async function main() {
  const lead = readArgs(process.argv.slice(2));
  if (!lead || lead.company === undefined) {
    console.error('Usage: npm run lead -- --company "Acme Ltd" [--website https://acme.example/] [--email hello@acme.example] [--price "₹50,000"]');
    return 2;
  }
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // No .env: the runtime says exactly what is missing.
  }

  const app = createApp({ env: process.env, version: 'lead', filesystemRoot: ROOT, toolConfigDir: path.join(ROOT, 'config', 'mcp'), skillsDir: path.join(ROOT, '.claude', 'skills') });
  if (app.problems.length > 0) {
    console.error(`The runtime is not set up: ${app.problems.join('; ')}.`);
    return 1;
  }
  if (!process.env.TAVILY_API_KEY) console.warn('Note: TAVILY_API_KEY is not set, so the team has no web search.');
  const started = await app.start();
  if (!started.ok) {
    console.error('The runtime could not start. Check the database settings and that the migrations are applied (npm run check:db).');
    await app.stop();
    return 1;
  }

  let code = 0;
  try {
    const result = await app.sales.workLead(lead);
    console.log(SAYS[result.status] ?? 'The lead was worked.');
    if (result.reason) console.log(`Reason: ${result.reason}`);
    if (Array.isArray(result.problems) && result.problems.length > 0) console.log(result.problems.join('\n'));
    for (const out of result.outputs ?? []) console.log(`\n${out.worker}: ${out.output}`);
    if (result.status !== 'done' && result.status !== 'needs_founder') code = 1;
  } catch {
    console.error('The lead could not be worked.');
    code = 1;
  }
  await app.stop();
  return code;
}

main().then((code) => process.exit(code));
