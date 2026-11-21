# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies (Electron, electron-vite, Vite, React and Tailwind; all are dev dependencies because the renderer is bundled).
- `npm run dev` — run the app with Vite hot reload for the renderer (`electron-vite dev`).
- `npm run build` — build to `out/main`, `out/preload` and `out/renderer`.
- `npm start` — build, then launch the production build (`electron-vite preview`). `package.json` `main` points at the built `out/main/main.js`, so plain `electron .` only works after a build.
- `npm run check:keys` — verify the accounts and keys in `.env` with one read-only call each (Groq, Telegram, Supabase, Ollama, Claude CLI, git hygiene); never prints a secret. `npm run check:keys -- --find-telegram-chat` lists the chat IDs that messaged your bot.
- `npm run db:migrate` — apply `supabase/migrations/*.sql` to your Supabase project through the management API (needs `SUPABASE_ACCESS_TOKEN` in `.env`; use `-- --dry-run` first). Records applied migrations, refuses to run over a project that already has tables or to apply out of order. Add new migrations as new files; never edit an applied one.
- `npm run check:db` — after applying the migrations to your Supabase project, check that all 11 core tables exist (read-only; uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`).
- `npm test` — unit tests (`node --test` over `.claude/**/*.test.js`, `src/**/*.test.js` and `scripts/**/*.test.js`; the globs are explicit because Node's default discovery skips dot-directories). Single file: `node --test .claude/evals/lib.test.js`.
- `npm run eval` — run all eval suites in `.claude/evals/suites/`. One suite: `node .claude/evals/run.js policy-check`. Add `--verbose` to list every case.
- `npm run eval:strict` — same, but suites whose code isn't written yet count as failures. Use this at phase gates.

There is no linter configured yet. `out/` (build output) and `dist/` (reserved for packaging) are gitignored.

## Evals

The plan (`.claude/PLAN.md`) is eval-first: golden datasets in `.claude/evals/datasets/` are written before the code they grade. A suite (`.claude/evals/suites/*.js`) exports `{ name, description, threshold, cases(), run(case) }`. If the module under test doesn't exist, the case is reported as **pending**, not failed (`loadSubject` in `.claude/evals/lib.js`). The input/output contracts for `src/runtime/policy.js`, `src/runtime/cards.js` and `src/runtime/providers/claude-code.js` are in the header comments of `.claude/evals/suites/policy-check.js`, `decision-cards.js` and `claude-code-provider.js`. When adding a feature, add its eval cases first.

`.claude/EVALS.md` is the registry of every eval (suites, case counts, status, planned evals). Update it in the same change as any eval you add, remove or edit; the `evals-doc-in-sync` check in the `invariants` suite fails if a suite is missing there or its `**Cases:**` count is stale.

## Architecture

Electron app built with `electron-vite` (Vite 8): main and preload are plain CommonJS JavaScript, the renderer is React 19 (JSX). The standard three-process split, with sources at the paths below and `electron.vite.config.mjs` mapping them to `out/`:

- `src/main.js` → `out/main/main.js` — main process. Creates a single 900×600 `BrowserWindow`, loads the Vite dev server URL (`ELECTRON_RENDERER_URL`, set by `npm run dev`) or the built `out/renderer/index.html`. Quits on window close except on macOS. Before the window loads it creates the runtime (`createApp` from `src/runtime/`) and the IPC bridge (`src/ipc.js`); it then calls `runtime.start()` (records `runtime.started`, or blocks the runtime if the database is not ready) and records `runtime.stopped` on quit. It loads `.env` from the app folder; settings already in the environment win.
- `src/preload.js` → `out/preload/preload.js` — the only bridge between main and renderer. Exposes `window.versions` (Node/Chrome/Electron versions) and `window.api` (`runtime.status`, `decisions.list`, `decisions.resolve`, `agents.pause`, `onEvent`) and nothing else. Each function sends one fixed message on the `runtime:invoke` channel (events arrive on `runtime:event`); `ipcRenderer` itself is never exposed, and two invariants enforce that. To add a capability: register a command in `src/runtime/commands.js`, add one function to `window.api`, and extend the `runtime-core` eval first. Main finds it at `../preload/preload.js` relative to the built main file.
- `src/renderer/` → `out/renderer/` — sandboxed React UI. `index.html` loads `main.jsx`, which mounts `App.jsx` and imports `styles.css`. Styling is Tailwind CSS 4: `styles.css` is just `@import 'tailwindcss'`, components use utility classes, and the `@tailwindcss/vite` plugin in `electron.vite.config.mjs` generates the CSS. There is no `tailwind.config.js` or PostCSS config (v4 is CSS-first): add design tokens with `@theme { … }` in `styles.css`.

Reserved directories, empty until their plan steps (see `.claude/PLAN.md`): `src/shared/` (so far only `supabase-url.js`), `config/mcp/` (per-team MCP config) and `.claude/skills/` (agent skills; `.claude/skills/shared/company-charter/SKILL.md` is the draft base prompt for every agent). Environment variable names are in `.env.example`; real values go in the gitignored `.env`.

### Runtime

`src/runtime/` is the agent engine and **must never import `electron`** (an invariant enforces it), so it can later run headless on a server. `createApp({ env })` in `index.js` wires `config.js` (validates settings) → `store/rest.js` (Supabase REST API with the service key) → `audit.js` (the `audit_log` writer, redacts secrets) → `runtime.js` (the command bus) → `commands.js` (the registered commands). The bus enforces, and the `runtime-core` eval tests: unknown commands and bad arguments are refused; **the audit entry is written before a handler runs, and if it cannot be written the handler does not run**; errors returned to the UI are generic. Commands are audited by default; use `audit: 'never'` only for health checks. If settings are missing or the audit log cannot be written, the runtime blocks itself: it refuses actions with the reason and still answers `runtime.status`. For development without your real tables, `node scripts/fake-supabase.js` starts a local stand-in for Supabase's REST API (a real Postgres with the migrations) and prints the two settings to run `npm run dev` against it; `src/runtime/runtime.integration.test.js` uses the same stand-in.

### Database

Supabase Postgres, defined in `supabase/migrations/*.sql` (applied in filename order; add new migrations, never edit applied ones) with a dev-only `supabase/seed.sql`. The runtime is the only database client and uses the service key (bypasses row-level security); the renderer never touches the database. The row-level-security policies are keyed on a `pod_id` JWT claim for future pod-scoped clients, and the integrity rules (append-only `audit_log`, frozen `decisions`) are triggers, so they hold for everyone. Every new public table must enable row-level security (the `database-schema` eval fails otherwise) and must be added to that suite's fixture. `npm run eval database-schema` tests the migrations on an in-process Postgres (PGlite) with no credentials; `npm run check:db` checks that the tables exist in the real project (read-only).

### Security constraints to preserve

The window is configured with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`, and `index.html` sets a strict CSP (`default-src 'self'; script-src 'self'; style-src 'self'`). Consequences when adding features:

- Renderer code cannot `require` anything or touch Node/Electron APIs directly; expose each capability explicitly from `preload.js` via `contextBridge` (ideally backed by `ipcMain.handle` / `ipcRenderer.invoke`, not by exposing raw `ipcRenderer`).
- Because the preload is sandboxed, it can only `require` `electron` (limited subset) and a few built-ins — not arbitrary local modules or npm packages.
- No inline `<script>`/`<style>`, inline `style=` attributes or remote resources; the production CSP blocks them. Put code and CSS in separate files under `src/renderer/` (Vite bundles them).
- The strict CSP lives in `src/renderer/index.html` and applies to builds. `npm run dev` needs inline scripts (React Refresh) and a websocket (HMR), so `electron.vite.config.mjs` has a plugin (`dev-only-csp`, `apply: 'serve'`) that relaxes the CSP in dev only. Keep it `serve`-only: a dev-only success can hide a CSP violation that breaks the production build, so check features with `npm start` too. The `invariants` suite guards this.
