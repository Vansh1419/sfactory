'use strict';

// Architecture and security invariants from PLAN.md. These grade the repo
// itself, so they run (and must pass) from day one.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../lib');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const checks = [
  {
    id: 'runtime-never-imports-electron',
    // src/runtime must stay headless-capable (PLAN.md: process layout).
    check() {
      const offenders = walk(path.join(ROOT, 'src', 'runtime'))
        .filter((f) => /\.(c|m)?js$/.test(f))
        .filter((f) => /require\(\s*['"]electron['"]\s*\)|from\s+['"]electron['"]/.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(ROOT, f));
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, detail: `imports electron: ${offenders.join(', ')}` };
    },
  },
  {
    id: 'window-security-flags',
    check() {
      const src = read('src/main.js');
      const missing = ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true'].filter(
        (flag) => !src.includes(flag),
      );
      return missing.length === 0 ? { pass: true } : { pass: false, detail: `missing in src/main.js: ${missing.join(', ')}` };
    },
  },
  {
    id: 'renderer-csp-strict',
    check() {
      const html = read('src/renderer/index.html');
      if (!/Content-Security-Policy/i.test(html)) return { pass: false, detail: 'no CSP meta tag' };
      if (!html.includes("default-src 'self'")) return { pass: false, detail: "CSP lacks default-src 'self'" };
      const loose = ["'unsafe-inline'", "'unsafe-eval'"].filter((t) => html.includes(t));
      return loose.length === 0 ? { pass: true } : { pass: false, detail: `CSP allows ${loose.join(', ')}` };
    },
  },
  {
    id: 'dev-csp-relaxation-serve-only',
    // electron.vite.config.mjs may loosen the CSP for hot reload, but only in
    // `electron-vite dev`. If it ever applied to builds, production would ship
    // 'unsafe-inline'.
    check() {
      // Strip comments so prose mentioning apply: 'serve' cannot satisfy the check.
      const cfg = read('electron.vite.config.mjs')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (!cfg.includes("'unsafe-inline'")) return { pass: true };
      return /apply:\s*'serve'/.test(cfg)
        ? { pass: true }
        : { pass: false, detail: "electron.vite.config.mjs loosens the CSP without apply: 'serve'" };
    },
  },
  {
    id: 'preload-no-raw-ipcrenderer',
    // Exposing ipcRenderer itself lets the renderer call any channel.
    check() {
      // The import line (`const { contextBridge, ipcRenderer } = require('electron')`) is fine; ignore it.
      const src = read('src/preload.js').replace(/^.*require\(\s*['"]electron['"]\s*\).*$/gm, '');
      const raw = /[{,:]\s*ipcRenderer\s*[,}]/.test(src);
      return raw ? { pass: false, detail: 'ipcRenderer is exposed to the renderer directly' } : { pass: true };
    },
  },
  {
    id: 'preload-exposes-only-the-planned-api',
    // window.api is the renderer's whole view of the runtime (PLAN.md step 1.2):
    // two globals, and IPC only on two fixed channel names written as literals.
    check() {
      const src = read('src/preload.js');
      const names = [...src.matchAll(/exposeInMainWorld\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      const extraGlobals = names.filter((n) => !['versions', 'api'].includes(n));
      const calls = [...src.matchAll(/ipcRenderer\.(\w+)\(\s*(['"][^'"]*['"])?/g)].map((m) => ({ method: m[1], channel: m[2]?.slice(1, -1) }));
      const allowedChannels = ['runtime:invoke', 'runtime:event'];
      const allowedMethods = ['invoke', 'on', 'removeListener'];
      const badMethods = calls.filter((c) => !allowedMethods.includes(c.method)).map((c) => c.method);
      const badChannels = calls.filter((c) => !c.channel || !allowedChannels.includes(c.channel)).map((c) => c.channel ?? '(not a literal)');
      const problems = [
        ...extraGlobals.map((n) => `exposes window.${n}`),
        ...badMethods.map((m) => `uses ipcRenderer.${m}`),
        ...badChannels.map((c) => `uses channel ${c}`),
      ];
      return problems.length === 0 ? { pass: true } : { pass: false, detail: problems.join('; ') };
    },
  },
  {
    id: 'secrets-and-results-gitignored',
    check() {
      const lines = read('.gitignore').split('\n').map((l) => l.trim());
      const missing = ['.env', '.claude/evals/results/'].filter((p) => !lines.includes(p));
      return missing.length === 0 ? { pass: true } : { pass: false, detail: `.gitignore missing: ${missing.join(', ')}` };
    },
  },
  {
    id: 'claude-docs-in-dot-claude',
    // Project rule: every Claude-related document lives under .claude/.
    check() {
      const names = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'PLAN.md', 'EVALS.md', 'SKILL.md']);
      const skip = new Set(['.git', '.claude', 'node_modules', 'out', 'dist']);
      const found = [];
      const scan = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) {
            if (!skip.has(e.name)) scan(path.join(dir, e.name));
          } else if (names.has(e.name)) {
            found.push(path.relative(ROOT, path.join(dir, e.name)));
          }
        }
      };
      scan(ROOT);
      return found.length === 0 ? { pass: true } : { pass: false, detail: `outside .claude/: ${found.join(', ')}` };
    },
  },
  {
    id: 'env-example-names-only',
    // .env.example is committed, so it may list variable names but never values.
    check() {
      if (!fs.existsSync(path.join(ROOT, '.env.example'))) return { pass: false, detail: '.env.example is missing' };
      const bad = read('.env.example')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
        .filter((l) => !/^[A-Z][A-Z0-9_]*=$/.test(l))
        .map((l) => l.split('=')[0]);
      return bad.length === 0
        ? { pass: true }
        : { pass: false, detail: `.env.example has values or odd lines for: ${bad.join(', ')}` };
    },
  },
  {
    id: 'evals-doc-in-sync',
    // .claude/EVALS.md must list every suite with its current case count.
    check() {
      const docPath = '.claude/EVALS.md';
      if (!fs.existsSync(path.join(ROOT, docPath))) return { pass: false, detail: `${docPath} is missing` };
      const sections = read(docPath).split(/^### /m).slice(1);
      const suitesDir = path.join(ROOT, '.claude', 'evals', 'suites');
      const problems = [];
      for (const file of fs.readdirSync(suitesDir).filter((f) => f.endsWith('.js'))) {
        const suite = file === 'invariants.js' ? module.exports : require(path.join(suitesDir, file));
        const section = sections.find((s) => s.startsWith(`${suite.name}\n`));
        if (!section) {
          problems.push(`${suite.name}: no "### ${suite.name}" section`);
          continue;
        }
        const m = section.match(/\*\*Cases:\*\* (\d+)/);
        const actual = suite.cases().length;
        if (!m) problems.push(`${suite.name}: no **Cases:** line`);
        else if (Number(m[1]) !== actual) problems.push(`${suite.name}: doc says ${m[1]}, suite has ${actual}`);
      }
      return problems.length === 0 ? { pass: true } : { pass: false, detail: problems.join('; ') };
    },
  },
];

module.exports = {
  name: 'invariants',
  description: 'Repo-level architecture and security rules from PLAN.md',
  threshold: 1,
  cases: () => checks,
  run: (c) => c.check(),
};
