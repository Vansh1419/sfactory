# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies (Electron, electron-vite, Vite, React and Tailwind; all are dev dependencies because the renderer is bundled).
- `npm run dev` — run the app with Vite hot reload for the renderer (`electron-vite dev`).
- `npm run build` — build to `out/main`, `out/preload` and `out/renderer`.
- `npm start` — build, then launch the production build (`electron-vite preview`). `package.json` `main` points at the built `out/main/main.js`, so plain `electron .` only works after a build.
- `npm test` — unit tests (`node --test` over `.claude/**/*.test.js` and `src/**/*.test.js`; the globs are explicit because Node's default discovery skips dot-directories). Single file: `node --test .claude/evals/lib.test.js`.
- `npm run eval` — run all eval suites in `.claude/evals/suites/`. One suite: `node .claude/evals/run.js policy-check`. Add `--verbose` to list every case.
- `npm run eval:strict` — same, but suites whose code isn't written yet count as failures. Use this at phase gates.

There is no linter configured yet. `out/` (build output) and `dist/` (reserved for packaging) are gitignored.

## Evals

The plan (`.claude/PLAN.md`) is eval-first: golden datasets in `.claude/evals/datasets/` are written before the code they grade. A suite (`.claude/evals/suites/*.js`) exports `{ name, description, threshold, cases(), run(case) }`. If the module under test doesn't exist, the case is reported as **pending**, not failed (`loadSubject` in `.claude/evals/lib.js`). The input/output contract for `src/runtime/policy.js` and `src/runtime/cards.js` is in the header comment of `.claude/evals/suites/policy-check.js` and `decision-cards.js`. When adding a feature, add its eval cases first.

`.claude/EVALS.md` is the registry of every eval (suites, case counts, status, planned evals). Update it in the same change as any eval you add, remove or edit; the `evals-doc-in-sync` check in the `invariants` suite fails if a suite is missing there or its `**Cases:**` count is stale.

## Architecture

Electron app built with `electron-vite` (Vite 8): main and preload are plain CommonJS JavaScript, the renderer is React 19 (JSX). The standard three-process split, with sources at the paths below and `electron.vite.config.mjs` mapping them to `out/`:

- `src/main.js` → `out/main/main.js` — main process. Creates a single 900×600 `BrowserWindow`, loads the Vite dev server URL (`ELECTRON_RENDERER_URL`, set by `npm run dev`) or the built `out/renderer/index.html`. Quits on window close except on macOS.
- `src/preload.js` → `out/preload/preload.js` — the only bridge between main and renderer. Uses `contextBridge.exposeInMainWorld('versions', …)` to expose Node/Chrome/Electron version strings as `window.versions`. Main finds it at `../preload/preload.js` relative to the built main file.
- `src/renderer/` → `out/renderer/` — sandboxed React UI. `index.html` loads `main.jsx`, which mounts `App.jsx` and imports `styles.css`. Styling is Tailwind CSS 4: `styles.css` is just `@import 'tailwindcss'`, components use utility classes, and the `@tailwindcss/vite` plugin in `electron.vite.config.mjs` generates the CSS. There is no `tailwind.config.js` or PostCSS config (v4 is CSS-first): add design tokens with `@theme { … }` in `styles.css`.

Reserved directories, empty until their plan steps (see `.claude/PLAN.md`): `src/runtime/` (the agent engine; must never import `electron`, an invariant enforces it), `src/shared/`, `config/mcp/` (per-team MCP config) and `.claude/skills/` (agent skills; `.claude/skills/shared/company-charter/SKILL.md` is the draft base prompt for every agent). Environment variable names are in `.env.example`; real values go in the gitignored `.env`.

### Security constraints to preserve

The window is configured with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`, and `index.html` sets a strict CSP (`default-src 'self'; script-src 'self'; style-src 'self'`). Consequences when adding features:

- Renderer code cannot `require` anything or touch Node/Electron APIs directly; expose each capability explicitly from `preload.js` via `contextBridge` (ideally backed by `ipcMain.handle` / `ipcRenderer.invoke`, not by exposing raw `ipcRenderer`).
- Because the preload is sandboxed, it can only `require` `electron` (limited subset) and a few built-ins — not arbitrary local modules or npm packages.
- No inline `<script>`/`<style>`, inline `style=` attributes or remote resources; the production CSP blocks them. Put code and CSS in separate files under `src/renderer/` (Vite bundles them).
- The strict CSP lives in `src/renderer/index.html` and applies to builds. `npm run dev` needs inline scripts (React Refresh) and a websocket (HMR), so `electron.vite.config.mjs` has a plugin (`dev-only-csp`, `apply: 'serve'`) that relaxes the CSP in dev only. Keep it `serve`-only: a dev-only success can hide a CSP violation that breaks the production build, so check features with `npm start` too. The `invariants` suite guards this.
