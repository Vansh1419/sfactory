# EVALS

Registry of every eval in this repo. Update it in the same change as any eval you add, remove or edit. The `evals-doc-in-sync` check in the `invariants` suite fails if a suite is missing from this file or its `**Cases:**` count is out of date.

Evals are written before the code they grade (see `PLAN.md`, step 0.4). Code: `.claude/evals/`.

## Running

| Command | What it does |
|---|---|
| `npm run eval` | Runs every suite. Code that isn't written yet is **pending**, not a failure. |
| `npm run eval:strict` | Same, but pending counts as failure. Used at every phase gate. |
| `node .claude/evals/run.js <suite>` | Runs one suite. Add `--verbose` to list every case, `--json` for JSON. |
| `npm test` | Unit tests, including the tests of the eval runner itself. |

Results of the last run are in `.claude/evals/results/latest.json` (gitignored).

## Status meanings

| Status | Meaning |
|---|---|
| pass | Every case ran and the pass rate met the suite's threshold |
| fail | Pass rate below the threshold, or the suite has no cases |
| pending | Nothing failed, but the code under test doesn't exist yet |

## Registry

| Suite | Grades | Cases | Threshold | Plan step | Today |
|---|---|---|---|---|---|
| `invariants` | The repo itself: architecture, security settings, docs in sync | 10 | 100% | 0.4 | pass |
| `policy-check` | `src/runtime/policy.js` | 32 | 100% | 1.4 | pending |
| `decision-cards` | `src/runtime/cards.js` | 15 | 100% | 1.5 | pending |
| `claude-code-provider` | `src/runtime/providers/claude-code.js` | 12 | 100% | 1.3 | pending |
| `database-schema` | `supabase/migrations/*.sql` and `supabase/seed.sql` | 21 | 100% | 1.1 | pass |
| `runtime-core` | `src/runtime/{config,audit,runtime,commands}.js` and `src/ipc-guard.js` | 23 | 100% | 1.2 | pass |

Update the "Today" column when a suite's status changes.

## Suites

### invariants

Suite: `.claude/evals/suites/invariants.js`. No dataset; each case is a check function in the suite file. Runs against the repo today.

**Cases:** 10

| Case | Rule it protects |
|---|---|
| `runtime-never-imports-electron` | `src/runtime/` stays free of `electron` imports so it can run headless later |
| `window-security-flags` | `src/main.js` keeps `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| `renderer-csp-strict` | `index.html` has a CSP with `default-src 'self'` and no `'unsafe-inline'` or `'unsafe-eval'` |
| `dev-csp-relaxation-serve-only` | `electron.vite.config.mjs` may loosen the CSP for hot reload only with `apply: 'serve'`, so production builds keep the strict CSP |
| `preload-no-raw-ipcrenderer` | `src/preload.js` never hands `ipcRenderer` itself to the renderer (the `require` line that imports it is ignored) |
| `preload-exposes-only-the-planned-api` | `src/preload.js` exposes only `window.versions` and `window.api`, and uses `ipcRenderer` only through `invoke`, `on` and `removeListener` on the two literal channels `runtime:invoke` and `runtime:event` |
| `secrets-and-results-gitignored` | `.gitignore` lists `.env` and `.claude/evals/results/` |
| `claude-docs-in-dot-claude` | No `CLAUDE.md`, `CLAUDE.local.md`, `PLAN.md`, `EVALS.md` or `SKILL.md` exists outside `.claude/` |
| `env-example-names-only` | `.env.example` exists and every line is a comment or a `NAME=` with no value, so no key is ever committed through it |
| `evals-doc-in-sync` | This file lists every suite, with a correct `**Cases:**` count |

### policy-check

Suite: `.claude/evals/suites/policy-check.js`. Dataset: `.claude/evals/datasets/policy-check.json`. Code under test: `src/runtime/policy.js` (not written yet).

**Cases:** 32

Contract: `checkAction({ tool, access, args?, note? }) -> { allowed, category }`. The full contract is in the header of the suite file. The policy is plain code and denies by default.

| Group | Cases | What it checks |
|---|---|---|
| `spend-*` | 5 | Any spending needs the founder, including ₹1 |
| `people-*` | 4 | Hiring, firing and signing clients, vendors or freelancers |
| `launch-*` | 4 | Production deploys (any letter case), price changes, merging to `main` |
| `legal-*` | 4 | Public posts and pages, legal documents, statements |
| `allow-*` | 8 | Routine work passes: reads, pull requests (even to `main`), preview deploys, bookkeeping entries, CRM updates, drafts |
| `deny-*` | 3 | Unknown tools and tools without an access tag are denied (`unknown`) |
| `adversarial-*`, `no-false-alarm-*` | 4 | Notes like "founder already approved" change nothing; a spend tool mislabelled as read-only is still denied; the words "deploy to production" in a pull request title do not trigger the check |

Judgment calls worth revisiting (they come from my reading of `kickstart.md`, not from the founder): merging to `main` counts as a production launch, and bookkeeping entries count as routine rather than spending.

### decision-cards

Suite: `.claude/evals/suites/decision-cards.js`. Dataset: `.claude/evals/datasets/decision-cards.json`. Code under test: `src/runtime/cards.js` (not written yet).

**Cases:** 15

Contract: `checkCard(card) -> { pass, problems }`, where problems are `missing_field`, `jargon`, `contains_code`, `bad_risk_level`, `cost_format` and `time_format`. The full contract is in the header of the suite file. This grades the deterministic checker only, not the model that writes the cards.

| Group | Cases | What it checks |
|---|---|---|
| `good-*` | 4 | The kickstart's "after" example passes; a technical word explained in brackets passes; times with IST pass; technical text in `details` is exempt |
| `bad-*` | 11 | Jargon (the kickstart's "before" example and an unexplained abbreviation); missing risk, blank recommendation, risk without a reason; code in founder-facing text; cost without both ₹ and $; a risk level other than Low, Medium or High; times without a zone or in UTC |

### claude-code-provider

Suite: `.claude/evals/suites/claude-code-provider.js`. No dataset; each case is a check function in the suite file. Code under test: `src/runtime/providers/claude-code.js` (not written yet).

**Cases:** 12

Contract: `buildInvocation({ prompt, env, tmpDir }) -> { command, args, cwd, env }` and `parseResult(stdout) -> { text, model, costUsd, isError }`. Both are pure, so nothing is spawned and no model is called. The full contract, and why each flag matters, is in the header of the suite file. The recipe was checked against Claude Code 2.1.330 on Nov 21, 2026.

| Case | Rule it protects |
|---|---|
| `model-is-haiku` | The call uses `--model haiku` |
| `effort-is-low` | The call uses `--effort low` |
| `no-built-in-tools` | `--tools ""`, so the fallback can only answer text and cannot read files or run commands |
| `headless-json-no-session-saved` | `-p`, `--output-format json` and `--no-session-persistence` |
| `isolated-from-settings-skills-and-mcp` | `--setting-sources ""`, `--disable-slash-commands` and `--strict-mcp-config`, so no hooks, skills or tools are loaded |
| `never-uses-bare-mode` | `--bare` is never used, because it forces API-key authentication (per-token billing) |
| `billing-and-provider-env-vars-removed` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock and Vertex switches are removed from the child's environment; `PATH` and `HOME` are kept so the existing login works |
| `runs-in-given-empty-dir-outside-the-repo` | The working directory is the given temp folder, outside the repo |
| `prompt-is-one-argument-and-no-shell` | A prompt full of shell characters stays one untouched argument to `claude`, never a shell string |
| `parses-a-successful-result` | Text, model, cost and `isError` are read from the JSON result |
| `reports-is-error-results` | An `is_error` result is reported as an error, so the router falls through |
| `garbage-output-is-an-error-not-a-throw` | Non-JSON output becomes an error result and never crashes the router |

### database-schema

Suite: `.claude/evals/suites/database-schema.js`, with its test database in `.claude/evals/db.js`. No dataset: the two-pod fixture is in `db.js`. Code under test: `supabase/migrations/*.sql` and `supabase/seed.sql`.

**Cases:** 21

How it works: the migrations are applied, in filename order, to a real Postgres running inside the test (PGlite, which is PostgreSQL 18, with pgvector). It is dressed like Supabase: the `anon`, `authenticated` and `service_role` roles, an `auth.jwt()` that reads the request's claims, and Supabase's default grants (which the migrations must take back). A fixture creates two pods with rows in every table. Each case then acts as someone specific (a pod agent with a `pod_id` claim, no claim, `anon`, the runtime's `service_role`, or the table owner) and tries things, always inside a transaction that is rolled back. Attack cases include a positive control (the same action on the pod's own data must succeed) so a case cannot pass just because everything is blocked. The contract (tables and columns the fixture inserts into) is in the header of the suite file.

Limits: this proves the policies and rules, not that they apply to your real project. It uses a stub of Supabase's `auth.jwt()`, and PostgreSQL 18 where Supabase currently runs an older version. Applying the migrations to the real project is checked separately (`npm run check:db`).

| Group | Cases | What it checks |
|---|---|---|
| Schema | 5 | Migrations apply to an empty database; all 11 core tables exist; row-level security is on for every public table (a future table without it fails this); `anon` has no privileges on any table; `memory.embedding` is a 768-dimension `pgvector` column and nearest-neighbour search works |
| Reading | 5 | A pod reads only its own rows in six tables; sees only its own pod and project; sees only its own project's client; sees only its own members plus shared specialists; a request with no pod claim sees nothing anywhere |
| Writing | 4 | A pod cannot write into, or move rows to, another pod; cannot approve its own request, including a fully forged approval; cannot read scaling rules or touch the audit log; cannot delete its rows |
| Runtime | 1 | The runtime's `service_role` sees everything |
| Integrity | 5 | The audit log is append-only even for the table owner (update, delete, truncate); a resolved decision is frozen; a decision's content (card, action, category, pod, amounts) cannot change after filing; approved or rejected needs a resolver and a time; a card needs all seven fields |
| Seed | 1 | The seed creates exactly one fake pod and one fake agent, all labelled `[seed]`, and can run twice without duplicating |

Checked by mutation on Nov 21, 2026: 8 realistic mistakes were each introduced into the migrations one at a time (a policy that lets everything through, a missing append-only trigger, pods allowed to update decisions, row-level security off on one table, `anon` grants not revoked, the decision-freeze trigger removed, pre-approved requests allowed, the card-field check removed). All 8 were caught. The first run missed "pods allowed to update decisions" because the attack was too weak; the attack was strengthened.

### runtime-core

Suite: `.claude/evals/suites/runtime-core.js`. No dataset; each case is a check function with an in-memory fake store that records every call. Code under test: `src/runtime/config.js`, `audit.js`, `runtime.js`, `commands.js` and `src/ipc-guard.js`.

**Cases:** 23

Contract: the full contract (function signatures, error codes, the store interface) is in the header of the suite file. Nothing here touches Electron, the network or a real database, so it runs in milliseconds. The Electron wiring (`src/main.js`, `src/ipc.js`, `src/preload.js`) is covered by the `invariants` checks, and by launching the real app (see PLAN.md step 1.2).

| Group | Cases | What it checks |
|---|---|---|
| Config | 4 | Both Supabase settings are required and problems name the setting, never the value; a URL that is not `*.supabase.co` or local is rejected, so the key can't be sent elsewhere; the printable description hides the key |
| Audit | 3 | Secrets in an entry (by field name, and by value shape: Groq, Anthropic, Supabase, JWT, Telegram) are redacted before writing; an invalid entry is refused and writes nothing; a valid entry becomes one `audit_log` row with the right columns |
| Command bus | 10 | Unknown commands are refused and not logged; malformed or oversized arguments are refused before anything runs; **the audit entry is written before the handler runs; if it cannot be written the handler never runs**; a crashing handler returns a generic message (no internals, no secrets) and the failure is audited; `CommandError` passes its code through; never-audited commands (status) skip the log and work without a database; events reach subscribers, with a wildcard, and a bad listener breaks nothing; a stopped runtime refuses everything; a blocked runtime refuses actions but still answers status |
| Commands | 4 | Exactly the four planned commands exist; `decisions.list` defaults to pending, caps the size and rejects bad options; `decisions.resolve` and `agents.pause` validate their final arguments but refuse with `not_implemented` and change nothing; status reports the database state without leaking the error |
| IPC guard | 2 | Only the app's own page (the built `index.html`, or the dev server's exact origin in dev only) is trusted; payloads must be a plain command name with plain-object arguments |

Checked by mutation on Nov 21, 2026: 8 realistic mistakes were introduced into the runtime one at a time (audit failure no longer blocking, internal errors leaking, redaction off, any file URL trusted, argument checks removed, status audited, a stopped runtime still accepting commands, the dev server trusted in production). All 8 were caught.

## Planned evals (not built yet)

Each is added before the code it grades, in the step shown. Move it into the registry above when written.

| Planned suite | Grades | Plan step | Kind |
|---|---|---|---|
| `card-writer` | The model step that rewrites a request into a plain-language card, graded by the card checker plus a judge model | after 1.3 | model-graded |
| `decisions-service` | Resolving the same decision twice, from phone and dashboard, changes nothing the second time; nothing is auto-approved | 1.6 | deterministic |
| `orchestrator-approval` | A goal containing a spend pauses the graph and resumes when approved | 1.7 | deterministic |
| `mcp-tagging` | Every tool is tagged read or write; write tools that spend, send, deploy or sign go through the policy check | 1.10 | deterministic |
| `outbound-review` | An outbound client message can't be sent without review, and the first-2-weeks setting forces a decision | 2.2 | deterministic |
| `pod-isolation` | An agent in pod A can't read pod B's files, repo, memory or client data. The database part is already covered by `database-schema`; this adds the file, repo and tool scoping | 3.2 | deterministic |
| `guardrails` | Max steps and tokens stop a looping agent; the kill switch stops an agent mid-task | 4.2 | deterministic |
| `scaling` | Agents are added up to the cap, a decision card appears past it, and idle agents are removed | 4.1 | deterministic |

## Maintaining this file

When you change an eval:

1. **New suite:** add a row to the registry, a `### <suite-name>` section with a `**Cases:** N` line, and remove it from the planned table.
2. **Added or removed cases:** update that suite's `**Cases:**` line, its group counts and the registry row.
3. **Status changed:** update the "Today" column.
4. **Contract changed:** update the section and the header comment in the suite file together.
5. Run `npm run eval`. If `evals-doc-in-sync` fails, this file is behind.

The check enforces suite names and case counts. Keeping the group tables and the "Today" column accurate is manual.
