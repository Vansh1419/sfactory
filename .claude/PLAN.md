# PLAN: AI-Driven Organization, Version 1 (Electron)

Source: `.claude/docs/kickstart.md`. Status: **in progress**. This is Version 1 of the application. The eval setup (step 0.4) is built first; feature code starts after it.

## Goal

One founder talks to an **Orchestrator** agent. It splits goals into tasks for 4 team leads (Product & Engineering, Marketing & Sales, Customer Support, Finance/Legal/Ops), who manage a few workers each. Only crucial decisions reach the founder. v1 ships in 2–4 weeks on free APIs.

v1 scope: orchestrator, 4 team leads with a few workers each, one approval queue, one dashboard, one Telegram bot. No real money moves without the founder.

## Hard requirements (from the kickstart)

- **Policy check is code, not an LLM.** Four action types always stop for the founder: any spending; hiring/firing/signing; production launches and price changes; legal documents and public statements. Deny by default.
- **Plain-language approvals.** Every decision card uses the fixed 7-field format (what to decide, why now, if yes, if no, cost, risk, recommendation). A writer step rewrites it, a checker step rejects jargon, code or missing fields. Money in ₹ and $, times in IST. Technical detail sits behind "Show details".
- **One `decisions` table.** Telegram and the dashboard write the same row, so nothing is approved twice. Unanswered cards are reminded and never auto-approved.
- **Pods.** One per project, each with its own memory, files, git repo and client data. Pod A cannot read pod B. Priority P1–P3. Scaling is bounded by a cap set by the founder.
- **Tools.** Each team gets only its own MCP config plus `shared`. Every MCP tool is tagged read or write; write tools that spend, send externally, deploy or sign go through the policy check first.
- **Agents hold no payment credentials.** Secrets live in env or a vault, never in prompts, logs or git.
- **Guards.** Max steps and max tokens per task, a daily task cap per agent, and a per-agent and per-team kill switch.

## Architecture (Electron, decided)

The kickstart's Python/FastAPI/Next.js pieces are replaced so the app stays on the existing Electron scaffold.

| Kickstart pick | Replaced by |
|---|---|
| Next.js dashboard | Electron renderer |
| FastAPI backend | Node agent runtime started by the main process, reached over IPC |
| LangGraph (Python) | LangGraph JS (`@langchain/langgraph`) |
| LiteLLM | Provider-fallback wrapper (Vercel AI SDK). v1 providers, in order: Groq, local Ollama, then Claude Code running headless (Haiku, low effort) as the last fallback. Gemini and OpenRouter are deferred and get added later through configuration. |
| `langchain-mcp-adapters` | `@langchain/mcp-adapters` |
| Telegram bot in FastAPI | `grammY` bot inside the runtime |
| Supabase (Postgres, pgvector, Realtime) | Unchanged, accessed by the runtime only |

### Process layout

| Path | Role |
|---|---|
| `src/main.js` | Entry point. Adds tray, `ipcMain.handle` endpoints, starts and stops the runtime. |
| `src/runtime/` | Agent engine: orchestrator, leads, workers, policy check, writer and checker, model router, MCP loader, scaling, Telegram bot. **Never imports `electron`**, so it can run headless later. |
| `src/preload.js` | Narrow `window.api` (`decisions.list`, `decisions.resolve`, `agents.pause`, event subscription). No raw `ipcRenderer`. |
| `src/renderer/` | Dashboard pages and project view (React and Tailwind, bundled by `electron-vite`). Talks only to `window.api`. |
| `src/shared/` | Types and constants used by runtime and main. |
| `config/mcp/` | `shared.yaml`, `orchestrator.yaml`, `engineering.yaml`, `marketing_sales.yaml`, `support.yaml`, `finance_ops.yaml` |
| `.claude/skills/` | `shared/`, plus one folder per team, each skill a `SKILL.md` (kept under `.claude/` with the other Claude documents; an invariant enforces it) |

### Security constraints to preserve

The existing window settings stay: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP (`default-src 'self'`). Consequences:

- API keys exist only in the runtime (Electron `safeStorage` or `.env`), never in the renderer.
- The CSP blocks the renderer from calling Supabase, so the live feed goes runtime → main → `webContents.send` → renderer.
- The production CSP is not loosened. Renderer code is bundled into local files. Only `electron-vite dev` gets a relaxed CSP (for hot reload), through a plugin limited to `serve` mode, and an invariant checks that it stays that way.

## Data model

Core tables: `tasks`, `agents`, `decisions`, `audit_log`, `memory`, `clients`, `projects`, `agent_events`, plus `pods`, `pod_members`, `scaling_rules`.

## Codebase grounding

The repo today is a small Electron and React hello-world built with `electron-vite` (`src/main.js`, `src/preload.js`, `src/renderer/*`). The only tests are for the eval runner; there is no database and no logging or error-handling convention. Nothing exists to mirror, so Phase 0 sets the patterns.

## Phases

Each phase is split into numbered steps (for example `1.4`). A step is small enough to finish and check on its own, and each has a **Done when** line. A phase gate runs only after all its steps are done. Day counts are estimates for one developer.

| Phase | Steps | Days | Gate |
|---|---|---|---|
| 0. Foundation | 0.1 – 0.4 | 1–2 | App launches, tests and evals run, charter written |
| 1. Approval spine | 1.1 – 1.11 | 3–7 | Fake spend flows end to end through one approval |
| 2. Client-facing teams | 2.1 – 2.7 | 8–14 | Lead to proposal to approval; ticket answered or escalated |
| 3. Engineering, Finance, pods | 3.1 – 3.8 | 15–21 | Pod created, PR opened, invoice drafted, all isolated |
| 4. Scale and go live | 4.1 – 4.7 | 22–28 | A mock project week with no unapproved write action |

### Phase 0: Foundation (days 1–2)

**0.1 Accounts and keys** (half a day) — status: **done** (all required checks pass, verified Nov 21, 2026)
- [x] GitHub repo: `Vansh1419/sfactory`, pushed and in sync (visibility is an open decision, see below).
- [x] Ollama installed and running locally (11 models). Claude Code CLI present for the last fallback.
- [x] `.env.example` with names only, and an invariant checks it never holds values.
- [x] `npm run check:keys` (`scripts/check-keys.js`): one read-only call per key, never prints a secret, refuses to send the Supabase service key anywhere except `*.supabase.co` or localhost, and `-- --find-telegram-chat` lists your chat ID. Unit-tested; failure paths confirmed against the real Groq and Telegram APIs with fake keys.
- [x] **Supabase project**: verified Nov 21, 2026. The URL is a valid project URL and the key is a new-style secret key (`sb_secret_…`), which is the right kind for the runtime. (The check proves the key is accepted; it does not yet prove the key's permissions.)
- [x] **Groq key**: verified Nov 21, 2026 (key accepted, 11 models available). Gemini and OpenRouter are deferred.
- [x] **Telegram bot**: verified Nov 21, 2026. The token is accepted, and the founder chat ID is a private chat the bot can see. (An earlier token was rejected with `401 Unauthorized` and was replaced.)
- [x] **`.env` created and gitignored.**
- **Done when:** `npm run check:keys` reports every required item OK (Groq, Telegram token and chat ID, Supabase) and "Secrets stay out of git" is OK.

**0.2 Repo restructure and tooling** (one day) — status: **done**, all four conditions verified Nov 21, 2026 (including `npm start` opening the window, checked by launching it and reading the page)
- Folders `src/runtime/`, `src/shared/`, `config/mcp/` and `.claude/skills/` created (empty, with `.gitkeep`, until their steps). Sources stay at `src/main.js` and `src/preload.js`; `package.json` `main` is the built `out/main/main.js`.
- Renderer bundler: **done.** `electron-vite` 6 with Vite 8, React 19 and Tailwind CSS 4 (`@tailwindcss/vite`), configured in `electron.vite.config.mjs`. Scripts: `dev`, `build`, `start` (preview of the production build). The production CSP stays strict; a dev-only plugin relaxes it under `electron-vite dev` only.
- `node:test` and the `npm test` script: **done** (tests of the eval runner).
- The check that fails if anything under `src/runtime/` imports `electron`: **done** (`invariants` suite).
- **Done when:** `npm run build` succeeds, `npm start` opens the window, `npm test` passes, and the import check passes.

**0.3 Charter and docs** (half a day) — status: **done** except the mission statement and the first SaaS idea, which the founder has not decided (both are marked in the charter, not guessed)
- Company charter: **draft v0.2** at `.claude/skills/shared/company-charter/SKILL.md` (rules for every agent, what always needs the founder, the 7-field approval format). Filled in on Nov 21, 2026 from the founder's answers: company name sfactory (working name), sole proprietorship, four agency services with one pilot project in each (web development, AI automation, marketing, content). Still **[Founder to fill in]**: the mission statement and the first SaaS idea. This becomes the shared base prompt.
- `CLAUDE.md` updated with the new commands and structure and links to `PLAN.md` and `EVALS.md`: **done**.
- **Done when:** the charter is in `.claude/skills/shared/company-charter/SKILL.md` and `CLAUDE.md` matches the repo.

**0.4 Eval setup** (half a day, **built first**) — status: runner, datasets and invariants written
- `.claude/evals/run.js` runs every suite in `.claude/evals/suites/` and writes `.claude/evals/results/latest.json` (gitignored). `npm run eval` treats unwritten code as "pending"; `npm run eval:strict` (used at every phase gate) treats pending as a failure.
- Golden datasets are written before the code they grade, so the code is built to pass them:
  - `policy-check` (32 cases) grades `src/runtime/policy.js`: the four always-ask categories, deny-by-default, and resistance to notes like "the founder already approved this".
  - `decision-cards` (15 cases at first, 44 after step 1.5) grades the checker and the writer-checker loop in `src/runtime/cards.js`: required fields, jargon, code, ₹ and $ cost, IST times, retry limit.
  - `invariants` grades the repo today: no `electron` import under `src/runtime/`, window security flags, strict CSP, no raw `ipcRenderer` in the preload, the dev-only CSP relaxation stays `serve`-only, secrets and results gitignored, `.env.example` holds names only, all Claude documents stay under `.claude/`, `EVALS.md` in sync.
- Input and output contracts for the two modules are in the header of each suite file.
- `.claude/EVALS.md` is the registry of every eval (existing and planned). It is kept current by hand, and the `evals-doc-in-sync` invariant fails if a suite or its case count is missing or stale.
- Each later step that ships code adds its own cases first (see the **Eval first** lines in Phase 1).
- Not built yet: model-graded evals (an LLM judging the writer's cards, agent behavior in the orchestrator). They need the model router (1.3), so they are added after it.
- **Done when:** `npm test` passes, `npm run eval` passes `invariants` and reports the other two suites as pending, and no suite can pass with zero cases.

**Gate 0:** app launches, tests and evals run, secrets are out of git, charter is written.

### Phase 1: Approval spine (days 3–7)

**1.1 Database schema** (one day) — status: **done**. Migrations written, **21 of 21 evals pass**, and applied to your Supabase project on Nov 23, 2026 (`npm run check:db`: all 11 tables exist)
- [x] Migrations in `supabase/migrations/`, split so each can be reviewed alone: `20261121000000_core_schema.sql` (the 11 tables, pgvector on `memory`), `20261121000100_row_level_security.sql` (who can see what) and `20261121000200_integrity_rules.sql` (rules that hold for everyone).
- [x] Seed in `supabase/seed.sql`: one fake client, project, pod and agent, all labelled `[seed]`. Dev only and not a migration, so it never reaches your project unless run on purpose.
- [x] Pod isolation model: the runtime uses the service key, which bypasses row-level security and is trusted. The renderer never touches the database. A pod-scoped client (step 3.2) connects as `authenticated` with a JWT carrying a `pod_id` claim, and every policy is keyed on it. A missing claim sees nothing, `anon` has no access at all, and `scaling_rules` is service-key only.
- [x] Rules enforced in the database, not only in code: pods can file requests but never approve them; the audit log is append-only even for the table owner; approved, rejected and cancelled decisions are frozen; a decision's card, action, category, pod and amounts cannot change after filing; a card must have all seven fields; decisions are never deleted. (Pods with audit entries cannot be deleted either: close them instead.)
- [x] Evals: the `database-schema` suite (21 cases) runs the migrations on a real in-process Postgres with `pgvector`, then attacks them as a pod agent, with no claim, as `anon`, as the runtime and as the table owner. Checked by mutation: 8 realistic mistakes introduced one at a time, all caught.
- [x] Apply tooling (decided Nov 21, 2026: a Supabase access token): `npm run db:migrate` (`scripts/db-migrate.js`) applies the migrations through Supabase's management API. `-- --dry-run` changes nothing. Applied migrations are recorded in `supabase_migrations.schema_migrations` (the table the Supabase CLI uses), each migration and its record in one request so they succeed or fail together. It refuses to run on a project whose public schema already has tables, refuses out-of-order migrations, talks only to `api.supabase.com`, and never prints the token. Tested on a real in-process Postgres (9 tests), including failure and atomicity.
- [x] **Applied to your Supabase project** on Nov 23, 2026: the dry run found the project healthy with 3 pending migrations, `npm run db:migrate` applied all three, and `npm run check:db` reports all 11 tables. The seed was not run on the real project. The access token can manage every project on your account, so delete it in the dashboard (and its `.env` line) now that the migrations are applied; create a new one for later migrations.
- **Done when:** the migrations apply to your Supabase project (`npm run check:db` reports all 11 tables), and the `database-schema` eval shows a query scoped to pod A cannot return pod B's rows. **Met** (locally for the isolation eval, and on the real project for the tables).

**1.2 Runtime skeleton and IPC** (half a day) — status: **done** (23 of 23 `runtime-core` evals, 8 integration tests, the real app driven end to end against the stand-in, and the runtime run against your real Supabase project on Nov 23, 2026)
- [x] Runtime in `src/runtime/` (never imports `electron`): `config.js` (validates settings, never prints values), `store/rest.js` (Supabase REST with the service key; strict table and column names, an update must have a filter), `audit.js` (the `audit_log` writer, redacts secrets by field name and by value shape), `runtime.js` (the command bus and events), `commands.js`, and `index.js` (`createApp`).
- [x] **No audit, no action.** The audit entry is written before a command's handler runs, and if it cannot be written the handler does not run. Errors returned to the UI are generic. Unknown commands and malformed or oversized arguments are refused first.
- [x] If the settings are missing, or the audit log cannot be written (wrong key, tables not applied, database down), the runtime **blocks itself**: it refuses actions with the reason and still answers `runtime.status`, so the window says what to fix instead of failing silently.
- [x] `window.api` (preload) is exactly `runtime.status`, `decisions.list`, `decisions.resolve`, `agents.pause` and `onEvent`. The renderer cannot reach `ipcRenderer`, `require` or `process`. One request channel (`runtime:invoke`) and one event channel (`runtime:event`); the bridge (`src/ipc.js`) accepts requests only from the app's own page and only well-formed `{ command, args }`. Two invariants enforce the shape of the preload.
- [x] `decisions.resolve` and `agents.pause` had their final argument rules but refused with "not built yet" and changed nothing: a half-built approval path is worse than none. `decisions.resolve` is now real (step 1.6, below); `agents.pause` still refuses until its step.
- [x] The window shows runtime status, database state and how many decisions are waiting, in plain language, with specific messages for missing tables, a rejected key, an unreachable database and missing settings.
- [x] `scripts/fake-supabase.js`: a local stand-in for Supabase's REST API (a real Postgres with your migrations behind the endpoints the runtime uses). It is how this step was verified without your tables, and it is a dev tool for later steps (`node scripts/fake-supabase.js`, then use the printed settings with `npm run dev`).
- Verified in the real app (`npm start`) against the stand-in: the renderer's calls get answers, the audit log holds `runtime.started`, every `decisions.list`, `decisions.resolve` and `agents.pause` call (recorded before it ran), and `runtime.stopped` on quit; rejected requests were not recorded because they never became actions. Before the migrations were applied, the app against your real project reported "tables are missing", blocked itself and wrote nothing.
- **Done when:** the renderer calls `window.api` and gets a response from the runtime, and the call appears in `audit_log`. **Met**, including on your real project (Nov 23, 2026): the runtime reported ready with the database ok, and `audit_log` holds `runtime.started`, `command.decisions.list` and `runtime.stopped`. (That run used the runtime directly, not the window.)
- Decisions made here that you may want to change: reads from the window (`decisions.list`) are audited like any action, which will flood the log if the queue page polls, so step 1.9 should update the queue from events instead; `.env` is read from the app folder, which works for development but a packaged app will need a settings location in the user's data folder (decide at packaging).

**1.3 Model router** (one and a half days; the Claude Code provider adds about half a day) — status: **done, on placeholder credentials** (Nov 24, 2026). Built: `src/runtime/router.js` (35-case `model-router` eval plus 9 unit tests), `src/runtime/providers/claude-code.js` (12-case eval plus 9 unit tests, and one live call checked), `groq.js`, `ollama.js` and `index.js` in the same folder (21-case `http-providers` eval), and the router is built in `createApp` and exposed as `app.router` (its audit entries go to `audit_log` as `model.call` and `model.result`, with no prompt or answer text). Groq is skipped until `GROQ_API_KEY` is set; `GROQ_MODEL` and `OLLAMA_MODEL` override the placeholder model names. A real run with no Groq key fell through Ollama (model not pulled) to Claude Code and answered. **Still to do by the founder:** add the real `GROQ_API_KEY` to `.env`, choose the real model names, and pull the Ollama model (`ollama pull <name>`); then run `npm run check:keys`. Judgment calls confirmed by the founder: a provider at its concurrency cap is skipped, not queued; a failed audit write stops the call; default caps are 20 steps, 50,000 tokens, 2 retries and a 500 ms base delay.
- Provider wrapper over Groq, local Ollama and Claude Code, in that order, with a fallback chain and retry with backoff. Providers are listed in configuration, so adding Gemini or OpenRouter later is a config change, not a code change (the router tests use a mocked provider list to prove it).
- Two tiers: cheap and fast for sorting and drafts, strongest for planning and anything reaching the founder.
- **Claude Code provider** (`src/runtime/providers/claude-code.js`): runs `claude -p` in the background for each call. Command recipe, tested on Claude Code 2.1.330 on Nov 21, 2026 (a call returned in about 2.7 seconds, model `claude-haiku-5-5`): `claude -p <prompt> --model haiku --effort low --tools "" --output-format json --no-session-persistence --setting-sources "" --disable-slash-commands --strict-mcp-config`.
  - Spawned without a shell, from an empty temporary folder outside the repo, so it cannot read project files, hooks or `CLAUDE.md`.
  - **Never `--bare`.** That mode forces `ANTHROPIC_API_KEY` authentication, which is per-token billing. The provider runs on the `claude` login already on the machine, and removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock and Vertex switches from the child's environment.
  - Reads the JSON result (`result`, `modelUsage`, `total_cost_usd`, `is_error`) and logs usage to `audit_log`. A non-JSON or error result counts as a failed call and falls through, never a crash.
  - Each call carries about 3.8k tokens of fixed overhead, so it is the last link in the chain, with a cap on concurrent calls (proposed: 2) so a Groq outage cannot start dozens of processes.
- Per-task caps on steps and tokens.
- A provider list that is plain configuration: each entry says its type, model, which tiers it may serve and whether it may see sensitive text. Hosted providers (Groq, Claude Code) are never allowed to see client secrets unless the founder says otherwise.
- **Done when:** tests with a mocked failing provider show the chain falling back through all three providers, a task over its cap is stopped, and the `claude-code-provider` eval suite passes.

**1.4 Policy check** (half a day) — status: **done** (Nov 23, 2026)
- [x] `src/runtime/policy.js`: `checkAction({ tool, access, args?, note? }) -> { allowed, category }`. A pure function, no model and no I/O. It never throws; anything malformed is refused as `unknown`.
- [x] **Deny by default.** A tool the file does not list is refused. The tools it knows live in one table (`RULES`) that a person edits in review: the always-ask tools by category (spend, people or contracts, launch or pricing, legal or public) and the routine ones (reads, drafts, bookkeeping entries, CRM updates, opening a pull request, preview deploys).
- [x] **Hard to talk past.** Only the tool name, its access tag and a few fixed fields of `args` are read, so free text (`note`, titles, bodies) cannot change the answer either way. An always-ask tool is refused whatever its tag says. A routine tool must carry exactly its listed tag. Names match exactly after trimming and lower-casing plain ASCII, so look-alike letters and zero-width characters never match. A deploy is routine only when its target is exactly `preview`; a missing or odd target counts as production.
- [x] Evals: `policy-check` now has 44 cases (32 original, 12 `edge-*` added first), all passing; `src/runtime/policy.test.js` (10 tests) sweeps every listed tool across tags, notes and args. Checked by mutation: 20 realistic mistakes introduced one at a time, 19 caught, and the 20th behaves identically.
- [x] **No code path can allow without the check:** the `policy-is-the-only-source-of-allow` invariant fails if any other file under `src/` builds an `allowed: true` answer, or if `policy.js` grants in more than one place.
- Nothing calls `checkAction` yet. The orchestrator (1.7) and the MCP loader (1.10) will; 1.10 must refuse to load any tool that has no built-in rule and no active rule from the founder (see the policy table follow-up under 1.6). An "unknown" refusal becomes a decision card in 1.6/1.7 so the founder sees it, rather than a silent drop.
- Judgment calls for you to confirm: every merge asks, not only a merge into `main`; a deploy is routine only with the exact target `preview`; bookkeeping entries are routine rather than spending. The tool names in `RULES` are the ones from the golden cases, so they are my guesses until 1.10 reads the real tool lists.
- **Done when:** every test passes, and no code path can mark an action allowed without the function returning allow. **Met.**

**1.5 Plain-language writer and checker** (one day) — status: **checker and loop done** (Nov 23, 2026); the model-written part waits for the router (1.3), as planned
- [x] **Checker** (`checkCard` in `src/runtime/cards.js`): plain code, no model. Rejects a missing or blank field (including a field of only invisible characters), a risk level other than exactly Low, Medium or High, technical words not explained in brackets, code or commands in founder-facing text, a cost without both ₹ and $ amounts, and a clock time without IST. It reports every problem at once, with the field and the offending words, in plain sentences the writer can act on. `details` ("Show details") is exempt from the jargon and code rules. It checks the text the founder will see (invisible characters removed, look-alike letters folded), never throws, and never changes the card.
- [x] **Writer-checker loop** (`produceCard`): asks a writer for a card, checks it, sends the draft back with the problems, and stops at the retry limit (default 3, never more than 5). A card that passes is returned as a clean copy with only the seven fields (and `details`); anything else the writer added is dropped. A card that fails the limit comes back as `flagged` **with no `card` property at all**, so it cannot be sent; the last draft is kept apart as `rejectedDraft`. A writer that crashes counts as a try, and its error text is never put in the result. The draft is snapshotted once, so what is checked is exactly what is shown.
- [x] **The writer's rules** (`writerInstructions`): the text a model will be given, generated from the checker's own lists so the two cannot drift. A test confirms the example in it passes the checker.
- [x] Evals: `decision-cards` is now 44 cases (15 original, 29 added first: 3 good, 18 bad, 8 loop), all passing; `src/runtime/cards.test.js` (26 tests) covers every jargon term, 15 ordinary sentences that must never be flagged, hostile input and the loop's promises. Checked by mutation: 36 realistic mistakes introduced one at a time; the first run missed 4, tests were added for each, and all 36 are now caught.
- **Not built yet, on purpose:** the writer itself (the model call). The loop takes it as a function, and step 1.7 connects it to the model router, using `writerInstructions()`. Grading what a real model writes is the model-graded eval planned after 1.3.
- Decisions made here, **three confirmed by the founder on Nov 23, 2026** (a bracketed explanation needs at least three words; times must be followed by IST; "free" must be written `₹0 ($0)`); the jargon list is a starting set of 56 words to tune against real cards (ordinary words such as `production` and `branch`, and names such as `ram`, are deliberately left off); a bracketed explanation needs at least three words; times must be followed by IST; "free" must be written `₹0 ($0)`. A card that is flagged needs a path to you (a plain "needs a human rewrite" note), which belongs to the decisions service (1.6).
- **Done when:** all bad cards are rejected, all good cards pass, and a card that fails the retry limit is flagged, never sent. **Met**, for the checker and the loop.

**1.6 Decisions service** (half a day) — status: **done** (Nov 23, 2026)
- [x] `src/runtime/decisions.js`: `createDecisionService({ store, audit, emit?, now?, isBlocked? })` gives `create`, `resolve`, `cancel`, `get` and `remindDue`, plus `startReminderJob` and `DecisionError`. It is built in `createApp` and exposed as `app.decisions` for the orchestrator (1.7) and the Telegram bot (1.8); it is `null` when the runtime is not configured. **It is for trusted code only: the agents' tools must never be handed `resolve`.**
- [x] **One answer takes effect.** Resolving is one atomic write, `update ... where id = ? and status = <the status it expects>`, so when the phone and the dashboard answer at once the database lets exactly one through. The other caller gets the real current status back with `changed: false`, and `conflict: true` only if it asked for something different from what is now final (the phone approved, the dashboard tried to reject). Approving the same thing twice is not an error. Approved, rejected and cancelled stay final, and the database triggers from step 1.1 remain as the backstop. "Ask for more" works only from pending; approving or rejecting works from pending or "asked for more".
- [x] **Nothing is auto-approved.** Only `resolve()` sets an answer, and it accepts only the founder's two channels (`dashboard`, `telegram`). Reminders only count; a deadline in the past only informs. The `only-the-decisions-service-answers-decisions` invariant fails if any other file writes a decision's status or resolution fields, or if a third channel is added.
- [x] **The caller cannot choose the category.** It comes from the policy check (1.4); an action the policy allows needs no decision ("not_needed"), and unknown options such as `category` or `status` are refused. The card must pass the checker (1.5) and the stored card is the checked, cleaned copy. A key or token pasted into a note, a cancel reason or any card field is removed before it is stored (notes reach agents when you ask for more, and card text reaches Telegram).
- [x] **No audit, no action.** Every write is preceded by its audit entry (`decision.created`, `decision.resolve`, `decision.cancel`, `decision.reminded`); if it cannot be written, nothing else is. Duplicate or conflicting answers are recorded as `decision.resolve_ignored`. A blocked runtime refuses every call, including direct ones.
- [x] **Reminders** (`remindDue`, `startReminderJob`): only `pending` cards are chased, each reminder is claimed with one atomic write on the reminder count (two runs at once remind once), and if the notification fails the claim is given back so the next run retries. Defaults: first reminder 4 hours after filing, then every 4 hours, at most 6, checked every minute. The job is built and tested but **not started anywhere yet**: it needs a notifier, which arrives with the Telegram bot (1.8) and the approval queue (1.9).
- [x] The `decisions.resolve` command (the dashboard path) now calls the service with the channel fixed to `dashboard`; the window cannot claim to be Telegram. The service also announces `decision.created`, `decision.resolved`, `decision.cancelled` and `decision.reminded` on the runtime's event stream (id and status only, never card text) for the live queue in 1.9.
- [x] Evals: the new `decisions-service` suite (32 cases) runs the service against a real Postgres with the real migrations, so the triggers are live and "two answers at once" is two real concurrent requests; `src/runtime/decisions.test.js` (19 tests, with delays injected between every step) and three end-to-end tests in `runtime.integration.test.js` back it up. The `runtime-core` case that asserted the 1.2 placeholder now checks the real wiring.
- Decisions, **confirmed by the founder on Nov 23, 2026**: a **reminder every 4 hours, at most 6**; "asked for more" cards are not reminded (the ball is with the agent, not you). **On unknown tools the founder changed my proposal:** a decision for an `unknown` tool is filed like any other so you can see that an agent tried something unrecognised, and approving it does not make the tool allowed; instead **the policy table must be editable from Telegram** so you can add the tool yourself. That is built (below). The judgment calls from step 1.4 (every merge asks; a deploy is routine only with the exact target `preview`; bookkeeping entries are routine) are still awaiting your word.
- **Done when:** a test resolves the same decision from two sources at once and only one write takes effect. **Met**, against a real Postgres (six rounds of phone and dashboard at once, plus approve against reject and a burst of ten).

**1.6 follow-up: the policy table is editable from Telegram** (asked for by the founder on Nov 23, 2026) — status: **backend built and verified; the Telegram commands are step 1.8; the migration is not applied to your real project yet**
- [x] **Two layers.** The built-in rules stay in code (`policy.js`) and cannot be changed from a phone. Tools you add live in a new table, `policy_tools` (migration `20261123000000_policy_tools.sql`, service key only), and are merged in. **A built-in rule always wins**: you cannot add, weaken or override a spend, hiring, launch or legal rule from Telegram, and a row planted straight into the database for a built-in tool is ignored.
- [x] **Adding "always ask me" (with a category)** takes effect at once, because it cannot loosen anything: an unknown tool already asks you, this only gives the card the right category. **Adding "routine, no need to ask me" (read or write)** loosens the rules, so it is only *proposed* until you confirm it, and it counts only when the tool's tag matches exactly. **Removing a tool is immediate** (it can only make things stricter). A rule is never edited: remove it and propose a new one.
- [x] `src/runtime/policy-tools.js` (`propose`, `confirm`, `cancel`, `remove`, `list`, `refresh`, and `policy`, the live check). It has the same habits as the decisions service: one atomic write per change (confirming from the phone and the dashboard at once takes effect once), the audit entry first, a blocked runtime refuses everything, notes stripped of pasted keys and never copied into the audit log or events. It is for the bot and the dashboard only; an invariant keeps every other module away from the table.
- [x] **Safe on failure.** The saved rules load at startup. If they cannot be read (for example the migration is not applied yet) the runtime still runs on the built-in rules and emits `policy.degraded`; a failed reload drops every custom rule rather than keeping stale ones. The decisions service now takes this live policy, so a tool you added gets its category instead of "unknown", and a confirmed routine tool needs no decision.
- [x] Evals: the new `policy-tools` suite (22 cases, real Postgres), 3 new `database-schema` cases for the table (24 total), 1 new invariant (13 total), 16 unit tests and 2 end-to-end tests. `check:db` now checks 12 tables.
- [x] **Bugs found and fixed after this was first built (Nov 23, 2026):** (1) the code that merges saved rules accepted a tool name with no dot, which the database refuses; it now enforces the same shape. (2) A failing lookup of your rules made every action "unknown", including harmless built-in reads; it now adds no extra rules and leaves the built-ins alone. (3) **A saved change was reported as an error when only the reload after it failed.** Now the change is reported as saved with `inEffect: false` (and a `policy.degraded` event), the policy stays on the safe side, and the next good reload brings it into effect; a write that itself fails is still an error. (4) **Your note reached the audit log on the dashboard path**, because the command bus recorded every argument. A command can now say which of its arguments are recorded (`auditArgs`); `decisions.resolve` records `hasNote`, not the text. (5) **`.env.example` had lost its `SUPABASE_ACCESS_TOKEN=` line** (restored). The `env-example-names-only` invariant now also fails if the code reads a setting that `.env.example` does not list, which would have caught it.
- [x] **Applied to your Supabase project** on Nov 24, 2026 (found when `/tools` on real Telegram replied "Something went wrong": the `policy_tools` table was missing). The dry run showed 3 migrations already applied and 1 pending; `npm run db:migrate` applied `20261123000000_policy_tools.sql`, and `npm run check:db` now reports all 12 tables. **Still to do by the founder:** delete the Supabase access token in the dashboard and remove its `.env` line, and restart the app so the saved rules load.
- [x] **Built in 1.8 (the bot), Nov 24, 2026:** the Telegram side. Written as evals first: `/tools` (list your additions), `/addtool <server.tool> ask <category>` (active at once), `/addtool <server.tool> routine <read|write>` (the bot replies with a plain-language card, "Let <tool> run without asking you? Yes / No", and only the Yes button confirms), `/removetool <server.tool>`; all from your chat ID only (a message from another chat does nothing), every one audited, and when an `unknown`-tool card arrives it offers "Add this tool" buttons. The bot calls this service and nothing else.

**1.7 Orchestrator graph** (one day, starting with a half-day spike)
- Spike: confirm LangGraph JS can pause for human approval and resume, and that `@langchain/mcp-adapters` loads a tool. Decide go or fall back before building more.
- Build the orchestrator graph: take a goal, create tasks, run the policy check on each action (the live one, `app.policyTools.policy`), create a decision card and pause when needed. **An approved decision for an `unknown` tool does not make the tool run**; the tool must first be added to the policy table (from Telegram), which is the founder's decision of Nov 23, 2026.
- **Done when:** a goal that includes a spend pauses the graph, and resolving the decision resumes it.

**1.8 Telegram bot** (half a day) — status: **built and tested with fakes; not yet tried against real Telegram** (Nov 24, 2026). Built in `src/runtime/telegram/`: `bot.js` (cards with Approve and Reject, taps through the decisions service as `via: 'telegram'`, `/tools`, `/addtool`, `/removetool`, a Yes tap before anything loosens the rules, "Add this tool" buttons on unknown-tool cards, founder-only by chat id and sender id with no reply to anyone else), `api.js` (the token never appears in an error), `poller.js` (long poll, backoff, an update is never handled twice) and `index.js` (starts with the runtime when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_FOUNDER_CHAT_ID` are set; pushes each `decision.created` card; starts the reminder job). Checked by the 54-case `telegram-bot` eval and 12 unit tests. First real-Telegram try (Nov 24, 2026): `/tools` replied "Something went wrong" because the `policy_tools` table was not applied yet; the migration is now applied, and the bot says what to do for a missing table, an unreachable database or a rejected key (the store's own message is never shown). Code review of Nov 24, 2026 found 10 points; 7 are fixed (a restart skips the backlog so it cannot replay an old tap; `stop()` really stops and `start()` runs one loop; an outcome is never reported as "nothing was changed" when only the message edit failed; odd tool names are refused; failed commands reach `onError`; failed card pushes are retried and cards already waiting are pushed on start; a wrong `TELEGRAM_FOUNDER_CHAT_ID` is reported as `telegram.problem`, and a group chat id is refused). **Left open:** a rate limit (429) or a second poller (409) is still retried blindly, one slow handler holds up later taps, and the "Add this tool" card does not change after you choose. `/brief`, `/status` and `/pause` answer "not available yet" until the orchestrator and agent controls exist. **To do:** put the real token and your chat id in `.env` (`npm run check:keys -- --find-telegram-chat` finds the id), then send yourself a test card and tap it to meet the "done when" below on the real service.
- Push cards with Approve and Reject buttons. Add `/brief`, `/status <team>` and `/pause <agent>`.
- Accept only the founder's chat ID.
- **Policy table commands** (decided Nov 23, 2026; the backend is built, see the 1.6 follow-up): `/tools`, `/addtool`, `/removetool`, and "Add this tool" buttons on `unknown`-tool cards. Loosening needs a confirm tap; everything is audited.
- **Done when:** a card arrives on the phone, a tap resolves it through the decisions service, and a message from another chat is ignored.

**1.9 Approval queue screen** (half a day)
- First renderer page: list of cards in the 7-field format, Approve / Reject / Ask-more buttons, "Show details" toggle.
- Updates live when the bot or an agent changes a decision.
- **Done when:** a card approved on the phone disappears from the queue without a refresh.

**1.10 MCP loader and first tools** (half a day)
- Read `shared.yaml` plus a team YAML, tag every tool read or write, and route write tools that spend, send, deploy or sign through the policy check. Refuse to load a tool that has neither a built-in rule nor an active rule from the founder (`app.policyTools`).
- First servers: Filesystem (limited to the project folder), GitHub, Fetch, Supabase (read-only for most agents).
- Write the shared skills: plain-language-approval, escalation-rules, handoff-notes.
- **Done when:** an agent can read a file inside its folder, is refused outside it, and a tagged write tool pauses for a decision.

**1.11 Phase 1 gate test** (half a day)
- Script the gate scenario so it can be re-run.

**Gate 1:** a fake agent proposes a spend, a plain-language card reaches Telegram and the dashboard, one approval unblocks it, and `audit_log` records every step.

### Phase 2: Client-facing teams (days 8–14)

**2.1 Team lead and worker framework** (one day)
- A generic agent factory: loads `shared` plus the team's MCP config and skills, and runs under the step and token caps.
- Lead plans the team's work and checks each worker's output before a task is marked done.
- **Done when:** a test team of one lead and one worker completes a task, and the lead rejects a bad worker output once.

**2.2 Outbound review agent** (half a day)
- Every outbound client message goes through a review agent first.
- A setting makes the founder approve every outbound message for the first 2 weeks.
- **Done when:** a drafted email cannot be sent without passing review, and the setting forces a decision card.

**2.3 Marketing and Sales team** (two days)
- Tools: Gmail and Drive, HubSpot, one search tool (Exa, Firecrawl or Brave).
- Skills: ideal-client-profile, cold-outreach, proposal-writing, seo-content, brand-voice.
- Workflow: research a lead, store it in the CRM, draft a proposal, send it for approval.
- **Done when:** one real lead goes from research to a drafted proposal to a founder approval card.

**2.4 Customer Support team** (one and a half days)
- Tools: Gmail. Skills: ticket-triage, reply-tone, refund-and-complaint escalation, client-onboarding.
- Workflow: read a ticket, answer routine ones, escalate refunds and complaints as decision cards.
- **Done when:** a routine ticket is answered, and a refund request becomes a card.

**2.5 Teams page and task board** (one day)
- Renderer page showing each team's status, open tasks and blocked tasks.
- **Done when:** the page matches `tasks` and `agents` data within a few seconds of a change.

**2.6 Daily brief and morning digest** (one day)
- Brief covers revenue, leads, tickets, deployments and spend requests. The bot sends a digest at a fixed IST time and answers `/brief`.
- **Done when:** the digest arrives on schedule and matches the dashboard brief.

**2.7 Phase 2 gate test** (half a day)

**Gate 2:** a lead goes from research to a drafted proposal to founder approval, and a support ticket is answered or escalated correctly.

### Phase 3: Engineering, Finance and pods (days 15–21)

**3.1 Pod creation** (one day)
- Create a pod from an agency-client or SaaS template. Fill `pods` and `pod_members`. Creating a pod produces a decision card.
- **Done when:** approving a card creates a pod with its folder, git repo and memory space.

**3.2 Pod isolation** (one day)
- Scope file and git tools to the pod's folder in the tool layer. Namespace memory per pod. Check row-level security on every pod table.
- **Done when:** tests show an agent in pod A cannot read pod B's files, repo, memory or client data.

**3.3 Engineering team** (one and a half days)
- Tools: GitHub (pull requests only, never a merge to production), Playwright, Context7.
- Skills: git-workflow, code-review, testing, deploy-checklist.
- **Done when:** an agent opens a pull request in a pod repo, and a production deploy attempt becomes a decision card.

**3.4 Finance, Legal and Ops team** (one and a half days)
- Tools: Razorpay and Zoho Books. Agents hold no payment credentials, and any spend request becomes a decision card.
- Skills: invoice-with-GST, expense-recording, contract-review, data-privacy-check.
- **Done when:** an invoice draft is produced, and a payment request becomes a card instead of running.

**3.5 Priority and shared specialists** (half a day)
- Priority P1–P3 per project. Shared specialists serve the higher priority first, and the daily brief notes any conflict.
- **Done when:** a test with two pods needing the same specialist serves P1 first.

**3.6 Project view: files panel** (one day)
- File tree and history read from the pod's git repo. The founder can open, edit and upload. Saving creates an event that tells agents to reload.
- A file being edited by the founder is locked for agents until saved.
- **Done when:** an edit is committed with history, and an agent write to a locked file is refused.

**3.7 Project view: agents panel and live feed** (one day)
- Agent list with role, status and current task, plus pause, message and reassign. Clicking an agent shows each step from `agent_events`, pushed through main to the renderer.
- The founder can type an instruction straight to that agent. All controls are written to `audit_log`.
- **Done when:** a step an agent takes appears in the feed within a second or two, and a typed instruction reaches the agent.

**3.8 Phase 3 gate test** (half a day)

**Gate 3:** a pod is created, an agent opens a PR, and an invoice draft is produced, all isolated per pod.

### Phase 4: Scale and go live (days 22–28)

**4.1 Autoscaling** (one and a half days)
- Add an agent of a role when its queue size or wait time passes the threshold. Remove idle agents. Close a pod when its project ends.
- A new agent that would pass the cap produces a decision card instead.
- **Done when:** a load test adds agents up to the cap, then produces a card, then scales back down.

**4.2 Guardrails** (one day)
- Enforce max steps, max tokens, a daily task cap per agent, and loop detection. Add kill switches per agent and per team.
- **Done when:** a looping fake agent is stopped by the caps, and `/pause` stops an agent mid-task.

**4.3 Audit log and Settings pages** (one day)
- Audit log: every agent action, searchable. Settings: rules, approval limits, kill switches, agent cap.
- **Done when:** any action from the gate tests can be found by search, and changing a limit takes effect without a restart.

**4.4 Tray and background running** (half a day) — **in v1** (decided Nov 21, 2026); built here because it only matters once the runtime and bot exist
- Closing the window hides to the tray, with a start-at-login option. Confirm `src/runtime/` still has no `electron` imports so it can go headless later.
- **Done when:** with the window closed, a Telegram approval still resolves.

**4.5 Deploy tools and error reports** (one day)
- Vercel or Cloudflare deploy tools, with production deploys always going through a decision card. Sentry for live products.
- **Done when:** a preview deploy runs unattended, and a production deploy waits for approval.

**4.6 Compliance and provider review** (half a day)
- Check the data-training terms of each provider in use (Groq and Claude Code in v1, plus any added later) and Anthropic's terms for running Claude Code unattended and route sensitive text to local Ollama or not at all. List the items for a CA and a lawyer (the company is currently a sole proprietorship, so ask whether to register a company before taking on global clients, because contracts are then the founder's personal liability; GST for exports, DPDP, GDPR, client contracts stating AI use, FIRC/FIRA).
- **Done when:** a routing rule keeps client secrets off free providers, and the compliance list is handed to the founder.

**4.7 Mock project week** (two days)
- Run an end-to-end mock project across all four teams, and review the audit log for any write action that skipped the policy check.
- **Done when:** the review finds none.

**Gate 4:** a week of an end-to-end mock project in which no unapproved write action is possible.

## Risks

| Risk | Level | Mitigation |
|---|---|---|
| Bot and agents only run while the Electron app runs | High | v1: close hides to tray, start at login. Later: run `src/runtime` headless on a VPS. |
| Free-tier rate limits cap the agent count | High | Set the cap from measured limits, with a fallback chain. With Gemini and OpenRouter deferred, the only hosted provider is Groq, so the fallbacks are local Ollama, then Claude Code (Haiku, low effort); if both are unavailable, Groq's limits are a hard ceiling. |
| Claude Code fallback is misconfigured and bills per token, or runs with access to the repo | High | Never use `--bare`; strip the API-key variables from the child; empty working folder, no tools, no settings or skills. All checked by the `claude-code-provider` evals. |
| Unattended use of Claude Code breaks Anthropic's terms or eats the founder's own usage limits | Medium | Check the terms before enabling it (open decision); keep it last in the chain with a concurrency cap; if unattended use on a personal login is not allowed, switch to an API key, which is paid usage and needs a founder-approved budget. |
| Policy check bypassed or too loose | High | Plain code, deny by default, a test per category, agents hold no payment credentials |
| Cross-pod data leak | High | Per-pod folder and repo scoping in the tool layer, row-level security in Supabase |
| Plain-language checker misses jargon or blocks too many cards | Medium | Fixed test set, technical detail behind "Show details" |
| LangGraph JS and JS MCP adapters have fewer examples than Python | Medium | Spike in Phase 1 before building on them |
| 4 weeks is tight | Medium | Cut in this order: WhatsApp, Stripe, Figma and Linear, project view editing |
| Free providers may train on data | Medium | Never send client secrets to them; use local Ollama for sensitive text |
| Legal and compliance gaps (DPDP, GDPR, GST, FIRC/FIRA) | Medium | Confirm with a CA and a lawyer. Not resolved by the build. |

**Complexity: High.** About 4 weeks for one developer; Phase 1 carries most of the risk.

## Open decisions

- [x] Renderer: React via `electron-vite` (decided Nov 21, 2026; implemented in step 0.2)
- [x] Gemini and OpenRouter: not used in v1, to be added later (decided Nov 21, 2026). v1 uses Groq, with local Ollama as the fallback.
- [x] Is Ollama installed locally? Yes: running on `localhost:11434` with 11 models (checked Nov 21, 2026), so v1 has a fallback provider.
- [ ] The GitHub repo `Vansh1419/sfactory` is **public** and holds the business blueprint, plan and charter. Recommended: make it private (`gh repo edit Vansh1419/sfactory --visibility private --accept-visibility-change-consequences`). Content already pushed may already have been copied or cached, so treat it as seen. The first commit's author email is a company address; to use a different one for future commits, set `git config user.email`.
- [ ] Memory embeddings: the `memory.embedding` column is `vector(768)`, which fits common local embedding models such as `nomic-embed-text`. No embedding model is installed in your Ollama today (the list has chat and vision models only), and Gemini embeddings are deferred. Decide the model before real memory data goes in, because changing the dimension later is a migration.
- [ ] Pod-scoped database access (step 3.2): the isolation rules assume a JWT with a `pod_id` claim that the runtime mints per pod. Confirm how your Supabase project signs JWTs (its JWT secret, or the newer signing keys) before building 3.2. Until then the runtime's service key is the only database client, and the rules are defence in depth.
- [x] Third fallback: Claude Code running in the background with Haiku at low effort (decided Nov 21, 2026; step 1.3). Feasibility checked: it works on the existing login with no API key set.
- [ ] Which tiers may the Claude Code fallback serve? Proposed: the cheap tier always; the strong tier (planning, anything reaching the founder) only as a last resort, and only if the result still passes the card checker.
- [ ] Is it allowed to run Claude Code unattended from this app on your own login? Check Anthropic's current terms and usage limits before enabling it. It shares your limits with your own sessions. If it is not allowed, the alternative is an API key, which is paid usage and counts as spend.
- [ ] When the runtime later moves to a server, `claude` must be installed and logged in there too. Decide whether the Claude Code fallback is enabled on the server.
- [ ] Which Ollama model is the fallback, and which is allowed for sensitive text? Only models that run on this machine count as local: `kimi-k2.7-code:cloud` and `glm-5:cloud` carry the `:cloud` tag, which normally means Ollama forwards the request to a remote service. The router must not treat them as private, so step 1.3 should keep a list of models allowed for sensitive text. Candidates already installed and local: `qwen3.5:27b`, `qwen3.5:latest`, `llama3:latest`, `mistral:latest`, `deepseek-r1:32b`.
- [x] Tray and start-at-login in v1 (decided Nov 21, 2026: included; built in step 4.4)
- [x] Company name and legal entity type: sfactory (working name), sole proprietorship (decided Nov 21, 2026).
- [x] Agency services: all four, with one pilot project in each (web development, AI automation, marketing, content). **Schedule consequence:** the web development and AI automation pilots need the Engineering team, which arrives in Phase 3 (week 3), so those two cannot start before then. The marketing and content pilots can run in Phase 2 on the Marketing & Sales team. Running four pilots in the 4-week window is ambitious; if time slips, drop pilots from the end of the list, not the approval and safety work.
- [ ] First SaaS idea and its customer: not decided. The charter tells agents not to start one until you name it.
- [ ] Telegram only (assumed) or WhatsApp from day one?
- [ ] Agent cap in total and per pod, and the scale-up threshold?
- [ ] Max projects running at once in v1?
- [ ] Client calls and meetings: human-only or AI-assisted?
- [ ] Which paid model gets priority when budget appears?

## Acceptance

- [ ] Each phase gate passes before the next phase starts
- [ ] No write tool that spends, sends externally, deploys or signs runs without a founder approval
- [ ] Renderer security settings and CSP are unchanged
- [ ] `src/runtime/` has no `electron` imports
- [ ] `CLAUDE.md` matches the new structure and commands
