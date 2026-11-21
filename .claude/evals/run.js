#!/usr/bin/env node
'use strict';

// Usage: node .claude/evals/run.js [suite ...] [--strict] [--verbose] [--json]
//   --strict   pending suites (code not written yet) count as failures
//   --verbose  list every case, not only failures
//   --json     print the report as JSON instead of text
// Always writes .claude/evals/results/latest.json.

const fs = require('node:fs');
const path = require('node:path');
const { runSuite, exitCode } = require('./lib');

const SUITES_DIR = path.join(__dirname, 'suites');
const RESULTS_DIR = path.join(__dirname, 'results');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const wanted = args.filter((a) => !a.startsWith('--'));

function discover() {
  return fs
    .readdirSync(SUITES_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => require(path.join(SUITES_DIR, f)));
}

function formatReport(reports, verbose) {
  const lines = [];
  for (const r of reports) {
    const { pass, fail, pending, total } = r.counts;
    const score = r.score === null ? 'n/a' : `${Math.round(r.score * 100)}%`;
    lines.push(
      `${r.status.toUpperCase().padEnd(8)} ${r.name}  ${pass}/${total} pass, ${fail} fail, ${pending} pending  (score ${score}, need ${Math.round(r.threshold * 100)}%)`,
    );
    for (const c of r.results) {
      if (c.status === 'pass' && !verbose) continue;
      if (c.status === 'pending' && !verbose) continue;
      lines.push(`  ${c.status.padEnd(7)} ${c.id}${c.detail ? ` - ${c.detail}` : ''}`);
    }
    if (r.status === 'pending') lines.push(`  (${r.results[0].detail})`);
  }
  return lines.join('\n');
}

async function main() {
  let suites = discover();
  if (wanted.length > 0) {
    const missing = wanted.filter((w) => !suites.some((s) => s.name === w));
    if (missing.length > 0) {
      console.error(`Unknown suite(s): ${missing.join(', ')}. Available: ${suites.map((s) => s.name).join(', ')}`);
      process.exit(2);
    }
    suites = suites.filter((s) => wanted.includes(s.name));
  }

  const reports = [];
  for (const suite of suites) reports.push(await runSuite(suite));

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RESULTS_DIR, 'latest.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), reports }, null, 2),
  );

  console.log(flags.has('--json') ? JSON.stringify(reports, null, 2) : formatReport(reports, flags.has('--verbose')));
  process.exit(exitCode(reports, { strict: flags.has('--strict') }));
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
