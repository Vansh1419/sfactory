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

A case that has not finished after 60 seconds **fails** with "timed out". Before this (found on Nov 24, 2026 while checking the `/goal` cases) a case that never settled made the runner exit with status 0 and print nothing, which a script reads as a pass.

## Status meanings

| Status | Meaning |
|---|---|
| pass | Every case ran and the pass rate met the suite's threshold |
| fail | Pass rate below the threshold, or the suite has no cases |
| pending | Nothing failed, but the code under test doesn't exist yet |

## Registry

| Suite | Grades | Cases | Threshold | Plan step | Today |
|---|---|---|---|---|---|
| `invariants` | The repo itself: architecture, security settings, docs in sync | 16 | 100% | 0.4 | pass |
| `policy-check` | `src/runtime/policy.js` | 51 | 100% | 1.4 | pass |
| `decision-cards` | `src/runtime/cards.js` | 52 | 100% | 1.5 | pass |
| `claude-code-provider` | `src/runtime/providers/claude-code.js` | 12 | 100% | 1.3 | pass |
| `model-router` | `src/runtime/router.js` | 35 | 100% | 1.3 | pass |
| `http-providers` | `src/runtime/providers/{groq,ollama,index}.js` | 21 | 100% | 1.3 | pass |
| `telegram-bot` | `src/runtime/telegram/{bot,api,poller}.js` | 81 | 100% | 1.8 | pass |
| `database-schema` | `supabase/migrations/*.sql` and `supabase/seed.sql` | 38 | 100% | 1.1 | pass |
| `graph-checkpointer` | `src/runtime/orchestrator/checkpointer.js`, against a real Postgres with the migrations | 20 | 100% | 1.7b | pass |
| `orchestrator` | `src/runtime/orchestrator/graph.js`, with the real policy and a real checkpoint store in one case | 57 | 100% | 1.7c | pass |
| `orchestrator-service` | `src/runtime/orchestrator/service.js`, against the real audit log and checkpoint store on a real Postgres | 33 | 100% | 1.7d | pass |
| `orchestrator-model` | `src/runtime/orchestrator/model.js` (the model-written planner and card writer), with a scripted router | 26 | 100% | 1.7e | pass |
| `approval-queue` | `src/renderer/queue.mjs` (the logic behind the approval queue screen) | 28 | 100% | 1.9 | pass |
| `tool-loader` | `src/runtime/tools/{index,builtin,files}.js` | 30 | 100% | 1.10 (loader) | pass |
| `zip-file` | `src/renderer/zip.mjs` (the .zip the Download button makes) | 9 | 100% | 1.10 follow-up | pass |
| `filesystem-tools` | `src/runtime/tools/filesystem.js` (read a file or list a folder inside the project folder) | 21 | 100% | 1.10 (Filesystem) | pass |
| `tool-config` | `src/runtime/tools/config.js` (shared.yaml plus a team file) | 19 | 100% | 1.10 (config) | pass |
| `fetch-tool` | `src/runtime/tools/fetch.js` (read a public web page) | 17 | 100% | 1.10 (Fetch) | pass |
| `github-tools` | `src/runtime/tools/github.js` (read a file, list, open and merge pull requests) | 15 | 100% | 1.10 (GitHub) | pass |
| `supabase-tool` | `src/runtime/tools/supabase.js` (read-only rows from a few tables) | 13 | 100% | 1.10 (Supabase) | pass |
| `tool-gate` | the step 1.10 "done when", end to end with the real policy, loader, filesystem and GitHub tools and graph | 9 | 100% | 1.10 (gate) | pass |
| `shared-skills` | `.claude/skills/shared/{plain-language-approval,escalation-rules,handoff-notes}/SKILL.md` | 9 | 100% | 1.10 (skills) | pass |
| `phase1-gate` | `scripts/gate1.js` (Gate 1, also run by hand with `npm run gate:1`) | 3 | 100% | 1.11 | pass |
| `phase2-gate` | `scripts/gate2.js` (Gate 2, also run by hand with `npm run gate:2`) | 3 | 100% | 2.7 | pass |
| `phase3-gate` | `scripts/gate3.js` (Gate 3, also run by hand with `npm run gate:3`) | 3 | 100% | 3.8 | pass |
| `team-tasks` | `teams/jobs.js` (`startFinance`, `startEngineer`), the `teams.startFinance` and `teams.startEngineer` commands, the bot's `/finance` and `/engineer`, and the Teams page's two forms | 9 | 100% | 3.3/3.4 follow-up | pass |
| `task-resume` | `src/runtime/teams/resume.js`, `resume` in the two teams and `resumeTaskId` in `team.js` (a task blocked on a card carries on after the founder approves it), on a real database with real pods | 9 | 100% | 3.x follow-up | pass |
| `autoscaling` | `src/runtime/autoscaler.js` (agents added up to a cap as queues grow, a card past the cap, idle copies removed, ended project spaces closed), `scripts/scale.js`, on a fresh real database per case | 9 | 100% | 4.1 | pass |
| `guardrails` | `src/runtime/guardrails.js`, the daily cap, loop detection and team switch in `agent.js` and `team.js`, `/pause` and `/resume` in the bot, the two `guardrails.*` commands and the Teams page's switches, on a fresh real database per case | 8 | 100% | 4.2 | pass |
| `audit-search` | `src/runtime/audit-search.js`, the `audit.search` command, `audit.mjs` and the Audit log page (the step 4.3 done-when: any action from the gate tests can be found by search), on the real engineering world | 8 | 100% | 4.3 | pass |
| `settings-page` | `src/runtime/settings.js`, `guardrails.setLimits`, the three `settings.*` commands, `settings.mjs` and the Settings page (the step 4.3 done-when: changing a limit takes effect without a restart), on a fresh real database per case | 8 | 100% | 4.3 | pass |
| `skills-loader` | `src/runtime/agents/skills.js` (shared plus a team's skills) | 10 | 100% | 2.1 | pass |
| `agent-loop` | `src/runtime/agents/agent.js` (one agent's step loop) | 20 | 100% | 2.1 | pass |
| `team-framework` | `src/runtime/agents/{lead,team,index}.js` (lead, workers and the factory, on a real database) | 25 | 100% | 2.1 | pass |
| `outbound-review` | `src/runtime/outbound/{review,settings}.js` (the review agent and the founder-approval setting) | 15 | 100% | 2.2 | pass |
| `outbound-gate` | `src/runtime/outbound/{service,tools}.js` (the step 2.2 done-when, on a real database) | 24 | 100% | 2.2 | pass |
| `search-tool` | `src/runtime/tools/search.js` (web search through Tavily) | 8 | 100% | 2.3 (search) | pass |
| `crm-tools` | `src/runtime/tools/crm.js` (find and save leads in the `clients` table), on a real Postgres | 10 | 100% | 2.3 (CRM) | pass |
| `google-tools` | `src/runtime/tools/google.js` (read Gmail, make drafts, list and save Drive files; never sends) | 11 | 100% | 2.3 (Gmail and Drive) | pass |
| `sales-team` | `src/runtime/teams/marketing-sales.js`, `config/mcp/marketing_sales.yaml` and `.claude/skills/marketing_sales/` (the step 2.3 done-when, on a real database) | 11 | 100% | 2.3 | pass |
| `ticket-tools` | `src/runtime/tools/tickets.js` (read a ticket a team has taken, record that it was answered), on a real Postgres | 9 | 100% | 2.4 (tickets) | pass |
| `support-team` | `src/runtime/teams/support.js`, `config/mcp/support.yaml` and `.claude/skills/support/` (the step 2.4 done-when, on a real database) | 14 | 100% | 2.4 | pass |
| `teams-overview` | `src/runtime/teams/overview.js` (what the Teams page shows: agents, open and blocked tasks), on a real Postgres | 8 | 100% | 2.5 | pass |
| `teams-view` | `src/renderer/teams.mjs` and `TeamsPanel.jsx` (the logic and rules behind the window's Teams page) | 14 | 100% | 2.5 | pass |
| `daily-brief` | `src/runtime/brief.js` and `src/renderer/BriefPanel.jsx` (the brief: figures, IST, one source for the window and Telegram) | 10 | 100% | 2.6 | pass |
| `team-jobs` | `src/runtime/teams/jobs.js` (starting the sales or support team from the window) | 7 | 100% | 2.x follow-up | pass |
| `engineering-tools` | `tools/{pod-files,git,github,pod,context7,browser}.js` (the step 3.3 tools, on a real database, real folders and real git with bare repositories as the GitHub side) | 10 | 100% | 3.3 | pass |
| `engineering-team` | `teams/engineering.js`, `config/mcp/product_engineering.yaml`, `.claude/skills/product_engineering/` (the step 3.3 done-when, with the real factory, skills and tools and a scripted model) | 10 | 100% | 3.3 | pass |
| `finance-tools` | `tools/invoice.js` and `config/mcp/finance_legal_ops.yaml` (the step 3.4 tool: a draft invoice with the GST worked out in code, and no payment credential or payment tool anywhere) | 10 | 100% | 3.4 | pass |
| `finance-team` | `teams/finance-legal-ops.js`, `config/mcp/finance_legal_ops.yaml`, `.claude/skills/finance_legal_ops/` (the step 3.4 done-when, with the real factory, skills and tools, a real database and a scripted model) | 11 | 100% | 3.4 | pass |
| `specialist-queue` | `src/runtime/specialists.js`, `pods.setPriority` and the brief's "Shared specialists" section (the step 3.5 done-when: two pods need the same specialist and P1 is served first), on a real database with three real pods | 13 | 100% | 3.5 | pass |
| `pod-files` | `src/runtime/pods/files.js`, the lock in `pod.write_file`, the `files.*` commands, the preload, `src/renderer/files.mjs` and `FilesPanel.jsx` (the step 3.6 done-when: an edit is committed with history, and an agent write to a locked file is refused), on a real database with three real pods and real git | 13 | 100% | 3.6 | pass |
| `agents-panel` | `src/runtime/agents/{events,control}.js`, the loop and team hooks in `agent.js` and `team.js`, the `agents.*` commands, the preload, `src/renderer/agents.mjs` and `AgentsPanel.jsx` (the step 3.7 done-when: a step an agent takes is in the feed at once, and a typed note reaches the agent), on a real database with the real agent loop | 13 | 100% | 3.7 | pass |
| `pod-isolation` | `tools/{index,filesystem,git,memory,pod,supabase}.js` and `agents/{agent,team}.js` (the step 3.2 done-when: pod A cannot reach pod B), on a real database, real folders and real git | 13 | 100% | 3.2 | pass |
| `pod-creation` | `src/runtime/pods/{service,templates}.js`, `config/pods/` and `scripts/pod.js` (the step 3.1 done-when, on a real database and real git) | 13 | 100% | 3.1 | pass |
| `morning-digest` | `src/runtime/telegram/digest.js` (the digest sent once a day at a fixed IST time) | 11 | 100% | 2.6 | pass |
| `goals-view` | `src/renderer/goals.mjs` (the logic behind the window's Goals panel, including the Download button) | 27 | 100% | 1.9 follow-up | pass |
| `runtime-core` | `src/runtime/{config,audit,runtime,commands}.js` and `src/ipc-guard.js` | 37 | 100% | 1.2 | pass |
| `decisions-service` | `src/runtime/decisions.js`, against a real Postgres with the migrations | 35 | 100% | 1.6 | pass |
| `policy-tools` | `src/runtime/policy-tools.js` (the founder adding tools from Telegram), against a real Postgres | 22 | 100% | 1.6 follow-up (used by the bot in 1.8) | pass |

Update the "Today" column when a suite's status changes.

## Suites

### invariants

Suite: `.claude/evals/suites/invariants.js`. No dataset; each case is a check function in the suite file. Runs against the repo today.

**Cases:** 16

| Case | Rule it protects |
|---|---|
| `only-the-memory-tools-and-the-pods-service-touch-the-memory-table` | Only `tools/memory.js` (which takes the memory space from the run) and `pods/service.js` (which writes a new pod's first note) use the `memory` table, so no other module can read one pod's notes into another pod's run (step 3.2) |
| `runtime-never-imports-electron` | `src/runtime/` stays free of `electron` imports so it can run headless later |
| `window-security-flags` | `src/main.js` keeps `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| `renderer-csp-strict` | `index.html` has a CSP with `default-src 'self'` and no `'unsafe-inline'` or `'unsafe-eval'` |
| `dev-csp-relaxation-serve-only` | `electron.vite.config.mjs` may loosen the CSP for hot reload only with `apply: 'serve'`, so production builds keep the strict CSP |
| `preload-no-raw-ipcrenderer` | `src/preload.js` never hands `ipcRenderer` itself to the renderer (the `require` line that imports it is ignored) |
| `preload-exposes-only-the-planned-api` | `src/preload.js` exposes only `window.versions` and `window.api`, and uses `ipcRenderer` only through `invoke`, `on` and `removeListener` on the two literal channels `runtime:invoke` and `runtime:event` |
| `secrets-and-results-gitignored` | `.gitignore` lists `.env` and `.claude/evals/results/` |
| `claude-docs-in-dot-claude` | No `CLAUDE.md`, `CLAUDE.local.md`, `PLAN.md`, `EVALS.md` or `SKILL.md` exists outside `.claude/` |
| `env-example-names-only` | `.env.example` exists, every line is a comment or a `NAME=` with no value, so no key is ever committed through it, **and it names every setting the code reads** (so a deleted line, like `SUPABASE_ACCESS_TOKEN=`, fails here instead of going unnoticed) |
| `policy-is-the-only-source-of-allow` | Nothing under `src/` except `src/runtime/policy.js` builds an `allowed: true` answer, and `policy.js` grants in exactly one place, so no code path can approve an action without going through the policy check |
| `only-the-decisions-service-answers-decisions` | Nothing under `src/` except `src/runtime/decisions.js` writes a decision's status or its resolution fields (`resolved_via`, `resolved_at`, `resolution_note`), and the service's answer channels are exactly `dashboard` and `telegram`, so "nothing is auto-approved" cannot be broken by a new code path or a new "agent" channel |
| `only-the-policy-tools-service-touches-the-policy-table` | Nothing under `src/` except `src/runtime/policy-tools.js` mentions the `policy_tools` table, so no other module has a way to read or change the founder's additions to the policy, and nothing an agent is handed can loosen it |
| `evals-doc-in-sync` | This file lists every suite, with a correct `**Cases:**` count |

### policy-check

Suite: `.claude/evals/suites/policy-check.js`. Dataset: `.claude/evals/datasets/policy-check.json`. Code under test: `src/runtime/policy.js`. Unit tests that sweep every listed tool (`src/runtime/policy.test.js`) back the dataset up.

**Cases:** 51

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
| `edge-*` | 12 | A deploy with no, odd or malformed target is treated as production; any merge asks, not only into `main`; padded and mixed-case names still match; look-alike letters (the Kelvin sign) and zero-width characters never match; a routine tool with the wrong access tag is denied; names like `constructor` are unknown; a missing tool name or a `null` action is denied |

Checked by mutation on Nov 23, 2026: 20 realistic mistakes were introduced into `policy.js` one at a time (unknown tools allowed, a tool forgotten, the access-tag check removed, always-ask only for write tags, a weak deploy check, non-ASCII names accepted, names not trimmed or lower-cased, a note or a title believed, errors thrown or allowed, a shared result object, prototype-key lookup, merges only asking for `main`, a wrong category). 19 were caught by the unit tests or this suite; the 20th (removing the `null` check) behaves identically because the try/catch still refuses it.

Judgment calls worth revisiting (they come from my reading of `kickstart.md`, not from the founder): merging to `main` counts as a production launch, and so does merging anywhere else (the policy cannot tell which branch ships); a deploy counts as routine only when its target is exactly `preview`; bookkeeping entries count as routine rather than spending.

### decision-cards

Suite: `.claude/evals/suites/decision-cards.js`. Dataset: `.claude/evals/datasets/decision-cards.json`. Code under test: `src/runtime/cards.js`. Unit tests (`src/runtime/cards.test.js`, 26 tests) back the dataset up: every jargon term, a corpus of ordinary sentences that must never be flagged, hostile input, and what the loop promises.

**Cases:** 52

Contract: `checkCard(card) -> { pass, problems, findings }`, where problems are `missing_field`, `jargon`, `contains_code`, `bad_risk_level`, `cost_format` and `time_format`; and `produceCard({ request, write, maxAttempts }) -> { status: 'ready', card, attempts } | { status: 'flagged', problems, rejectedDraft, attempts }`. The full contract is in the header of the suite file. This grades the deterministic checker and the writer-checker loop (with a scripted writer), not the model that will write the cards.

| Group | Cases | What it checks |
|---|---|---|
| `good-*` | 7 | The kickstart's "after" example passes; a technical word explained in brackets passes, and may be reused afterwards; times with IST pass; technical text in `details` is exempt; everyday business words (invoice, website, sales pipeline) are not flagged; a High risk and two IST times pass |
| `bad-*` | 29 | Jargon (the kickstart's "before" example, an unexplained abbreviation, jargon in the risk reason, a thin explanation, an explanation that comes after the first use, a version number, plurals and capitals, a term hidden by an invisible character); missing risk, blank recommendation, risk without a reason, a field of only invisible characters, a field that is not text, a `null` card; code in founder-facing text (backticks, a code fence, a command without backticks, SQL); cost without both ₹ and $ (or without numbers, or in words); a risk level other than exactly Low, Medium or High; times without a zone, in UTC, or in another zone; a card with every kind of problem reports all of them |
| `loop-*` | 8 | Passes on the first try; fixed on the second try after being told what was wrong; flagged after the limit; stops at the limit even if a later try would pass; a writer that crashes counts as a try (and, if it always crashes, is flagged as `writer_error`); a ready card holds only the seven fields (plus `details`) and drops anything else the writer added; a flagged result has no `card` property, so it cannot be sent |

Checked by mutation on Nov 23, 2026: 36 realistic mistakes were introduced into `cards.js` one at a time (a check removed, explanations that are too thin accepted, invisible characters or look-alike letters not folded, `details` read like the other fields, any time zone accepted, one currency accepted, case-insensitive risk levels, an everyday word made jargon, a retry too many, a flagged result that carries a card, error text leaking, no snapshot before checking, and more). The first run missed 4: two thin-explanation rules that hid each other, SQL `select ... from` never tested, and a deleted jargon term (the tests read the term list, so deleting a term deleted its test). Tests were added for each, and all 36 are now caught.

Judgment calls, **confirmed by the founder on Nov 23, 2026** (the three below; the jargon list itself is still a starting set to tune against real cards): the jargon list is a starting set of 56 words and will need tuning against real cards (words like `production`, `branch` and `ram` are deliberately not on it, because they are ordinary words or names); an explanation in brackets needs at least three words and twelve letters; a clock time must be followed by `IST`, so a card that also quotes another zone in brackets is rejected; every cost must show both currencies with numbers, so "free" has to be written `₹0 ($0)`.

**Unknown price (Nov 24, 2026, the founder's decision):** a goal such as "buy a domain" has no price in it, and a writer that must not invent one could never produce a card (found when a real run wrote three honest drafts such as "Price not stated" and the checker rejected every one, so no card was made and the task was skipped quietly). The checker now also accepts a cost with **no digits at all** that says in words it is not known ("unknown", "not stated", "not yet confirmed", "to be confirmed"). A half-guess such as "Unknown, maybe ₹500", "No cost", "A small amount" or the unknown said only in another field still has to follow the two-currency rule, and money of an unknown size can never be "Low" risk (new problem code `unknown_cost_low_risk`). The writer's instructions teach the exact wording "Price not known yet". 8 dataset cases (3 that must pass, 5 that must fail) and 2 unit tests; checked by breaking the rule 5 ways, all caught (the first run missed removing the instruction, so a unit test was added). Live: three real runs of the same goal all produced a card.

### claude-code-provider

Suite: `.claude/evals/suites/claude-code-provider.js`. No dataset; each case is a check function in the suite file. Code under test: `src/runtime/providers/claude-code.js`, with unit tests in `src/runtime/providers/claude-code.test.js` (the process launcher, with a stand-in for `execFile`). One live call was made on Nov 24, 2026: it returned `OK` from `claude-haiku-5-5` for about $0.0006.

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

### model-router

Suite: `.claude/evals/suites/model-router.js`. No dataset; each case is a check function in the suite file. Code under test: `src/runtime/router.js`, with unit tests in `src/runtime/router.test.js`.

**Cases:** 35

Contract: `createRouter({ providers, audit, sleep, caps? })` returns `complete({ taskId, tier, prompt, sensitive? })`, which never throws and answers `{ ok: true, text, provider, model, costUsd, attempts }` or `{ ok: false, reason, message }`. Also `validateProviders(list)` and `defaultProviderConfig()`. Providers are mocks and `sleep` is injected, so no model is called and nothing waits. The full contract is in the header of the suite file.

| Group | Cases | What it checks |
|---|---|---|
| Chain | 6 | The first provider that answers wins and the chain stops; a failing chain falls through all three in the configured order (not alphabetical); everything failing returns a failure and never throws; provider error text (it can hold a key) never reaches the caller; an empty list is a clean `no_provider`; a provider added by configuration alone is used |
| Retry and backoff | 5 | A provider is retried and can then succeed; retries stop at the limit and the chain moves on; delays between retries grow; an answer with no text, or an empty one, counts as a failure |
| Tiers and sensitive text | 5 | The strong tier skips providers not allowed for it; an unknown tier is refused; sensitive text goes only to a provider marked `sensitive: true`, deny by default (a missing flag, `"true"` or `1` does not count); non-sensitive text may use any provider |
| Caps | 6 | A step cap and a token cap each stop a task and call nothing more; caps are per task; a request with no task id, a blank prompt or a non-string prompt is refused before any call |
| Concurrency | 2 | Five parallel calls never put more than two in flight on a provider capped at two; a provider at its cap is skipped and the next one answers, never queued |
| Audit | 4 | Every attempt is audited before the call; the entry names provider, model and task and never holds the prompt or the answer; if the audit entry cannot be written no provider is called; the result reports cost and attempt count |
| Configuration | 7 | `validateProviders` accepts a good list, rejects duplicate names, bad or empty tiers and a missing `call`, and never throws on garbage; the default config is groq, ollama, claude-code in that order, keeps the two hosted providers away from sensitive text, makes Claude Code last with a cap of two calls, and passes its own validation once calls are attached |

Judgment calls to confirm with the founder: a provider at its concurrency cap is skipped rather than queued (a Groq outage must not pile up waiting calls); a failed audit write stops the call ("no audit, no action", as in step 1.2); the default caps (20 steps and 50,000 tokens per task, 2 retries, 500 ms base delay) are a starting set to tune.

### http-providers

Suite: `.claude/evals/suites/http-providers.js`. No dataset; each case is a check function in the suite file. Code under test: `src/runtime/providers/groq.js`, `ollama.js` and `index.js`. No network is used: `fetch` is a stand-in, and the key is a dummy.

**Cases:** 21

Contract: `createGroqCall({ apiKey, fetchImpl })`, `createOllamaCall({ baseUrl, fetchImpl })` and `buildProviders({ env, fetchImpl, run? })`. A `call({ prompt, model })` resolves to `{ text, model, costUsd, tokens }` or throws, and the router treats a throw as a failed attempt.

| Group | Cases | What it checks |
|---|---|---|
| Groq | 8 | Posts to Groq's https API with the key only as a bearer token (never in the URL or body); one user message with the model and prompt; text, model and token count come back; an error status, a network failure, an answer with no text, and a missing or blank key all throw, and no message holds the key or the response body; a missing key sends no request at all |
| Ollama | 5 | Posts to `<base>/api/chat` with streaming off; defaults to `http://localhost:11434` and ignores a trailing slash; text, model and token count (prompt plus generated) come back; a base URL that is not http or https (`file:`, `javascript:`, `ftp:`, garbage) is refused before any request; an error status or a missing message throws |
| Provider list | 8 | Order is groq, ollama, claude-code; Groq is left out when its key is missing or blank; model names come from `GROQ_MODEL` and `OLLAMA_MODEL` with placeholder defaults; the list passes the router's own validation; hosted providers are kept away from sensitive text and Claude Code is last with a cap of 2; the key is never stored on an entry; the Groq and Ollama entries really use `GROQ_API_KEY` and `OLLAMA_BASE_URL` |

Judgment call: Groq reports `costUsd: 0` because its free tier returns no cost; when a paid plan is used, pricing is added then.

### telegram-bot

Suite: `.claude/evals/suites/telegram-bot.js`. No dataset; each case is a check function in the suite file. Code under test: `src/runtime/telegram/bot.js`, `api.js` and `poller.js`, with the wiring (`index.js`, unit-tested in `index.test.js`) that starts them. Nothing talks to Telegram: the bot gets a fake API, fake services and synthetic updates, and the token is a dummy.

**Cases:** 81

Added Nov 26, 2026: **/status** sends the overview text for the words after the command (and says it is not available without one, never shows error text, and ignores a stranger); **/lead <company> [https://site] [email]** picks the web address and email out of the words, answers at once, runs the sales team in the background and reports how it ended while the bot keeps answering, says what is missing, allows two team jobs at a time, relays why a lead was refused and never shows error text; **/ticket [id]** works the oldest open ticket or the one named and says how it ended. Checked by mutation: removing the limit on team jobs was caught.

Contract: `createBot({ api, founderChatId, decisions, policyTools, orchestrator?, onError? })` returns `handleUpdate(update)`, `pushCard(decision)` and `notifyReminder(decision)`; `createTelegramApi({ token, fetchImpl })` and `createPoller({ api, handle, sleep, onError })` are the thin layers around it. The full contract is in the header of the suite file.

| Group | Cases | What it checks |
|---|---|---|
| Only the founder | 5 | A message or a button tap from any other chat does nothing (no reply, no service call); the sender must be the founder even inside the founder's chat; the chat id matches as a string or a number; garbage updates never throw |
| Cards | 7 | A card goes to the founder's chat with Approve and Reject buttons; the text shows all seven fields and never the "Show details" text; button data fits Telegram's 64-byte limit; a card that is not pending is never sent; a reminder says it is a reminder; a very long card is cut below 4096 characters; every message is plain text with no parse mode |
| Taps | 13 | A database problem is explained in a sentence that says what to do (a missing table points to the migrations, an unreachable database to the connection, a rejected key to `SUPABASE_SERVICE_ROLE_KEY` in `.env`), and any other database error stays generic with the store's own text never shown (added after the first real-Telegram try, Nov 24, 2026); if editing the message fails after an answer or a policy confirm, the outcome is sent as a new message and the founder is never told "nothing was changed"; a failing callback answer is reported to `onError`, never thrown (added after the code review of Nov 24, 2026). Approve and Reject resolve through the decisions service as `via: 'telegram'` and nothing else; the message then shows the answer and loses its buttons; every tap answers the callback so the spinner stops; a card answered elsewhere first is reported as it is, not as the tap; a raw error never reaches the founder (a pasted key included) while a `DecisionError`, which is written for the founder, does; bad button data calls nothing |
| Policy commands | 8 | `/tools` lists additions; `/addtool <tool> ask <category>` is active at once; the category words map to the four policy categories; a routine addition asks Yes or No first, and only Yes confirms (No cancels); `/removetool` removes; badly formed commands get help and call nothing; a `PolicyToolError` is shown and other errors are not |
| Add this tool | 4 | A tool name that is odd (newlines, spaces, over 100 characters, empty) is refused and never shown or proposed; an unknown-tool card offers the buttons and no other card does; the tool name comes from the stored decision, never from the button; the routine option asks for a Yes before it takes effect |
| Other commands | 5 | A command that fails is reported to `onError` while the founder gets the generic sentence; `/brief` and `/status` say they are not available yet (their data arrives with later steps) and call nothing; `/help` and `/start` list the commands; unknown commands and plain text get a hint and call nothing; `/tools@botname` works |
| Goals (`/goal`) | 14 | The text goes to the orchestrator exactly as typed (line breaks kept, a `@botname` suffix ignored) and the bot says it is working; **the bot keeps answering taps and commands while a goal is being planned** (it never waits for the run); the result comes as a second message, with what was done so far when the run is waiting on a decision, a summary when finished, and the run's own plain message when it could not start; no text gets usage, and a goal over 2000 characters is refused, each calling nothing; only the founder can send one; at most 3 run at once and a finished one frees its place; a failing orchestrator gives the generic sentence, reports to `onError` and frees its place; a very long result is cut below Telegram's limit and stays plain text; with no orchestrator the bot says goals are not available; `/help` lists `/goal` |
| API client | 5 | Calls `https://api.telegram.org/bot<token>/<method>` with no token in the body and no parse mode; send, edit and answer use the right methods; `getUpdates` sends offset and timeout; no error message or stack ever holds the token; no token means no request |
| Poller | 7 | On start it skips whatever piled up while the app was closed (so a restart cannot replay an old confirm or removal; a tap made while closed must be made again); updates that arrive after `stop()` are not handled; starting twice runs one loop; updates are handled in order and the offset moves past them; a handler that throws neither stops the loop nor repeats the update; a failed poll waits longer each time and then recovers; `stop()` ends the loop |

Judgment calls to confirm with the founder: messages from other chats get no reply and no audit entry (a reply would tell a stranger the bot exists, and an entry per message would let a stranger fill the log); `/brief`, `/status` and `/pause` are honest "not available yet" replies until the orchestrator and the agent controls exist; all text is plain, with no formatting, so a card cannot be made to look like something it is not.

**Honest summaries (Nov 24, 2026):** 1 new case. A run in which a task was blocked or failed no longer ends with a plain "Finished.": it says "Finished, but N task(s) did not go ahead." (a task you rejected is your own choice and does not count).

### graph-checkpointer

Suite: `.claude/evals/suites/graph-checkpointer.js`. No dataset; each case is a check function in the suite file. Code under test: `src/runtime/orchestrator/checkpointer.js`, with 6 fast unit tests in `checkpointer.test.js` (a fake store that counts calls). It runs against the real REST client and a real Postgres with the real migrations (`scripts/fake-supabase.js`), so the two new tables (`graph_checkpoints`, `graph_writes`) and the code agree.

**Cases:** 20

Contract: `createSupabaseSaver({ store })` returns a LangGraph `BaseCheckpointSaver` (`getTuple`, `list`, `put`, `putWrites`, `deleteThread`). The REST store can select, insert and update with equality filters only, so the saver checks, then inserts or updates, and filters `before` and metadata in code. Values are stored as base64 text.

| Group | Cases | What it checks |
|---|---|---|
| Saving and loading | 7 | A saved checkpoint comes back as the latest, with its metadata; the latest is the newest and an id asks for an older one; the parent config points at the checkpoint before; an empty thread or unknown id gives `undefined`; threads and namespaces never see each other; unicode, nesting, 300 KB of text and raw bytes survive; saving the same id again replaces it |
| Pending writes | 4 | Writes come back with their own checkpoint, sorted by task and position; an ordinary write repeated keeps the first, a special one (an interrupt) is replaced; writes belong only to the checkpoint they were made for; a missing thread or checkpoint id throws |
| Listing | 4 | Newest first and only for its own thread; `limit`, `before` and a metadata filter; each item carries its pending writes; a `limit` is handed to the database and pending writes are loaded only for the rows actually returned (added after the code review of Nov 24, 2026) |
| Failure | 2 | A failing store makes the saver fail loudly; deleting a thread says it is not supported yet (the REST store cannot delete) |
| A real graph | 3 | A graph that paused for approval resumes through a **new saver and a new graph over the same database**, as after an app restart; a rejected answer does not run the action; two paused graphs resume independently |

Judgment calls: deleting a thread is unsupported, so finished runs stay in the tables (they are small, and a delete can be added to the store with its own eval); checkpoints older than LangGraph's version 4 format are not read, because this store never held any.

### orchestrator

Suite: `.claude/evals/suites/orchestrator.js`. No dataset; each case is a check function in the suite file. Code under test: `src/runtime/orchestrator/graph.js`, with 5 unit tests in `graph.test.js`. The planner, card writer and tool runner are passed in, so no model or real tool is involved. The policy is the REAL policy (`src/runtime/policy.js`); the decisions service is a small fake that files cards and lets a test answer them; one case uses the real checkpoint store over a real Postgres.

**Cases:** 57

Contract: `createOrchestrator({ planner, writeCard, runTool, decisions, policy, checkpointer, audit, emit? })` returns `start({ goal, threadId? })`, `resume({ threadId })` and `status({ threadId })`. Results are `{ threadId, status: 'waiting' | 'done' | 'failed' | 'unknown', waitingFor, reason?, results, log }`. The full contract, the outcomes and the failure reasons are in the header of the suite file.

| Group | Cases | What it checks |
|---|---|---|
| Routine and pausing | 6 | Routine actions run with no decision; a goal with a spend pauses and runs nothing after it; the card comes from the writer and the action passed on holds only what the policy reads; a planner that claims "approved" cannot skip the decision; an unknown tool files a card in the `unknown` category; two spends pause one at a time |
| Resuming | 7 | Approving and resuming runs the spend and then the rest; a rejected or cancelled decision skips it and the rest still runs; resuming before an answer changes nothing and files no second card; "asked for more information" keeps waiting; `resume` reads the stored decision and ignores anything the caller claims; a finished run cannot be resumed into running anything again; a thread that does not exist is `unknown` and never throws |
| The unknown-tool rule | 1 | An approved decision for an unknown tool does **not** run the tool, and the log says to add it to the policy table first |
| Failure behaviour | 6 | An event listener that throws does not break the run or file a second card; a tool that fails is recorded, never retried and never leaks (later tasks still run); a card that cannot be written, a card the decisions service rejects, a decision that cannot be filed, and a policy that throws each block that task and never run it (the policy fails closed) |
| Audit | 6 | If the `orchestrator.waiting` entry cannot be written the card is cancelled and the task does not run; that entry links the decision to its run, which is how the app finds the run again; the run is audited at the start and before each tool runs; if the tool run cannot be audited the tool does not run; if the start cannot be audited nothing is planned, filed or run; the tool runner gets a stable idempotency key per task |
| Planning input | 5 | An empty plan (the planner saying no tool fits the goal) fails with `nothing_to_do` and a plain message, not "bad plan"; a plan with unusable arguments (a function, a symbol, a bigint, a circular reference, over 10,000 characters, not a plain object) is a `bad_plan`, not a crash; a blank, non-text or oversized goal is refused before planning; a bad plan (not a list, over 20 tasks, a missing title, tool or action, a bad access tag, a blank title) fails the run with nothing filed or run; a planner that throws fails the run and its error text is never shown |
| Isolation and safety | 6 | Starting the same thread twice at once runs it once; a thread id that already exists is refused and left alone; two runs at once do not mix their decisions; a tool's output is never kept in the result or the log; `status` reports waiting, then done, with the log in order; events carry ids only, never the goal or card text |
| Crashes | 3 | A crash right after a tool runs (the result never recorded), right after an **approved** tool runs, or right after a card is filed but before the run is saved: the run is reported `interrupted`, never continued, and the tool runs **at most once**; a run with a card that was never saved is `interrupted`, not "waiting" (added after the code review of Nov 24, 2026; the first two failed with the tool run twice before the fix) |
| Real checkpoint store | 1 | A waiting run resumes through a **new orchestrator and a new saver over the same database**, as after an app restart |

Checked by mutation on Nov 24, 2026: 10 realistic mistakes were each introduced into `graph.js` one at a time (an approved unknown tool runs, everything counts as allowed, a policy error lets the task run, "asked for more information" resumes the run, a rejection still runs the tool, a tool runs without an audit entry, planner extras reach the action, a failed tool is retried, an existing run can be started over, a tool's output is kept in the log). All 10 are caught; the first try at the last one was a badly made mutation (it never leaked anything) and was redone properly.

Checked by mutation a second time on Nov 24, 2026, after the review fixes: 8 more mistakes (saves back to the background, an interrupted run called "waiting", the start id not reserved, events that can throw inside a step, arguments with functions dropped quietly, no size cap on arguments, a card left behind when it cannot be linked, the waiting entry never written). All 8 are caught. **Finding along the way:** LangGraph's default saves each step in the background, so when saving fails the run keeps going and runs later tools that are not being recorded; the orchestrator now runs with `durability: 'sync'` (each step is saved before the next starts).

Judgment calls to confirm with the founder: a rejected or cancelled spend skips only that task and the rest of the plan still runs; a failed action is never retried automatically; a task whose card cannot be written is skipped, not run; a plan is capped at 20 tasks and a goal at 2000 characters; a run that stopped part-way is reported `interrupted` and left for you to re-plan, never continued automatically (a tool runs at most once). A known gap: if the app stops between filing a card and saving the run, that card stays pending but no run waits on it, so answering it does nothing (it never runs anything).

**What the window shows (Nov 24, 2026):** 6 new cases. A summary carries the goal (cut to 300 characters) and the planned tasks; a run still being planned reports `running` with its goal (it used to read as "stopped part-way", and the goal text is kept in memory for the first moments before it is saved); `orchestrator.started` is the first announcement and carries only the thread id; a run that cannot start announces `orchestrator.failed` with its reason (and a refused goal announces nothing); and the plan and each finished task are announced (`orchestrator.planned`, `orchestrator.progress`) only after they are saved, checked by reading the run at the moment of each announcement.

### approval-queue

Suite: `.claude/evals/suites/approval-queue.js`. No dataset. Code under test: `src/renderer/queue.mjs`: plain functions with no React and no `window`, so nothing needs mocking. The screen (`ApprovalQueue.jsx`) is thin on purpose and only draws what these return.

**Cases:** 28

Contract: `mergeLists(...lists)`, `applyEvent(rows, event) -> { rows, refetch }`, `cardView(row)`, `ageLabel(createdAt, now)`, `describeAnswer(result) -> { tone, text, remove }` and `answerArgs({ id, decision, note }) -> { ok, args } | { ok: false, problem }`. The full contract is in the header of the suite file.

| Group | Cases | What it checks |
|---|---|---|
| Live events | 8 | **A card answered somewhere else (the phone) leaves the queue with no refetch**; a rejected or cancelled answer and a cancelled card leave too; "asked for more information" keeps the card and marks it; a new decision asks for exactly one fetch and changes nothing itself; the runtime becoming ready asks for a fetch, and every other event does nothing; an event for a card that is not there changes nothing; malformed events change nothing and never throw; the list it was given is never changed |
| Merging | 4 | Waiting and "asked" cards merge oldest first with one per id; rows without an id and missing lists are tolerated; cards with the same time keep a stable order; inputs are never changed |
| What a card shows | 8 | All seven fields, the details and the tool; a plain label per category; missing or odd fields become empty text and never throw; risk gets a tone and the level is always kept as words (never colour alone); details exist only when there is text; only a waiting card can be asked about, and each state has a label; an unknown-tool card says approving it does not run it; text is passed through as it is, never turned into markup |
| Age | 2 | "just now", "5 minutes ago", "1 hour ago", "3 days ago"; a future or bad time gives "just now" or nothing |
| Answers | 6 | An answer that took effect is confirmed and a final one removes the card; one that lost the race says "already approved" and the card goes; a refused or garbled reply is an error that keeps the card; the arguments hold only the id, the decision and a trimmed note; a bad id, a bad decision or a note over 2000 characters is refused before anything is sent; nothing else (`via`, `status`, `channel`) can ride along |

Checked by mutation on Nov 24, 2026: 10 mistakes were introduced one at a time (a card answered elsewhere stays, a new decision does not trigger a fetch, asking for more removes the card, a duplicate card, newest first, extra keys sent to the runtime, high risk looking low, losing a race keeps the card, the unknown-tool warning dropped, an overlong note accepted). All 10 are caught.

**Checked in the real window on Nov 24, 2026** (the built Electron app with its strict production CSP, against a seeded local database, driven like a user; no Telegram, no Groq): 14 of 14 checks passed with no console errors. The queue loads three cards; all seven fields show in plain words; Show details reveals the technical text and tool (and says it is expanded to assistive tech); the unknown-tool card carries its warning; Approve removes the card and the database says `approved` via the dashboard; Ask more keeps the card, marks it and stores the question; **a card answered on the phone disappears without a refresh**; a new decision appears by itself; with nothing left the screen says so; nothing overflows at the default window size. The audit log held exactly 4 list reads and 4 answers: no polling. This driver script is not in the repo (it needs a browser-driving library), so the window is not covered by `npm test`.

### tool-loader

Suite: `.claude/evals/suites/tool-loader.js`. No dataset. Code under test: `src/runtime/tools/index.js` (`createToolLoader`) and `src/runtime/tools/builtin.js` (the draft tool).

**Cases:** 30

Why it exists: step 1.10 says a tool with no policy rule must never load, and tasks need a way to hand text back to the founder (for example a script asked for through Telegram).

| Group | Cases | What it checks |
|---|---|---|
| Loading | 6 | Only a tool with a policy rule loads; a failing rule check refuses it; malformed and duplicate definitions are refused while good ones still load; garbage input never throws; the planner's description is a copy |
| Running | 15 | The rule is checked again on every call; the access tag must match; arguments are checked first and a failing check never shows its text; a tool's result shrinks to plain `{ text }` (exact line breaks kept, long text cut); a tool's own error text never escapes; a hung tool is stopped; look-alike tool names do not match |
| Draft tool | 3 | `docs.create_draft` is a routine write the policy allows, returns its title and content, and refuses missing, blank, odd or oversized arguments |

Checked by mutation on Nov 24, 2026: 12 deliberate mistakes in the loader and draft tool, all caught.

**Files (5 cases):** a tool may also hand back one file `{ name, content }`. The loader keeps it exactly, reduces the name to a safe plain one (no folders, no odd characters, not hidden), drops a file that is not usable or over 20,000 characters while keeping the text, allows an empty file, and the draft tool returns its script as a file named by its title (`.txt` added when there is no extension). 7 more mistakes about files were introduced and all caught.

The `orchestrator` eval gained 10 cases (6 for text, 4 for files: a file is kept on its own task exactly, secrets in it are removed, a file that is not a name and text is dropped while the task still ran, and files survive a pause); the text cases: text a tool returns is kept on its own task only, secrets removed, cut to 8000 characters, odd results dropped, and it survives a pause. The `telegram-bot` eval gained 1: that text is sent exactly as written below the summary.

### zip-file

Suite: `.claude/evals/suites/zip-file.js`. No dataset. Code under test: `src/renderer/zip.mjs` (`makeZip(files) -> Uint8Array`), used by the Goals panel's Download button when a goal made several files.

**Cases:** 9

Why it exists: a zip with a wrong size field looks fine to a lenient reader but is rejected by real unzip tools. The first version of the builder had exactly that bug (the central directory size was measured after the end record had moved on), found by the case that runs the system `unzip -t` and then confirmed with Python's zipfile. The suite's own reader was then made strict (it now checks the directory size and the end record), and it was confirmed that the old bug fails 5 of the 9 cases.

| Group | Cases | What it checks |
|---|---|---|
| Content | 5 | Every file has its exact content and a correct checksum; it starts like a zip; non-English names and text survive (UTF-8 flag set); an empty file and an empty list work; a large file and 300 files are intact |
| Behaviour | 3 | The same input always gives the same bytes; the input is not changed; odd input gives a clear error or a valid zip, never a broken one |
| Real tool | 1 | The system `unzip` accepts it (`-t`) and extracts the same text (skipped as a pass on a machine with no `unzip`) |

**Checked in the real window on Nov 24, 2026** (the built Electron app, goals run by the real orchestrator with the real tool loader and draft tool, a scripted planner): 6 of 6 checks: the one-file goal offers `Download add_two_numbers.py`; the three-file goal offers `Download all 3 files (.zip)` and lists what is inside; clicking both saved the script exactly as written and a zip that the system `unzip` accepts and that holds three files with their own content; no console errors. This driver script is not in the repo.

### filesystem-tools

Suite: `.claude/evals/suites/filesystem-tools.js`. No dataset. Code under test: `src/runtime/tools/filesystem.js` (`createFilesystemTools({ root })`: `filesystem.read_file` and `filesystem.list_directory`, both read-only, both with built-in policy rules). The suite builds its own temporary folder (a project folder, a sibling folder whose name starts the same, an outside folder, and links) and removes it when it exits.

**Cases:** 21

Why it exists: step 1.10 says the Filesystem is "limited to the project folder", and the project folder holds `.env` with every key. An agent that can read files is only safe if the limit holds against `..`, absolute paths, look-alike sibling folders and links.

| Group | Cases | What it checks |
|---|---|---|
| The tools | 4 | Two read-only tools with a summary, an arguments line and a policy rule; no tools without an absolute folder (never a default of the whole disk); a folder that does not exist never falls back to another one; arguments are one plain path (extra keys, blanks, NUL and very long paths refused) |
| Reading | 6 | A file inside is read exactly (also through `./src/../`); a link that stays inside works; long text is cut and says so; a very large file and a binary file are refused; a folder cannot be read as a file nor a file listed |
| Staying inside | 4 | `..`, absolute paths (even one that points inside), `~`, drive letters and backslashes are refused; a sibling folder such as `root-evil` is outside; a link inside that points outside is refused for a file, through a folder and for a listing |
| Secrets | 4 | `.env*`, `.git`, `node_modules`, `.pem`, `id_rsa`, `credentials*` are never read, in any letter case, nor through a link (`link-env.txt` to `.env`); a listing hides them and any link that leaves the folder, shows folders with a slash, sorted; a huge listing is capped at 200 and says so |
| Errors and effects | 3 | An error never shows the folder's real path or the system's error text (no ENOENT and the like); nothing in the folder is changed by reading |

Checked by mutation on Nov 24, 2026: 15 deliberate mistakes in the tools. 12 were caught outright; 3 are redundant second checks (the written-path check, the case-insensitive name check and the listing's own skip all sit behind the link-following check, so removing one changes nothing anyone could see). Two gaps in the suite that the mutations exposed (a missing folder passing by luck because the folder had no README, and nothing pinning that absolute paths are refused) were closed and re-checked.

**Checked on the real project folder on Nov 24, 2026:** `package.json`, `src/runtime/policy.js`, a listing of `.` and `src` were read; `.env`, `.env.example`, `.git/config`, `node_modules/react/package.json`, `/etc/hosts`, `../../../etc/hosts` and a listing of `..` were all refused. Every refusal reaches the caller as only "The tool failed." On purpose: it says nothing about why.

### tool-config

Suite: `.claude/evals/suites/tool-config.js`. Code under test: `src/runtime/tools/config.js` and the shipped `config/mcp/shared.yaml`. An allow-list with a tag check that fails closed.

**Cases:** 19

Covers: shared plus team files, a team name cannot reach other files, a missing or broken file gives no tools, wrong entries are skipped, a tag that disagrees removes the tool, and the shipped file never lists a tool that asks the founder or has no policy rule.

### fetch-tool

Suite: `.claude/evals/suites/fetch-tool.js`. Code under test: `src/runtime/tools/fetch.js` (fake transport, no network).

**Cases:** 17

Covers: https only, no private, loopback or metadata address in any notation or through a redirect, the address check at connect time, at most 3 redirects, text only and cut, no credentials, and no system error text. Not yet run by hand against example.com and localhost.

### github-tools

Suite: `.claude/evals/suites/github-tools.js`. Code under test: `src/runtime/tools/github.js` (a fake network records every request). Tools: `github.read_file`, `github.list_pull_requests` (read), `github.create_pull_request` (routine write) and `github.merge_pull_request` (always asks the founder).

**Cases:** 15

Covers: no token or no repositories means no tools; only the repositories in `GITHUB_REPOS` (matched without regard to letter case) and nothing is sent for any other; the exact request for each tool; the token in one header to api.github.com only and redirects never followed; paths that leave the repository or name secrets are refused before any request (same name list as the Filesystem tools); folders, links, binary and very large files are not read; odd arguments refused before any request; a merge that did not happen is a failure; no token, GitHub message or system text in any error. Checked by mutation: any repository allowed, redirects followed and secret names readable were each caught. Not yet run by hand against real GitHub.

### supabase-tool

Suite: `.claude/evals/suites/supabase-tool.js`. Code under test: `src/runtime/tools/supabase.js` (a fake store whose insert and update throw if touched).

**Cases:** 13

Why it exists: the store uses the service key, which bypasses row-level security, so this tool is the only protection. Covers: only `tasks`, `projects`, `agents` and `scaling_rules` can be read (the audit log, decisions, policy table, checkpoints, memory, clients, pods and members cannot, in any spelling); select only; plain filters, a capped limit (default 20, at most 50) and a plain order; JSON rows one per line, cut to a limit; a database error never reaches the caller. Checked by mutation: all tables readable, limit not capped and the database error shown were each caught.

### tool-gate

Suite: `.claude/evals/suites/tool-gate.js`. The step 1.10 "done when", end to end: the real policy, loader, Filesystem tools (on a temporary folder with a secret outside it and a `.env` inside it), GitHub tools (fake network) and orchestrator graph; only the decisions store, planner and card writer are scripted.

**Cases:** 9

Covers: a file inside the folder is read with no decision; a file outside (relative and absolute) and `.env` are refused and their text appears nowhere (result, audit, events); a routine write (opening a pull request) runs without a decision; a merge pauses with a launch-or-pricing decision and sends nothing to GitHub before it; approving it sends exactly one request and the run finishes; rejecting it sends nothing and the run continues; an approved merge still cannot run if the team's tools do not include it or the repository was not named. Checked by mutation: making the merge routine in the policy was caught.

### shared-skills

Suite: `.claude/evals/suites/shared-skills.js`. Checks `.claude/skills/shared/{plain-language-approval,escalation-rules,handoff-notes}/SKILL.md` so the prose cannot drift from the code it describes.

**Cases:** 9

Covers: name matches folder, a description, a link to the charter and a length limit; no key-like text; the approval skill lists the seven parts in order with the money, time, "Show details" and "Price not known yet" rules, its good example card PASSES the real card checker and its bad example FAILS it; the escalation skill names every tool the policy always asks about, the four kinds of decision, the preview-deploy rule and "the policy check decides, treat doubt as crucial"; the handoff skill has its five headings and forbids secrets. Checked by mutation: a missing tool name, a changed example and a renamed heading were each caught.

### phase1-gate

Suite: `.claude/evals/suites/phase1-gate.js`. The scenario is `scripts/gate1.js`, so it can be re-run by hand with `npm run gate:1` (prints every step, exit code 1 on any failure) and also runs with `npm run eval`.

**Cases:** 3 (each wraps 16 checks)

Gate 1 of the plan: "a fake agent proposes a spend, a plain-language card reaches Telegram and the dashboard, one approval unblocks it, and `audit_log` records every step." **Real:** the whole app (`createApp`), a real Postgres with the real migrations, the real Telegram bot and poller, the real planner and card writer (prompts built, answers parsed), the real policy check, decisions service, tool loader, orchestrator graph and audit log. **Fake:** Telegram's servers, the model (the "fake agent": a plan with a purchase and a card), and the purchase tool (it only records that it was called). Any other network request is refused and counted.

The founder's path, run twice (the founder approves; the founder rejects): a `/goal` on Telegram is acknowledged; the plan's purchase becomes a decision in the spend category; the card passes the plain-language checker and shows ₹ and $; it reaches Telegram with Approve and Reject buttons; it is on the dashboard queue and the window is told; nothing is bought while it waits; one tap on the phone answers it and Telegram confirms; the run continues and buys exactly once, after its audit entry (or, on a rejection, buys nothing and still finishes); Telegram tells the founder how it ended; answering again from the dashboard changes nothing; `audit_log` has every step in order, no key or token anywhere, and says who answered and how; the window is told about every stage; the model ran once for the plan and once for the card with the right key and nothing else was reached. The third case runs the scenario again on a brand new database to prove it can be re-run.

Checked by mutation on Nov 25, 2026: 7 deliberate breaks in the product code (cards never pushed to Telegram, the purchase made routine, the tool run not audited, a rejection still running the tool, the end of a resumed run not announced, a tap recorded as a dashboard answer, the card not announced to the window), all caught.

**Found by the gate:** after the founder's tap, nobody told them how the run ended (`/goal` only reports the first stage), so a purchase could happen with no message afterwards. Fixed with `onRunFinished` in the orchestrator service (8 new `orchestrator-service` cases) and `announceRun` in the bot (2 new `telegram-bot` cases): the end of a resumed run is announced once, only when it ends done or failed (never for a run that pauses on another card), with the same honest summary and any text a task produced.

### skills-loader

Suite: `.claude/evals/suites/skills-loader.js`. Code under test: `src/runtime/agents/skills.js` (`loadSkills`, `skillsText`, `CHARTER`).

**Cases:** 10

Covers: shared skills first then the team's own, never another team's; a team name cannot reach any other folder; a skill with a wrong name, no description, no body, no frontmatter or too long is skipped with a note while the good ones stay; a folder that is a link is skipped; a missing or odd folder gives no skills and never throws; the total is capped (shared skills are the last to be cut); the text built for an agent keeps the order and is cut to a limit; and the skills that ship load clean.

### agent-loop

Suite: `.claude/evals/suites/agent-loop.js`. Code under test: `src/runtime/agents/agent.js` (`createAgent`). A scripted model, the real policy and the real tool loader.

**Cases:** 20

Covers: one JSON action per model call (a tool, or finish); the first prompt holds the role, the skills, the team's tools and the task; a tool result comes back fenced as data; a tool the team does not have, or nobody has heard of, is not run and the agent is told; **an action the policy says needs the founder is never run: the agent stops and hands the request back**; step and token caps and clamped limits; garbage answers are steps and three in a row fail the run; a model that cannot be reached stops the run without throwing; a tool run is audited before it runs as this agent and an audit failure stops the run; secrets never reach a prompt, the audit log or the output; a failing tool's own text is never shown; long results and outputs are cut; the task and feedback are data in random fences; a bad task never throws or calls the model; the lead uses the strong tier and the sensitive setting reaches the router; one run uses one router task id.

### team-framework

Suite: `.claude/evals/suites/team-framework.js`. Code under test: `src/runtime/agents/lead.js`, `team.js` and `index.js` (the factory). Real Postgres with the real migrations: the `tasks`, `agents` and `audit_log` rows are real. The model is scripted; the policy, tool config, skills and tool loader are real.

**Cases:** 25

Added Nov 26, 2026: **the lead is told which tools its workers really have** (the same list the worker sees, in both the plan and the review) **and to judge the substance, not the format**: it rejects only for work not done, a wrong or unknowable fact, a guess about money or a person, a promise or price nobody gave, or a secret. Checked by mutation: leaving the tool list out was caught.

Added Nov 26, 2026: **an agent shows as working while it plans, works or reviews and idle again after, whatever happens** (including when the task ends blocked), and a paused agent is never overwritten. It is a display hint that can never stop a task. Checked by mutation: never marking an agent working was caught.

The step 2.1 "done when" is the first two cases: a team of one lead and one worker completes a task (queued, in_progress, in_review, done, with the lead's review before done), and **the lead rejects a bad worker output once, the worker tries again with the feedback in its prompt, and the task is done**. Also: rejected twice blocks the task with a reason and it is never done; a review that is not a plain `accept: true` (yes, "true", 1, `{}`, garbage, no answer) counts as a rejection; zero allowed revisions blocks at the first rejection; a plan naming an unknown worker, empty, too long or garbled runs no worker and blocks the task; a two-subtask plan runs in order and stops at the first block; a worker that needs the founder blocks the task and hands the request back, a worker that stops or fails blocks it with a plain reason; every status change is audited before it is made and an audit failure leaves the status where it was; the audit log has the task from creation to done in order; agents are registered once with the right role and tier; a task with no or an odd title is refused with no row and no model call; a secret in a task is never stored or logged. The factory: builds a team from `shared` plus its own tools and skills and no other team's, refuses to build without the company charter, refuses unknown teams and odd names, reports config problems, never gives a team a tool with no policy rule, and passes its limits to every agent.

Checked by mutation on Nov 25, 2026: 14 deliberate breaks (a task done without the lead accepting, a truthy review counting as yes, status changes not audited, an unknown worker allowed in a plan, a crucial action run instead of handed back, the tool run not audited first, no step cap, tool output and final output not cleaned of secrets, no charter required, another team's tools loaded, the feedback not sent back, unlimited revisions, any team name reaching a folder), all caught.

**Per-team limits (Nov 26, 2026), 1 new case:** a team can ask for its own `maxSteps` and `maxTokens`, which replace the factory's for that team only; a huge value is held to the absolute cap of 20 steps, and a bad one (text, a negative number, a list) is ignored so the factory's own limit stays.

### outbound-review

Suite: `.claude/evals/suites/outbound-review.js`. Code under test: `src/runtime/outbound/review.js` (`checkMessage`, `createReviewer`) and `settings.js` (`parseApprovalUntil`, `approvalRequired`). A scripted model.

**Cases:** 15

Covers: **code checks that cannot be argued with** (one recipient, a one-line subject, a body of sensible size, nothing that looks like a key, no unfinished placeholder text such as `[Name]` or `TODO`); a message that fails them never reaches a model. The **model review can only make it stricter**: only a plain `"pass"` passes, `escalate` means the founder must decide, and an odd answer, `PASS`, `true`, a pass that lists problems (a contradiction), no answer or a model that cannot be reached is a **fail**. The message is data in a random fence and the review is told what to look for (promises, legal or public statements, keys, claiming to be human). **The founder-approval setting fails safe**: `OUTBOUND_FOUNDER_APPROVAL_UNTIL` unset, empty, garbled or in the future means the founder approves every message; a date on its own means the end of that day in India; only a date that has clearly passed ends the period.

### outbound-gate

Suite: `.claude/evals/suites/outbound-gate.js`. Code under test: `src/runtime/outbound/service.js` (`createOutbound`) and `tools.js` (`email.submit`, `email.send`), the table `outbound_messages` (migration `20261125000000_outbound_messages.sql`). Real Postgres with the real migrations; the policy, decisions service, runtime event bus and reviewer are real (its model is scripted); the mail transport is a fake that records what it is asked to send.

**Cases:** 24

Added Nov 26, 2026: **one email at a time for one address from one team.** A second email to an address (any letter case) that already has one waiting for the founder, or approved and not yet sent, is refused with the first one's message id and nothing is written, reviewed or audited; another team, another address, a sent, rejected or cancelled earlier message, and an earlier draft that failed review do not block; and if the waiting messages cannot be checked the answer is an error and nothing is written. Every case now starts from empty message tables (a restart case keeps them). Checked by mutation: turning the rule off was caught here and in `sales-team`.

The step 2.2 "done when": **a drafted email cannot be sent without passing review, and the setting forces a decision card.** A message that was never reviewed, or whose review failed, can never be sent. With no end date set (or one in the future) a reviewed email files a card (category legal or public, the email text under "Show details") and is not sent; approving the card makes it ready and the STORED text is sent exactly once; rejecting it means it is never sent; answering a second time changes nothing. Once the period is over a passing review is enough and no card is filed, except when the review itself says the founder must decide. A card that cannot be written cancels the message. An approval given while the app was closed is applied on start. Sending twice at the same moment sends once; a failing mail transport leaves `send_failed` and is never retried; with no mail account nothing is sent. Every step is audited before it is made, in order, and the audit log never holds an address or a body (only the recipient's domain). The email tools take the team from the run, never from the model.

The database enforces the same rules (5 cases in `database-schema`): the table is service-only; the content is fixed and the database computes its hash; a message becomes `ready` only with a passing review and, when approval is required (the setting, or a review that says it must go to the founder), an APPROVED decision; it is `sent` only after `sending`; one recipient, a one-line subject and a sensible size. The invariant `only-the-outbound-service-touches-the-outbound-messages-table` keeps any other module (a future Gmail tool) from writing to the table.

Checked by mutation on Nov 25, 2026: 15 deliberate breaks in the service, review, setting and migration; 14 caught outright, and the 15th (ready straight from drafted) is a redundant check, because the "approved decision" rule refuses the same case.

### goals-view

Suite: `.claude/evals/suites/goals-view.js`. No dataset. Code under test: `src/renderer/goals.mjs`: plain functions with no React and no `window`. The Goals panel (`GoalsPanel.jsx`) only draws what they return.

**Cases:** 27

Why it exists: a goal sent from the phone used to be invisible in the window (only decision cards were shown), so there was no sign it was being planned, had finished, or had failed. Contract: `goalView(summary)` and `shouldRefetch(event)`; a summary is one entry of the runtime's `goals.list`.

| Group | Cases | What it checks |
|---|---|---|
| Status | 8 | A goal being planned says so and is active; one waiting on a card points to the queue; a finished goal says finished; a finished goal with blocked or failed tasks says "Finished, but N tasks did not go ahead" and is never plain "Finished" (a task you rejected does not count); a goal that could not start shows the runtime's own plain message; every failure reason has a plain explanation even without a message; a run that stopped part-way says so and warns an action may have happened; a goal that cannot be found says so |
| Tasks | 5 | Done tasks, the waiting one and those still to come; the task being worked on; every outcome has a label and a tone (the wording is always there, never colour alone) and an unknown outcome is not blank; an approved task for an unknown tool says it did not run; results are matched to tasks by id, not by position |
| Text and odd input | 4 | A goal with no text yet gets a placeholder; text is passed through, never turned into markup; odd input never throws and always gives text; the summary is never changed |
| Refreshing | 2 | A new run, a pause, a finish, a failure and the runtime becoming ready refresh the list; unrelated and malformed events do not and never throw |

**Downloads (8 cases):** a goal with no files has no download; one file is downloaded as itself with its exact content; several files are one `.zip` named after the goal; only files of tasks that actually ran are offered; two files with the same name both survive (`script.py`, `script (2).py`); odd or unsafe entries are never offered and never throw; a name with a path is reduced to a plain name; a goal still working offers the files made so far. 4 more mistakes were introduced and caught.

Checked by mutation on Nov 24, 2026: 8 mistakes were introduced one at a time (a failed task reported as plain "Finished", a blocked task not counted, results matched by position, the runtime's message ignored, a part-way stop looking like a normal failure, a decision event refreshing the list, a start event not refreshing, a running goal not marked active). All 8 are caught (the first run missed one: a test used a message identical to the fallback wording, so it was made to differ).

**Checked in the real window on Nov 24, 2026** (the built Electron app, a seeded local database, goals made by the real orchestrator code): 10 of 10 checks passed with no console errors: the five newest goals show first; a goal waiting on a decision shows its done task and its waiting task; a goal that finished with a blocked task says so honestly; a goal that failed at planning is still shown with its reason; older goals sit behind a button; and a goal made while the window was open appeared by itself, newest first, with the announcements batched into one read. This driver script is not in the repo, so the window is not covered by `npm test`.

### orchestrator-model

Suite: `.claude/evals/suites/orchestrator-model.js`. No dataset. Code under test: `src/runtime/orchestrator/model.js`. **No model is called:** the router is a fake with scripted replies, so what is graded is everything around the model: what it is told, what it is not told, how its answer is read, and that a bad or hostile answer can only ever become an error.

**Cases:** 26

Contract: `createModelPlanner({ router, listTools })`, `createModelCardWriter({ router })` and `buildToolCatalogue({ rules, policyTools })`. Both model calls ask the strong tier with `sensitive: false` (hosted providers may see the goal and the card facts, as the router's defaults allow; secrets in arguments are removed first), and each call gets its own router task id.

| Group | Cases | What it checks |
|---|---|---|
| Planner: what it is told | 3 | The strong tier, the goal and the tool list in the prompt (each tool shown with whether it always asks the founder); the goal is fenced as data with a fresh marker the goal cannot guess; a new router task id every call |
| Planner: reading the answer | 10 | A clean JSON array becomes tasks keeping only title, tool, access and args; an array inside a code fence and chatter is still read; items already shaped with an `action` are accepted; claims of approval and any other extra field are dropped; an empty plan comes back empty (the graph then says "nothing to do"); anything that is not a JSON array is an error; a 150 KB answer is refused; a router failure or throw is an error with none of its text; a blank goal never reaches the model |
| The tool list | 2 | Built-in tools plus the founder's ACTIVE additions only (a proposal not yet confirmed is left out); if the founder's table cannot be read the built-in tools are used |
| Card writer | 11 | A good first draft becomes the card; the strong tier with the writer's instructions and the facts; a secret in the arguments never reaches the prompt; a draft the checker rejects is sent back with what was wrong and then accepted; a writer that never passes gives up after three tries with no card; an answer that is not JSON, or a failing router, counts as a try and never carries its text; extra fields such as `approved` never reach the card; a card for an unknown tool tells the model the tool is not in the policy table and that approving it does not run it; the request is fenced as data; a new router task id every call |

Checked by mutation on Nov 24, 2026: 10 mistakes were introduced one at a time (approval claims kept, secrets in the prompt, a fixed fence marker, the router's message passed on, an unconfirmed tool offered, a single try, the unknown-tool warning dropped, a huge answer accepted, a blank goal reaching the model, the sensitive flag flipped). All 10 are caught.

Checked live on Nov 24, 2026 (local stand-in database, Claude Code provider, no Telegram): the goal "Buy the domain mylaunch-demo.example" produced one `namecheap.purchase_domain` task, a card that passed the plain-language checker on the first try (it said the price was not given, rather than inventing one, and noted that `.example` names cannot be registered), a pause, and, after a rejection, a finished run. Judgment call to confirm: a card for a spend with no price shows the model's honest "price not confirmed" in the cost field, with an example figure in brackets; the checker requires rupee and dollar numbers there.

### orchestrator-service

Suite: `.claude/evals/suites/orchestrator-service.js`. No dataset. Code under test: `src/runtime/orchestrator/service.js`. It runs against the REAL audit log and checkpoint store on a real Postgres with the real migrations (`scripts/fake-supabase.js`), one fresh database per case; the decisions service is a small fake and the policy is the real one.

**Cases:** 33

Contract: `createOrchestratorService({ store, rawAudit, decisions, policy, runtime, planner, writeCard, runTool, onError? })` returns `submitGoal`, `status`, `start()` and `stop()`. A run that files a card writes an `orchestrator.waiting` audit entry (target = the decision, detail = the run's thread id); that is how an answer finds its run again, with no new table.

| Group | Cases | What it checks |
|---|---|---|
| Linking | 1 | A paused run leaves an audit entry linking the decision to the run |
| Resuming | 6 | An approval event resumes the run and runs the spend; a rejection event skips it; an event for a decision no run waits on, or with no id, does nothing and never throws; the same answer delivered twice (even at once) runs the tool once; two waiting runs resume independently; an answer that came **before** the run finished pausing is applied right after |
| Recovery | 4 | A card answered while the app was closed resumes its run on start; a run still waiting stays waiting; a finished run is never run again by recovery; recovery that cannot read the audit log reports it and does not throw |
| Starting and stopping | 3 | `start` listens for answers and `stop` stops; starting twice listens once; after `stop` an answer does nothing |
| Passing through | 2 | A bad goal or a failed plan comes back as a failure with no error text; the audit log holds only ids, never the goal or the card |

Checked by mutation on Nov 24, 2026: 8 mistakes were introduced one at a time (answers ignored, recovery that does nothing, no unsubscribe on stop, subscribing on every start, a fast answer not applied after pausing, the link entry losing its target, an unchecked id looked up, the goal written into the audit entry). 7 are caught; the eighth is an equivalent change, because the runtime keeps listeners in a set and adding the same function twice changes nothing.

**The window's list of goals (Nov 24, 2026):** 9 new cases. Submitting a goal first records an `orchestrator.goal_submitted` audit entry holding only the thread id (never the goal), and if that cannot be recorded nothing is planned; a refused goal leaves no entry; `listGoals` returns recent goals newest first with the goal, status and tasks; a goal still being planned is listed as running with its text; a goal that failed at planning is still listed with its reason; the list shows the final state after you answer; the limit is honoured and capped at 50; and a run that cannot be read is listed as failed while the others still appear.

### database-schema

Suite: `.claude/evals/suites/database-schema.js`, with its test database in `.claude/evals/db.js`. No dataset: the two-pod fixture is in `db.js`. Code under test: `supabase/migrations/*.sql` and `supabase/seed.sql`.

**Cases:** 38

Added Nov 26, 2026 (step 3.3): **a project's GitHub repository** (`projects.github_repo`) must look like owner/name with no folder-like part (`..`, `.`), and once set it can never be pointed at another repository or removed (it can be set once, from empty), so a pod's pull-request tools cannot be redirected by anything that can write a project row.

Added Nov 26, 2026 (step 3.2): **every table that holds a pod's rows is found from the database itself** (every table with a `pod_id` column) and must be in the list the isolation cases attack, and each such table, and the pods, projects, clients and agents tables a pod may see, must have a read rule that is keyed on the pod in the token. A new table with a `pod_id` column fails here until it is added to the list. Checked by mutation: taking `pod_members` out of the list was caught.

Two cases (added Nov 26, 2026 for step 3.1) cover how a pod is opened: a pod that names a decision needs an approved `pod.create` decision (a pending, rejected, other-kind or missing one is refused, and one decision opens only one pod; a pod with no decision, as in the dev seed, is still allowed), and what a pod was opened for (its project, kind, decision and time) cannot be changed and a closed pod stays closed.

Three of these cases (added Nov 25, 2026 for step 2.4) cover the `tickets` table: it is service-only and invisible to a pod; a ticket starts open, what the customer wrote cannot be changed, and a bad address, a line break in the subject or an oversize text is refused; a ticket only moves forward (open, in progress, answered or escalated, closed), is `answered` only with its reply message and `escalated` only with a decision, those links cannot be swapped or removed, and a ticket is never deleted.

How it works: the migrations are applied, in filename order, to a real Postgres running inside the test (PGlite, which is PostgreSQL 18, with pgvector). It is dressed like Supabase: the `anon`, `authenticated` and `service_role` roles, an `auth.jwt()` that reads the request's claims, and Supabase's default grants (which the migrations must take back). A fixture creates two pods with rows in every table. Each case then acts as someone specific (a pod agent with a `pod_id` claim, no claim, `anon`, the runtime's `service_role`, or the table owner) and tries things, always inside a transaction that is rolled back. Attack cases include a positive control (the same action on the pod's own data must succeed) so a case cannot pass just because everything is blocked. The contract (tables and columns the fixture inserts into) is in the header of the suite file.

Limits: this proves the policies and rules, not that they apply to your real project. It uses a stub of Supabase's `auth.jwt()`, and PostgreSQL 18 where Supabase currently runs an older version. Applying the migrations to the real project is checked separately (`npm run check:db`).

| Group | Cases | What it checks |
|---|---|---|
| Schema | 5 | Migrations apply to an empty database; all 14 core tables exist; row-level security is on for every public table (a future table without it fails this); `anon` has no privileges on any table; `memory.embedding` is a 768-dimension `pgvector` column and nearest-neighbour search works |
| Reading | 5 | A pod reads only its own rows in six tables; sees only its own pod and project; sees only its own project's client; sees only its own members plus shared specialists; a request with no pod claim sees nothing anywhere |
| Writing | 6 | A pod, a request with no pod claim and `anon` cannot read or write the two graph checkpoint tables, while the runtime can (added in step 1.7b). A pod cannot write into, or move rows to, another pod; cannot approve its own request, including a fully forged approval; cannot read scaling rules or touch the audit log; cannot delete its rows; **a pod, a request with no pod claim and `anon` cannot read or write the policy table** (the runtime can) |
| Runtime | 1 | The runtime's `service_role` sees everything |
| Integrity | 7 | The audit log is append-only even for the table owner (update, delete, truncate); a resolved decision is frozen; a decision's content (card, action, category, pod, amounts) cannot change after filing; approved or rejected needs a resolver and a time; a card needs all seven fields; **a policy rule is fixed once it exists (tool, kind, category, access) and cannot be deleted, a removed rule stays removed; a rule must be well formed (an ask rule has a category and no access tag, a routine rule the reverse, lower-case ASCII names, no agent as proposer, no active rule nobody confirmed) and a tool has one live rule at a time, though a removed tool can be proposed again** |
| Seed | 1 | The seed creates exactly one fake pod and one fake agent, all labelled `[seed]`, and can run twice without duplicating |

Checked by mutation on Nov 21, 2026: 8 realistic mistakes were each introduced into the migrations one at a time (a policy that lets everything through, a missing append-only trigger, pods allowed to update decisions, row-level security off on one table, `anon` grants not revoked, the decision-freeze trigger removed, pre-approved requests allowed, the card-field check removed). All 8 were caught. The first run missed "pods allowed to update decisions" because the attack was too weak; the attack was strengthened.

### runtime-core

Suite: `.claude/evals/suites/runtime-core.js`. No dataset; each case is a check function with an in-memory fake store that records every call. Code under test: `src/runtime/config.js`, `audit.js`, `runtime.js`, `commands.js` and `src/ipc-guard.js`.

**Cases:** 37

Added Nov 26, 2026: `teams.startFinance` and `teams.startEngineer` (graded in `team-tasks`) are two more commands in the exact-command-list case.

Added Nov 26, 2026 (step 4.3): `audit.search`, `settings.get`, `settings.setLimits` and `settings.setScaling` (graded in `audit-search` and `settings-page`) are four more commands in the exact-command-list case.

Added Nov 26, 2026 (step 3.6): the project files panel adds eight commands (`files.pods`, `files.tree`, `files.read`, `files.history`, `files.beginEdit`, `files.endEdit`, `files.save`, `files.upload`), so the exact-command-list case now lists them; their own behaviour is graded in `pod-files`.

Added Nov 26, 2026: **teams.startLead and teams.startTicket** (the Teams page starts a team) only start the job and answer at once, check their arguments (a bad one is refused before anything is recorded or run), and record the company and only the DOMAIN of an email address in the audit log; without a jobs service they say not available, a refusal keeps its code (busy, invalid lead), and a failure is generic.

Contract: the full contract (function signatures, error codes, the store interface) is in the header of the suite file. Nothing here touches Electron, the network or a real database, so it runs in milliseconds. The Electron wiring (`src/main.js`, `src/ipc.js`, `src/preload.js`) is covered by the `invariants` checks, and by launching the real app (see PLAN.md step 1.2).

| Group | Cases | What it checks |
|---|---|---|
| Config | 4 | Both Supabase settings are required and problems name the setting, never the value; a URL that is not `*.supabase.co` or local is rejected, so the key can't be sent elsewhere; the printable description hides the key |
| Audit | 3 | Secrets in an entry (by field name, and by value shape: Groq, Anthropic, Supabase, JWT, Telegram) are redacted before writing; an invalid entry is refused and writes nothing; a valid entry becomes one `audit_log` row with the right columns |
| Command bus | 11 | Unknown commands are refused and not logged; **a command can choose which of its arguments the audit log keeps (a broken chooser records nothing rather than everything)**; malformed or oversized arguments are refused before anything runs; **the audit entry is written before the handler runs; if it cannot be written the handler never runs**; a crashing handler returns a generic message (no internals, no secrets) and the failure is audited; `CommandError` passes its code through; never-audited commands (status) skip the log and work without a database; events reach subscribers, with a wildcard, and a bad listener breaks nothing; a stopped runtime refuses everything; a blocked runtime refuses actions but still answers status |
| Commands | 6 | Exactly the four planned commands exist; `decisions.list` defaults to pending, caps the size and rejects bad options; `decisions.resolve` calls the decisions service as `dashboard` (the caller cannot pick the channel, a `via` is refused), passes its answer through, lets its plain errors reach the window, keeps other errors generic and answers `not_available` with no service; **the dashboard answer records that there was a note, not what it said, in the command audit entry**; `agents.pause` validates its arguments and, with no agent service, answers `not_available` and changes nothing (step 3.7 built the real one; it is graded in `agents-panel`); status reports the database state without leaking the error |
| IPC guard | 2 | Only the app's own page (the built `index.html`, or the dev server's exact origin in dev only) is trusted; payloads must be a plain command name with plain-object arguments |

Checked by mutation on Nov 21, 2026: 8 realistic mistakes were introduced into the runtime one at a time (audit failure no longer blocking, internal errors leaking, redaction off, any file URL trusted, argument checks removed, status audited, a stopped runtime still accepting commands, the dev server trusted in production). All 8 were caught.

**`goals.list` (Nov 24, 2026):** the window gets one more read-only command, so the exact-command-list case is now `the-runtime-registers-exactly-the-planned-commands` and lists five. 4 new cases: it returns the orchestrator's goals and limits the size (1 to 50, default 20); with no orchestrator it says "not available"; a failing orchestrator gives a generic error that carries none of its text; and it is audited like any other command.

### decisions-service

Suite: `.claude/evals/suites/decisions-service.js`. No dataset; each case is a check function. Code under test: `src/runtime/decisions.js`. Unit tests (`src/runtime/decisions.test.js`, 19 tests, and three end-to-end tests in `runtime.integration.test.js`) back it up against an in-memory store that adds delays between every step.

**Cases:** 35

Added Nov 26, 2026 (step 3.1): **`listApproved({ tool, limit? })` gives the approved cards of one tool, newest first, and writes nothing.** The pods service uses it to find a pod card answered while the app was closed, so it never reads a decision's status itself (an invariant keeps those inside this service).

How it works: the cases run the service against a **real Postgres with the real migrations** (`scripts/fake-supabase.js`: PGlite behind real HTTP, using the runtime's own REST store), so the integrity triggers are live and "two answers at once" is two real concurrent requests. Each case starts from an empty `decisions` table and logs every write, so it can check the order (audit first) and that a refused call wrote nothing. The full contract (`create`, `resolve`, `cancel`, `get`, `remindDue`, `DecisionError`) is in the header of the suite file.

| Group | Cases | What it checks |
|---|---|---|
| Filing | 9 | A decision is filed `pending` and audited first; the category comes from the policy check and the caller cannot set a category, status or resolver; an action the policy allows needs no decision; a card the checker rejects is refused and the stored card is the checked copy; an unknown tool is filed as `unknown`; nothing is written if the audit log is down; bad input is refused before anything is written |
| Answering | 13 | Approving records who and when; **the phone and the dashboard answering at once take effect once** (six rounds); approve against reject at once, and a burst of ten, leave one winner and everyone is told the truth; answering again changes nothing; a final decision cannot be flipped; "ask more" then decide works, and asking twice changes nothing; an unknown id is "not found"; bad input and channels other than the founder's two are refused; the audit entry comes before the write; nothing is written if the audit log is down or the runtime is blocked; a key or token pasted into a note or card is not stored |
| Cancelling | 2 | A cancelled decision stays closed; cancelling a decided one changes nothing |
| Live screens | 1 | The live event stream hears about a new and a decided decision exactly once, with no card text |
| Reminders | 7 | A reminder never changes a status, a resolver or a time of answer; it waits for the interval; it stops at the limit and the card stays waiting; only waiting cards are chased; two runs at once remind once; a failed notification gives its claim back so the next run retries; a deadline passing does not approve |

Checked by mutation on Nov 23, 2026: 35 realistic mistakes were introduced into `decisions.js` one at a time (no compare-and-set guard, conflicts never or always reported, every caller told it changed something, an answer or a cancel allowed from a final status, the caller allowed to choose the category, an allowed action still filed, the card unchecked or stored raw, the audit entry optional or written after the write, any channel or an `agent` channel accepted, unknown options accepted, a blocked runtime still answering, an unknown id looking fine, a pasted secret stored, money unvalidated, a duplicate answer announced, card text in an event, a non-atomic reminder claim, a failed notification or an unauditable reminder keeping its claim, the reminder limit or interval ignored, a reminder that approves past a deadline, an overlapping or app-pinning reminder job). All were caught by the eval, the unit tests or the invariants, except one that is an **equivalent mutant**: making the reminder query return answered decisions changes nothing, because the reminder claim is itself guarded by `status = 'pending'`, so the rule is protected twice. Two things went wrong along the way and were fixed: the harness also ran the `invariants` suite, which was failing for an unrelated reason (this file was behind), so every result looked "caught" (the run was stopped, this file updated, and a "baseline must be clean" check added before any mutation); and one mutation's edits overlapped and did not apply, so it was re-run on its own.

**Read-only lists for autoscaling (Nov 26, 2026), 1 new case:** `listWaiting({ tool })` (the cards still waiting) and `listDeclined({ tool })` (the ones the founder said no to, newest answer first, with `answeredAt`) sit beside `listApproved`, so a caller never has to read a decision's answer fields itself; both refuse a missing tool, and refuse while the runtime is blocked.

### policy-tools

Suite: `.claude/evals/suites/policy-tools.js`. No dataset; each case is a check function. Code under test: `src/runtime/policy-tools.js` and the merge in `src/runtime/policy.js` (`createPolicy`, `customRulesFrom`); the table is `policy_tools` (migration `20261123000000_policy_tools.sql`). Unit tests (`src/runtime/policy-tools.test.js`, 16 tests, with delays injected between every step) and two end-to-end tests in `runtime.integration.test.js` back it up.

**Cases:** 22

Why it exists: on Nov 23, 2026 the founder asked that the policy table be editable from Telegram. The built-in rules stay in code and cannot be changed from a phone; the tools the founder adds live in the database and are merged in, and a built-in rule always wins. Adding a tool as "always ask me" (with a category) is active at once because it cannot loosen anything; adding it as "routine, no need to ask" is only proposed until the founder confirms it; removing a tool is immediate. The Telegram commands are step 1.8; these cases grade everything underneath. Like `decisions-service`, the cases run against a real Postgres with the real migrations, so the triggers are live and "confirm from the phone and the dashboard at once" is two real requests. The full contract is in the header of the suite file.

| Group | Cases | What it checks |
|---|---|---|
| Adding and removing | 5 | An always-ask tool takes effect at once with its category; a routine tool is only proposed, and unknown to the policy, until confirmed; a routine tool is allowed only with exactly its tag, whatever the free text says; removing takes effect at once; cancelling a proposal leaves the tool unknown and it cannot be confirmed afterwards |
| Built-in rules win | 1 | A built-in tool cannot be added (in any letter case) or weakened, and a rule planted straight into the database for one is ignored: the payout is still "spend" and a production deploy is still "launch" |
| Input | 3 | Names are trimmed and lower-cased and must look like `server.tool` in ASCII (look-alike letters, zero-width characters, no dot, spaces and 250-character names are refused); bad kinds, categories, tags, channels, notes and extra options are refused before anything is written; an unknown rule is "not found" and writes nothing |
| Races | 3 | Proposing the same tool twice is safe and a different rule is refused; confirming from phone and dashboard at once takes effect once; confirming and cancelling at once leave one winner, and the policy agrees with the stored rule |
| Audit and safety | 4 | Every change is audited first, by the founder, without the note text, and a pasted key in a note is not stored; nothing is written if the audit log is down; a blocked runtime edits nothing; the live screens hear about each change once, without the note |
| Restarts and other services | 6 | Rules survive a restart and proposed ones stay out of effect; a failed reload drops every custom rule and keeps the built-in ones; **a change that was saved is reported as saved (`inEffect: false`, plus a `policy.degraded` event) when only the reload after it fails, never as an error, while a write that really fails is still an error and saves nothing; once the database answers again the saved rules take effect**; the exported built-in check is not changed by additions; the decisions service uses the live policy (an added tool gets its category instead of "unknown", a confirmed routine tool needs no decision, a removed one is unknown again); the list shows live rules only |

Checked by mutation on Nov 23, 2026: 28 realistic mistakes were introduced into `policy-tools.js` and the merge in `policy.js` one at a time (a routine tool going live without a confirm, a built-in tool that can be added, confirm not guarded by the status, the audit entry optional, any channel allowed, a pasted secret stored, the note in the audit log or an event, names not normalised, a failed reload keeping stale rules, the policy not reloaded after a change, a blocked runtime still adding tools, unknown options accepted, cancel removing an active rule, a lost race not called a conflict, the founder's rule beating a built-in one, rows for built-in tools or merely proposed rules trusted, rubbish accepted as the rules, the unknown category allowed, a second grant site in `policy.js`). 25 were caught on the first run. Of the three misses, two were real gaps in the tests and are fixed: the lookup's own "built-in first" guarantee was hidden behind `customRulesFrom` dropping those rows (now tested on its own), and a fake rules object that would have been refused for the wrong reason (now one that would be allowed if trusted). The third is an **equivalent mutant**: the lookup of the founder's rules is never called for a built-in tool because the built-in lookup short-circuits first, so a failure there cannot change a built-in answer.

Fixes checked by mutation on Nov 23, 2026 (the reload-reporting change in `policy-tools.js`, the `auditArgs` option in `runtime.js` and `commands.js`, and the `.env.example` rule): 19 realistic mistakes were introduced one at a time (a failed reload thrown as an error again, `inEffect` always true or always false, a failed reload not remembered or never cleared, the degraded event not sent, a repeated request ignoring that the policy is behind, stale rules kept after a failed reload, the reload not reported by confirm or remove, a failed write swallowed, the audit chooser ignored, a broken chooser recording everything, the chooser changing what the handler receives, a non-function chooser accepted, the dashboard answer logging the note again, the access-token line deleted, a setting renamed in the example). 18 were caught on the first run; the miss (a chooser that is not a function accepted at registration) is now a check in the `runtime-core` case and is caught.

### search-tool

Suite: `.claude/evals/suites/search-tool.js`. Code under test: `src/runtime/tools/search.js` (a network stand-in that records every request).

**Cases:** 8

Covers: no key means no tool; the tool is read-only with a built-in policy rule (a write access is refused); one POST to Tavily's fixed address with the key in one header (never in an address), a body holding only the fixed settings (a query cannot add its own) and no redirect followed; results are one plain line each (markup removed, only web addresses kept); an empty or odd reply says "No results."; a bad argument (empty, too long, a control character, a bad count, an extra argument such as an address) never causes a request; the count defaults to five and the text is cut to a limit; a failure is one plain sentence that never shows the key or the service's own text. Checked by mutation on Nov 25, 2026: letting the request follow redirects, asking Tavily for page text, and moving the key into the address were each caught (Nov 25, 2026, after the switch from Brave).

### crm-tools

Suite: `.claude/evals/suites/crm-tools.js`. Code under test: `src/runtime/tools/crm.js`, on a real Postgres with the migrations (the `clients` table).

**Cases:** 10

Why it exists: the store uses the service key, which bypasses row-level security, so these tools are the only protection for client records. Covers: both tools with the right tags and policy rules, and none without a usable store; a new lead is saved with status `lead` and a lower-case email, then found; the same email saved again updates that lead and never adds a row; a lead without an email is matched by its exact name; **a client who is active or past is never shown, changed or duplicated**; no argument can set a status, an id or a date; bad arguments change nothing; a secret in the notes is removed; a name search ignores case and shows at most twenty; a database failure is one plain sentence. Checked by mutation on Nov 25, 2026: removing the lead-only filter was caught.

### google-tools

Suite: `.claude/evals/suites/google-tools.js`. Code under test: `src/runtime/tools/google.js` (a Google stand-in that records every request).

**Cases:** 11

Why it exists: the founder chose "drafts only, no send yet" for Gmail. Covers: four tools with the right tags and policy rules, and none unless all three settings are given; the access token comes from the refresh token, is kept until a minute before it ends, then fetched again; every request goes to one of Google's three addresses with the token in one header and no redirect; Gmail search lists then reads each message's headers; **a draft goes into the Drafts folder, is built from the checked message and is never sent**; a draft the outbound check would refuse (two addresses, a key, a placeholder, a line break in the subject) is refused with no request; **the source contains no send call at all**; Drive search escapes quotes; Drive save is one private multipart upload with a plain file name; a bad name, text or search causes no request; a failure is one plain sentence that shows no token and no text from Google. Checked by mutation on Nov 25, 2026: removing the draft's message check was caught.

### sales-team

Suite: `.claude/evals/suites/sales-team.js`. The step 2.3 "done when", on a real Postgres with the migrations. Real: the agent factory and team framework, the repository's tool configuration and skills folders, the policy, the tool loader, the CRM tools, the outbound gate and the decisions service. Scripted: the model, the review agent's verdicts, the card writer, and Tavily and Google.

**Cases:** 11

Added Nov 26, 2026: **when the lead sends the writer back, the founder still ends up with one email and one card for the company** (the writer's second `email.submit` is refused as a duplicate). The suite now gives workers the same limits as the app (10 steps, 60,000 tokens).

Covers: **a lead goes from research to a saved lead (status `lead`) to a drafted proposal to a waiting founder card, the task is done, and nothing is sent to the client or from Gmail**; every tool run is recorded as the agent that did it; a proposal the review fails never gets a card and only the rewritten one does; a crucial action (a signature request) stops the agent, becomes a pending decision in the right category, and the task is blocked; if that card cannot be made the result says so; a lead with a bad detail runs nothing and asks no model; a team without the charter is not built; the team's tools are exactly the files list, each with a built-in rule, none that needs the founder, and `email.send` is the only one that sends; its skills are the shared ones plus its own five and no other team gets them; the worker's prompt lists the team's tools and skills and fences what it found as data. Checked by mutation on Nov 25, 2026: treating a failed review as a pass was caught.

### ticket-tools

Suite: `.claude/evals/suites/ticket-tools.js`. Code under test: `src/runtime/tools/tickets.js`, on a real Postgres with the migrations (the `tickets` table and its rules). The outbound service is a stand-in whose `get` gives the view each case chooses; the message rows are real (a ticket's reply is a foreign key).

**Cases:** 9

Why it exists: the store uses the service key, which bypasses row-level security, so these tools are the only protection for customers' tickets. Covers: both tools with the right tags and policy rules, and none without a store and the outbound service; a ticket can be read only while a team has it in progress (before and after, and for an unknown id, it says there is no such ticket); an answered ticket can no longer be read; a long customer message is cut, and a bad or injected id, a missing field or an extra argument never reaches the database; a ticket is answered with a reply that is awaiting the founder, ready or sent (the address matched without regard to case) and the link is recorded; **a reply for another customer, from another team, a draft, a failed review, a rejected, cancelled or failed message, or a message that does not exist never answers a ticket**; a ticket that is not in progress cannot be answered and an answered one is not answered twice; the reply is checked through the outbound service and the tool never reads the messages table; a database failure is one plain sentence. Checked by mutation on Nov 25, 2026: removing the customer-address check was caught.

### support-team

Suite: `.claude/evals/suites/support-team.js`. The step 2.4 "done when", on a real Postgres with the migrations. Real: the agent factory and team framework, the repository's tool configuration and skills folders, the policy, the tool loader, the ticket tools, the outbound gate and the decisions service. Scripted: the model, the review agent's verdicts and the card writer.

**Cases:** 14

Added Nov 26, 2026: **a question the team cannot answer from what it knows becomes a card** (`question.escalate`, an always-ask rule with no tool, in the legal or public category) instead of a holding reply the review refuses; the customer is written nothing, the ticket is marked escalated, and the founder's follow-up says so whatever they tap. The skills no longer tell the team to promise a follow-up.

Added Nov 26, 2026: **answering a refund, discount, complaint or legal card gives the founder a plain follow-up** (`describeAnswer`): what they decided, that nothing was done (there is no payments tool and nothing that writes to the customer), that the customer has heard nothing, and what is left for them to do; only for the card the ticket is escalated on, never repeating the customer's message, and with control characters and keys removed. Checked by mutation: following up for any card that names a ticket was caught.

Covers: **a routine ticket is answered with a reply that went through the gate (a message from the support team awaiting the founder, with its card) and recorded, and nothing is sent**; **a refund request becomes a pending founder card in the spend category with the customer's message under "Show details", the ticket is marked escalated with that decision, and no message is written to the customer**; a discount (launch or pricing), a complaint and a legal question (legal or public) do the same; the customer's words reach the agent only inside the fenced result of `tickets.get`, never in the task; two runs started together on one ticket answer it once; a run that does not answer, a lead that rejects work that did not answer, and a model that cannot be reached all put the ticket back to open, while a rejection after the reply was already made leaves it answered (not reopened, so the customer is not emailed twice); if the card cannot be made the ticket goes back to open and the result says so; a bad or unknown id and a team without the charter run nothing and ask no model; `workNext` takes the oldest open ticket and says none when there is none; the team's tools are exactly the files list, with `refund.issue`, `discount.grant`, `complaint.escalate` and `legal.escalate` having no tool at all, only an always-ask rule in the right category; its skills are the shared ones plus its own four, and the sales skills are not in them. A worker that sends the reply but forgets `tickets.mark_answered` (a real model did exactly this on Nov 25, 2026) still gets the ticket recorded as answered by the team, using the outbound service's `latestReplyFor`, and the ticket is not reopened. Checked by mutation on Nov 25, 2026: filing the card without marking the ticket escalated was caught. Found while writing it: the lead model writes the worker's instructions, so the task now tells the lead to put the ticket id in them.

### teams-overview

Suite: `.claude/evals/suites/teams-overview.js`. Code under test: `src/runtime/teams/overview.js`, on a real Postgres with the migrations (the `agents` and `tasks` tables). Each case uses its own team so the counts are exact.

**Cases:** 8

Added Nov 26, 2026: **the same overview as one plain message for Telegram's /status** (`renderStatusText`): every team on one line, or one team in detail for the words the founder uses (sales, support, product, finance, orchestrator), with its agents, blocked tasks with the reason and open tasks (at most five of each); an unknown team says what to try; the text is cut, never throws, and **uses the same status words as the window's Teams page in every situation** (checked against `teams.mjs`). Checked by mutation: putting "working" above "blocked" was caught.

Covers: every team is listed in a fixed order with a plain label even when it has nothing; the page matches the data (counts per state, open tasks with the agent they are assigned to, blocked tasks with their reason, the latest finished ones, cancelled tasks never shown); **a task that changes status moves in the next listing and a removed agent disappears**; only plain short fields come back (never a description or a pod id) and text is cut and stripped of control characters; done work is counted up to a limit with the latest five listed newest first; a failing store throws. Checked by mutation on Nov 25, 2026: showing every task under every team was caught.

### teams-view

Suite: `.claude/evals/suites/teams-view.js`. Code under test: `src/renderer/teams.mjs` (plain functions, no React) and the rules for `src/renderer/TeamsPanel.jsx` (read as text).

**Cases:** 14

Added Nov 26, 2026: **a finished team job shows the runtime's own sentence with a tone**, the lead form needs a company and sends only what was filled in, and the page can start the sales and support teams through `window.api` only, announces the result, and still builds no markup and never polls.

Covers: a team's status says what needs a person first (blocked), then what is being worked on, then what waits, then caught up, no work yet or not started; every task state has a row in plain words and a count cut at its limit shows a plus sign; agents show role and state in plain words and an unknown one is still shown; open tasks say their state, who has them and how long ago they started; a blocked task always shows why; text from the database is passed through as text and never turned into markup; odd or missing fields never throw; the page headline, the order of the teams and the updated label; a `tasks.changed` announcement and the runtime becoming ready mean load again; the page component has no way to build markup from text, **no timer that polls the runtime** (every call is audited), refreshes on announcements, on focus and from a button, and reaches the runtime only through `window.api`; and end to end with the real overview, a change in the data changes what the page shows on the next load. Checked by mutation on Nov 25, 2026: putting "working" above "blocked" and adding a polling timer to the page were each caught.

### daily-brief

Suite: `.claude/evals/suites/daily-brief.js`. Code under test: `src/runtime/brief.js` (over an in-memory store and the REAL decisions service, plus one case on the real tables of a Postgres) and the rules for `src/renderer/BriefPanel.jsx` (read as text).

**Cases:** 10

Added Nov 26, 2026: **the cards waiting for the founder are listed one by one**, oldest first, each with its question, its kind and how long it has waited, up to five, then "...and N more in the approval queue"; a card with no question is counted but not listed, the text is cut and stripped of control characters, and no other part of a card is shown. Checked by mutation: removing the limit of five was caught.

Covers: the seven sections in order (Waiting for you, Revenue, Leads, Tickets, Deployments, Spend requests, Shared specialists; the last says "Not tracked yet" when no specialist queue is connected, and its lines are graded in `specialist-queue`); **revenue and deployments say plainly "Not tracked yet" and show no number**, because no payments and no deployment tool are connected; the date and time in the headline are in IST (including just after midnight); waiting decisions are counted by kind and blocked tasks are added, and the headline adds them up; leads are counted with the new ones of the last 24 hours exactly and the latest names are shown as text (cut and stripped of control characters); tickets show open, in progress, and what was answered or sent to the founder in the last 24 hours; spend requests show what waits with the amount in rupees and dollars (or only the one that is known, or none) and what was decided in the last 24 hours; the Telegram text is built only from the same lines, has no markup and stays under 3,500 characters; it runs on the real tables and a failing store throws; and the window's panel draws only those lines as text, has no timer, and refreshes on announcements, on focus and from a button. Decisions are read only through `decisions.summary`, never from their table.

### morning-digest

Suite: `.claude/evals/suites/morning-digest.js`. Code under test: `src/runtime/telegram/digest.js`, on a fake clock and fake timers with an in-memory ledger.

**Cases:** 11

Covers: the setting defaults to 09:00, can be turned off with `off`, and a bad value says so without repeating it; the date and time are worked out in IST whatever the computer's zone; **the digest goes out once a day at the set time and not before**; **the text sent is the brief's own text, built from the lines the window shows**; an app started after the set time sends at once but only within six hours of it; a restart the same day does not send it again (the day's send is in the audit log) and a custom time is respected; the attempt is recorded before anything is sent and if it cannot be recorded nothing is sent; a failed send is tried again after five minutes, at most six times a day, and succeeds or gives up; a brief that cannot be made or a ledger that cannot be read sends nothing and is tried again; overlapping checks send once and `stop` ends the job; and a job without what it needs does nothing and never throws. Checked by mutation on Nov 25, 2026: sending before recording, and skipping the "already sent today" lookup, were each caught.

### phase2-gate

Suite: `.claude/evals/suites/phase2-gate.js`. The scenario is `scripts/gate2.js` (re-run it by hand with `npm run gate:2`); this suite runs it and fails with the names of the steps that failed. Real: the whole app (`createApp`), a real Postgres with the migrations, the Marketing and Sales team and the Customer Support team (their skills, tool files, workers and review), the outbound gate, policy, decisions service, tool loader, Telegram bot and poller, Teams overview, daily brief and audit log. Fake: Telegram's and Tavily's servers, the model (a scripted provider cleared for client text, passed to `createApp` through its `providers` test seam) and the mail transport. Any other network request is refused and counted.

**Cases:** 3

Covers, in 22 steps per run: the app starts and the Teams page and brief start empty; **a lead is researched with a web search, saved in the lead list, written up as a proposal email that is reviewed and waits on a card, and nothing is sent**; the card is in plain language, has the email under "Show details", and reaches the phone with Approve and Reject buttons and the window's queue; **a routine ticket is answered through the same gate and recorded; a refund ticket becomes a card in the spend category, the ticket is marked escalated, and the customer is written nothing**; the phone's `/brief` is the same brief the window shows and says what happened; the Teams page matches the data; **one tap approves (the email is sent exactly once with exactly the stored text, and a second send does nothing) or rejects (it can never be sent)**; the refund card is still waiting and no refund ran; audit_log has every step in order and every tool by agent and team; no key appears anywhere; the window was told as it happened; only the fake servers were reached. It is run with the founder approving and again rejecting, and once more from scratch to show it repeats. Checked by mutation on Nov 25, 2026: filing the refund card without marking the ticket escalated, and sending only the headline on the phone's `/brief`, were each caught.

### team-jobs

Suite: `.claude/evals/suites/team-jobs.js`. Code under test: `src/runtime/teams/jobs.js`, with stand-in teams that finish only when the test says so.

**Cases:** 7

Covers: **a lead is started at once with the checked details and how it ended is announced later** (the runtime event `team.job_finished`); a lead with a bad detail (no company, a web address that is not https, two addresses, a price too long, an extra field) is refused with the reason and no team is called; at most two jobs run at once and a slot is free again when one ends; a ticket job takes the oldest open ticket or the one named and an id that is not an id never reaches the team; a missing team says not available and nothing is counted; what the window is told is fixed sentences and the team's own plain reasons, never an error's text; and a team or a listener that throws never leaves a job counted as running. Checked by mutation on Nov 26, 2026: removing the limit of two was caught.

### pod-creation

Suite: `.claude/evals/suites/pod-creation.js`. Code under test: `src/runtime/pods/service.js` (`createPods`), `templates.js` and the two templates in `config/pods/`; the database rules are in migration `20261126000000_pod_decision.sql` (graded by 2 cases in `database-schema`). Real Postgres with the migrations, the real decisions service and policy, the real event bus and REAL git in a temporary folder. The audit log points at pods and can never be emptied, so these cases do not reset the pods table.

**Cases:** 13

Added Nov 26, 2026 (step 3.3): **a pod can be tied to one repository from the founder's own list (GITHUB_REPOS), on the card the founder approves.** The list's spelling is kept; a repository that is not listed, a folder-like name, a wrong type, an empty value or extra path parts are refused in plain words; the card shows the repository in the details and says the team can suggest changes on its GitHub page, and a pod without one says "none"; opening sets the project's repository and `repoFor` gives it back (and nothing for an odd or unknown pod); if the list shrank between the answer and the opening, the pod is not opened and nothing is made.

The step 3.1 "done when": **approving a card creates a pod with its folder, git repo and memory space.** Covers: both templates load from real files, and a broken one (a missing file, a file name that leaves the folder, an unknown team, no folder at all) is left out with a plain reason while the other still loads; **asking for a pod files a plain card and writes nothing else** (no project, no folder, no pod; always asks, category people or contracts); **approving it makes** the project, the folder with the template's files filled in (no `{{blank}}` left), a git history with exactly one commit by `sfactory`, the pod, one first memory note and the pod's agents (the template's teams only; no shared specialist and no removed agent), and announces `pod.opened`; an own product has no client and gets its own teams; a no, a card not yet answered, a card of another kind and a bad id make nothing and opening by hand is refused; one card opens one pod even when opened twice at once, and a run that stopped half way is finished **without overwriting a file the founder edited**; a card approved while the app was closed is opened on start, and **starting never touches a card that already has a pod**; the folder is always directly inside the projects folder whatever the name (`../../etc/passwd`, `.`, `/`, accents, 80 characters, control characters) and two projects with one name get two folders; fourteen kinds of bad request are refused in plain words and write nothing; with no projects folder, no templates or a blocked runtime nothing is asked or opened; **every step is audited before it is made** (if the audit log is down nothing is made) and the founder's note never reaches the audit log; a failing git leaves no pod and the run is finished later. Checked by mutation: opening cards that already have a pod, skipping the approved check, and swallowing the audit failure were each caught.

### pod-isolation

Suite: `.claude/evals/suites/pod-isolation.js`. Code under test: the tool layer (`tools/index.js`, `filesystem.js`, `git.js`, `memory.js`, `pod.js`, `supabase.js`) and `agents/agent.js` and `team.js`. Real Postgres with the migrations, real folders and REAL git, the real tools and loader; three pods (Alpha and Beta with a client each, and a product pod) are opened through the real pods service. Every secret of pod B contains the word BETA, so a leak is a plain text search. The database's own row-level security is graded by `database-schema`.

**Cases:** 13

The step 3.2 "done when": **an agent in pod A cannot read pod B's files, repo, memory or client data.** The pod is in the run's context, set from the task by the team, never in a tool's arguments. Covers: **files** (a pod reads its own folder; `../`, an absolute path, `~`, a link to another pod's folder or file, `.git`, backslashes, a NUL, odd and unknown pod ids all fail; a company run reads the company folder but never the pods' folders, even though they sit inside it); **history** (a pod reads its own log, diff and status; another pod's history, a folder that lost its `.git` under a folder that is itself a repository, a link in place of `.git`, no pod, odd ids and every argument that could name a repository, path or option fail); **memory** (a pod's notes, the company's notes and another pod's never mix; an upper-case pod id still writes to the right pod; an odd pod id never falls back to the company space; no argument can choose a space; a secret in a note is not kept); **client data** (`pod.get_client` gives only the run's own client and takes no argument); **rows** (a pod run reads only its own tasks, its own project and its members plus the shared specialists; a filter naming another pod's row gives nothing; scaling rules, clients, memory and the other tables are refused); **the tool layer** (a tool with no `podAccess` is refused in a pod run, even with an odd pod id, and is not listed to it; of every real tool only a short list is open to pods (twenty-three since step 3.3), and the GitHub merge tool and the CRM, Gmail, Drive, tickets and email tools are closed); **the agent loop** (the pod comes from the task, upper-case is fixed, the model's own `podId` argument changes nothing, an unusable pod id fails the task, tool runs are audited with the pod); **the team** (a task for a pod needs an open pod, is saved with it and hands it to the worker); and **the headline**: an agent in pod A driven through fifteen attacks never sees any of pod B's files, history, memory, client or rows, while its own are readable. Checked by mutation: six rules (the loader gate, the file root, the memory space, the row filter, following a link for `.git`, and the agent dropping the pod) were each broken and caught.

### engineering-tools

Suite: `.claude/evals/suites/engineering-tools.js`, with the shared world in `.claude/evals/engineering-world.js`. Code under test: `tools/pod-files.js`, `git.js`, `github.js`, `pod.js`, `context7.js` and `browser.js`. Real Postgres with the migrations, real folders and REAL git; each GitHub repository is a bare git repository in a temporary folder, so a push really happens. GitHub's API, Context7 and the browser are stand-ins that record what they were asked.

**Cases:** 10

Covers: the world loads (three pods, two with repositories, every tool); **`pod.write_file`** writes inside the run's own pod folder only (a path with `..`, an absolute path, `~`, a link to another pod's folder or file, `.git`, secret file names, `node_modules`, a NUL, a wrong pod and no pod all fail, and nothing outside the folder changes); **branches and commits** work only on a branch of a safe shape (never `main`, never a name that could be an option), refuse a staged key or a secret file name (and leave nothing staged), never run a hook, are authored by the agent's own name, and say "nothing to save" when there is nothing; **pushing** sends only a safe branch to the pod's own repository (never the main line, never forced, a rewritten history is refused and the repository keeps what it had), the other pod's repository is untouched, a pod with no repository is told so, and the token never appears in a result, the repository's settings or an error; **GitHub in a pod run** works only on the pod's own repository (another listed repository, an unlisted one, a pod with none, the main line as the head and every merge are refused with no request made), while a company run still works as before; **`pod.info`**; **Context7** reaches one host with a fixed address shape, sends no secret, sends its key only to that host, never follows a redirect, cuts a long answer, and refuses odd library ids, topics and sizes; **the browser check** visits only public https pages (http, a login in the address, an odd port, localhost, private, link-local and mixed addresses, and a name that does not resolve are refused), asks the same check for every request the page makes, reports only plain facts, and does not exist without a browser. Checked by mutation: allowing a commit on the main line, a commit with a key, a push of the main line, any repository in a pod, writing through a link (both link checks), and writing a secret file name were each broken and caught.

**First real run (Nov 26, 2026), 1 new case:** a branch for a project whose GitHub repository already has history starts from that repository's default branch (found by `git ls-remote`, fetched, and the branch made from it), so the pull request can open; before this GitHub refused it with "no history in common". An empty repository keeps the old behaviour, and a repository that cannot be reached gives a plain "Not done" and makes no branch.

**Refused push (Nov 26, 2026), 1 new case:** a push refused because the branch name already exists on GitHub with different work (a stale branch from a failed earlier try) is never forced, and now comes back as a plain "Not done" result telling the agent to start a new branch with another name; before this the agent heard only "failed" and pushed the same name three times. The older push case now expects that same wording for a rewritten history.

### engineering-team

Suite: `.claude/evals/suites/engineering-team.js`. Code under test: `teams/engineering.js`, `config/mcp/product_engineering.yaml` and `.claude/skills/product_engineering/` (git-workflow, code-review, testing, deploy-checklist). Real: the database, the pods service, the agent factory with the REAL skills and tool configuration, the loop, the lead, the team, the tools, the policy and the decisions service. Stand-ins: the model (a fixed script per agent), GitHub's API, Context7 and the browser.

**Cases:** 10

The step 3.3 "done when": **an agent opens a pull request in a pod repo, and a production deploy attempt becomes a decision card.** Covers: a task is checked in code before any model sees it; the team is built from its real skills and tool list and a pod worker sees only the tools that stay inside a pod (no CRM, mail, tickets or merge); **Dev changes a project on a branch, saves it, sends it to the pod's repository and opens a pull request, Tess reviews it, the lead accepts** (the remote has the branch and the file and never `main`, the fake GitHub got exactly one request, for the pod's own repository, every tool run is audited with the pod, and the other pod's folder and repository are untouched); **a production deploy (a target of production, none, or an odd spelling) and a merge each stop the agent and file a plain card tied to the pod** (category launch or pricing, task blocked, nothing sent anywhere); a preview deploy is routine but no deploy tool is connected, so it is simply not available and no card is filed; a pod that does not exist or is closed gets no task and no card and no model call; an agent told to open a pull request in another pod's repository, from the main line, or to push to another remote cannot; a pod with no repository keeps the work in its folder and the agent is told why; and after the founder answers a deploy or merge card the follow-up says nothing was done. Checked by mutation: the deploy card not being tied to the pod and a pod being allowed any repository were caught.

**First real run (Nov 26, 2026), 1 new case:** the Engineering team asks the factory for its own larger allowance (16 steps, 100,000 tokens, still under the absolute caps) because the git workflow needs about eleven model calls and Dev ran out one step before opening the pull request with the shared allowance of 10 steps and 60,000 tokens.

### finance-tools

Suite: `.claude/evals/suites/finance-tools.js`. Code under test: `tools/invoice.js` (`invoice.draft`), `config/mcp/finance_legal_ops.yaml` and the policy. Pure code, no database: the tool is checked directly, then through the real tool loader and the real policy.

**Cases:** 10

The step 3.4 tool: **an invoice draft is produced.** Covers: the same state splits the tax into CGST and SGST and another state is one IGST, with the right amounts; a zero-rate invoice has no tax lines; money is whole paise (half up, never floating point), checked over 280 combinations of price, quantity, rate and state against an independent sum, with the total always equal to the parts and the two halves always equal; an invoice is a DRAFT with no invoice number (the founder assigns it), a due date from the invoice date, the buyer's notes and a plain `.txt` file with a safe name; 34 kinds of bad argument are refused in one plain sentence (an invoice number, a rate that does not exist, a state that does not exist, a GSTIN of another state, a price with three decimals, a fraction of a unit, too many items, a day that is not a real day, a control character) and four good ones are accepted; an unset date is today in India (checked at 01:30 IST on a day that is still the day before in UTC) and a leap day is a real day; the tool is a routine write for the policy (a wrong access tag is refused) and the loader runs it in a pod run and outside one; the team's tool file lists it and nothing that moves money; and **no payment credential exists anywhere in the source or `.env.example`, a payout has only an always-ask rule in the spend category, and there is no `razorpay.*` or `zoho_books.*` tool.** Checked by mutation on Nov 26, 2026: always charging IGST and rounding down instead of half up were each caught.

### finance-team

Suite: `.claude/evals/suites/finance-team.js`. Code under test: `teams/finance-legal-ops.js`, `config/mcp/finance_legal_ops.yaml` and `.claude/skills/finance_legal_ops/` (invoice-with-gst, expense-recording, contract-review, data-privacy-check). Real: the database, the pods service, the agent factory with the REAL skills and tool configuration, the loop, the lead and the team, the invoice tool, the policy and the decisions service. Scripted: the model and the card writer. The world is shared with `engineering-tools`.

**Cases:** 11

The step 3.4 "done when": **an invoice draft is produced, and a payment request becomes a card instead of running.** Covers: a task is checked in code before any model sees it; the team is built from its real skills and tool list and has nothing that pays, signs or sends; an invoice draft is produced with the tax worked out by the tool, the task is done, nothing is sent and no card is filed; **a payment request becomes a pending card in the spend category instead of running** (the payout tool is never run and does not exist); a signature, a document to sign, a legal document and a legal question each become a card in their own category; inside a pod the work and the card belong to that pod (and no other pod gets one); work for a pod that does not exist is refused and nothing is made; a card that cannot be made says so and the task stays blocked; a team without the company charter runs nothing and asks no model; answering a card gives a plain follow-up that says nothing was done, and only for this team's cards (never a deploy, a refund or a support question that names a ticket); and the skills are the shared ones plus four, naming only tools that have an always-ask rule and nothing that sends mail. Checked by mutation on Nov 26, 2026: making a payout a routine action failed five cases here and one in `finance-tools`.

### specialist-queue

Suite: `.claude/evals/suites/specialist-queue.js`. Code under test: `src/runtime/specialists.js` (`request`, `serveNext`, `queue`, `conflicts`), `pods.setPriority` in `src/runtime/pods/service.js` and the "Shared specialists" section of `src/runtime/brief.js`. Real: the database with the migrations, three real pods (shared with `engineering-tools`), the pods service and the brief.

**Cases:** 13

The step 3.5 "done when": **two pods need the same specialist and P1 is served first.** Covers: pod A (P3) asks first, pod B (P1) asks second, and the specialist serves B first, then A, then nothing (each served task is `in_progress`, assigned to the specialist and still its own pod's); P1, then P2, then P3 and among equals the oldest request; **changing a project's priority re-orders the work already waiting** (the order uses the project's current priority, not a copy made when it asked); a task is handed out once even when two callers ask at the same moment (one waiting task goes to one caller, two go to two different callers); only a shared, working specialist can be asked and only for an open pod (a worker, a specialist that is not shared, a removed or unknown one, an unknown, odd or closed pod, a bad title or description and an extra argument are all refused in plain words and create nothing); a request is a queued task of that pod, for that specialist, with the project's priority and the specialist's team; only the named specialist's work is served and a paused, removed or unknown specialist serves nothing; the served task names its pod and carries only its own words (nothing of the other pod); conflicts are the specialists that more than one project is waiting for, in serving order (one project asking twice is not a conflict, and a conflict ends when one side has been served); a priority is P1, P2 or P3 and can be changed for an open pod only (seven kinds of bad input refused, the other pods untouched, two audit entries for two changes); everything is audited first and nothing changes when the audit log is down or the runtime is blocked; the brief names the specialist, who goes first and who waits, with the same lines in the Telegram text, says "No conflicts" when there are none and "Not tracked yet" when no queue is connected; and text from the database in the brief is cut and stripped of control characters and the list is capped at three conflicts plus a "...and N more" line. Checked by mutation on Nov 26, 2026: ignoring priority, ordering by the copied priority, claiming without the "still queued" check, swallowing an audit failure and counting one project as a conflict were each caught.

### pod-files

Suite: `.claude/evals/suites/pod-files.js`. Code under test: `src/runtime/pods/files.js` (`tree`, `read`, `history`, `beginEdit`, `endEdit`, `save`, `upload`, `isLocked`), the lock check in `pod.write_file` (`src/runtime/tools/pod-files.js`), the `files.*` commands in `src/runtime/commands.js`, `window.api.files` in `src/preload.js` and the panel's logic in `src/renderer/files.mjs` (with `FilesPanel.jsx`). Real: the database with the migrations, three real pods (shared with `engineering-tools`), real git and the real tool loader.

**Cases:** 13

The step 3.6 "done when": **an edit is committed with history, and an agent write to a locked file is refused.** Covers: the tree lists the pod's own files in order and never secrets, `.git`, `node_modules` or links; a read gives the text and refuses anything outside the folder, secret, linked, binary, or missing, with plain errors; history comes from the project's own git log, for the whole project or one file, with its limit checked; **a saved edit is a real commit by "Founder" with the history showing it, only that file is in the commit (what an agent left uncommitted is not swept in), the lock is released, the `pod.file_changed` event is announced and the audit entry holds the path and size but never the words**; **an agent's `pod.write_file` to a file the founder has open is refused with a plain "Not done" result (also with `./` or another letter case), other files and other pods are not affected, and it works again after save or close**; a save needs the lock, a lock runs out after 30 minutes and opening again renews it; an upload adds a new file with a commit, never replaces one, and refuses secret names, odd paths, key-looking text, NUL bytes, oversize and non-text; nothing changes when the audit log is down, the runtime is blocked or the history cannot record the change (the file is put back, or never made); two saves at the same moment both land; one pod never reaches another's files, history or lock; the window's commands check their arguments, answer `not_available` with no service and keep the file's words out of the audit log; the preload exposes the eight functions and the panel shows text only with no timer; and the panel's logic nests the tree (folders first), labels the history and refreshes only on its own project's event. Mutation-checked: an agent write that ignores the lock, a save that needs no lock and a commit that adds everything are each caught.

### agents-panel

Suite: `.claude/evals/suites/agents-panel.js`. Code under test: `src/runtime/agents/events.js` (`record`, `list`), `src/runtime/agents/control.js` (`list`, `pause`, `isPaused`, `message`, `takeMessages`, `reassign`), the feed and pause hooks in `src/runtime/agents/agent.js` and `team.js`, the five `agents.*` commands in `src/runtime/commands.js`, `window.api.agents` in `src/preload.js` and the panel's logic in `src/renderer/agents.mjs` (with `AgentsPanel.jsx`). Real: a database with the migrations (the `agent_events` table of step 1.1) and the real agent loop and team runner, with a scripted model.

**Cases:** 13

The step 3.7 "done when": **a step an agent takes appears in the feed within a second or two, and a typed instruction reaches the agent.** Covers: an event is saved first and announced as `agent.event` only after, with secrets removed, a summary cut at 200 characters, and `record` never throwing (a failing store or listener gives `null` or a saved line, never an error); **every step an agent takes (a file read, a file written, a tool used) is in the feed BEFORE its tool runs, in plain words with no tool arguments, no tool error text and no secret**; a stop (step cap) and a request for the founder are said plainly; a team run records when each agent starts working and goes idle, and a failing events service never stops a task; **a note the founder types is in the agent's next prompt inside a random fence, framed as the founder's wish, with secrets removed, and one typed in the middle of a run is in the very next step (not the one before), is kept for the rest of that run and is not repeated in a later run**; a note goes only to a working worker or specialist, must be plain text, and at most 20 wait for one agent; **pause stops an agent at its next step (also in the middle of a task, so the model is not asked again), a team task is blocked with a plain reason, and resume lets it work**; reassign moves only a waiting or blocked task to a working agent of the same team (a shared specialist's task only to another shared specialist), never to a removed, other-team or plain agent, and never one being worked on or finished; nothing changes when the audit log is down or the runtime is blocked; the list gives plain fields only (no task description); the commands check their arguments, answer `not_available` with no service and keep the founder's words out of the audit log (only their length); the preload exposes the five functions and the panel shows text only with no timer; and the panel's logic words the agents and the feed and adds a live event once, for the open agent only, keeping 100 lines. Mutation-checked: a loop that ignores pause, notes that are never delivered, events announced without being saved, a reassign of any status and the founder's words in the audit log are each caught.

### phase3-gate

Suite: `.claude/evals/suites/phase3-gate.js`. The scenario is `scripts/gate3.js` (re-run it by hand with `npm run gate:3`); this suite runs it and fails with the names of the steps that failed. Real: the whole app (`createApp`), a real Postgres with the migrations, the pods service (folders, git, memory), the Engineering team and the Finance, Legal and Ops team (their skills, tool files, workers and review), the real git tools pushing to two real bare repositories, policy, decisions service, tool loader, the files panel and agents panel services and the audit log. Fake: GitHub's API (records the requests), the remote repositories' location (`gitRemoteUrl`, a test hook of `createApp`) and the model (a scripted provider); any other network request is refused and counted.

**Cases:** 3

Gate 3: **a pod is created, an agent opens a PR, and an invoice draft is produced, all isolated per pod.** Covers, in 21 steps: the app starts and the Teams page and the projects start empty; two projects are asked for on plain cards and nothing is made until the founder approves; approving opens both (own folder inside the projects folder, own git history with one version, own GitHub repository, own memory); **the Engineering team makes a branch, writes a file, saves it, sends it and opens exactly one pull request on its own project's repository, with the main line and the other project untouched**; an agent told to read the other project's notes is refused and the model never sees the other project's words, and the other project's tasks never see this one's; a production deploy attempt becomes a plain card tied to the project and nothing goes live; **the Finance team drafts an invoice inside the other project with the GST worked out in code (IGST ₹18,000.00, total ₹1,18,000.00) and no invoice number**; a payment request becomes a plain spend card tied to that project and nothing is paid; every task and tool run belongs to exactly one project; exactly two decisions wait; the files panel and the agents panel with its live feed show it in plain words; the audit log has every step in order; no key, token or founder's note is in the audit log, cards, tasks, memory or feed; and nothing outside the fakes was reached. The suite also runs the scenario a second time from scratch and checks the result is the same, and checks the gate still contains the steps of the done-when. Mutation-checked: a pod missing from the tools' context, a production deploy that is allowed and a payout that is allowed each fail the gate.

### team-tasks

Suite: `.claude/evals/suites/team-tasks.js`. Code under test: `src/runtime/teams/jobs.js` (`startFinance`, `startEngineer`), the two `teams.start*` commands in `src/runtime/commands.js`, `/finance` and `/engineer` in `src/runtime/telegram/bot.js` (and the service that gives the bot the teams and the open projects), `taskFormView` and `jobNotice` in `src/renderer/teams.mjs`, the two forms in `TeamsPanel.jsx` and the preload. All with fakes (no database).

**Cases:** 9

The follow-up that steps 3.3 and 3.4 left open: **start the Engineering and Finance teams from the phone and the Teams page, the way `/lead` and `/ticket` start the others.** Covers: a finance job is started at once with the checked details (a project is optional) and how it ended arrives later in fixed sentences ("Nothing was paid, signed or sent"); an engineering job needs a project and says "Nothing was merged and nothing went live"; a bad title, a project that is not an id, an unknown extra option, a missing team or two jobs already running never reach a team, and an error's own text is never shown; the window's commands check their arguments and record only the title (cut) and whether there was a description, never the description; **on the phone `/finance [project |] <title>` and `/engineer <project> | <title>` start the team in the background, the project is named in words and found among the open projects only, and an unknown name, an ambiguous name (all the matches are listed) or a missing title starts nothing**; only the founder can use them, a missing team is said plainly, and the two-at-a-time limit is shared with `/lead` and `/ticket`; the Telegram service and `createApp` give the bot and the jobs both teams; and the window has the two forms with plain checks, a project list from `files.pods` and a notice for each kind. Mutation-checked: an ambiguous name that picks one project, the description in the audit log and an engineering task with no checks are each caught.

### task-resume

Suite: `.claude/evals/suites/task-resume.js`. Code under test: `src/runtime/teams/resume.js` (`createTaskResumer`: `start`, `stop`, `resumeFor`, `settled`), `resume` and the card-with-its-task in `src/runtime/teams/engineering.js` and `finance-legal-ops.js`, and `resumeTaskId` / `resumeNote` in `src/runtime/agents/team.js`. Real: a database with the migrations, real pods, the real agent factory, skills and tool files, with a scripted model. Each case has its own world, because `start()` picks up every approved card whose task is still blocked.

**Cases:** 9

Option B for "resuming a task after you approve a card" (chosen Nov 26, 2026). Covers: **a card an agent was stopped on is tied to its task (`decisions.task_id`) for both teams; approving a deploy or merge card puts the SAME blocked task back in the queue (no new row) and the team carries on, with every worker told that the approval is only the founder's answer and that nothing was merged or put live by it, and to say what is left for a person**; a payout card does the same for the Finance team ("Nothing was paid, signed or issued"); only an approved card of those two teams, with its task still blocked, resumes anything: a no, a card with no task, a support ticket's card, a task that moved on, and the same answer twice at once (one run) never do; it is audited (`task.resumed`) before the task moves, and nothing moves when the audit log is down or the runtime is blocked; a resumed run that needs the founder again files a NEW card for the same task and blocks it again, and approving that one resumes it again; a team that cannot start, or throws, puts the task back to blocked with a plain reason and the founder is told in a fixed sentence (never the error's text); a card approved while the app was closed is picked up on start, once; and the phone's follow-up says the team is picking the task up again (the old wording stays for a card with no task), and `createApp` builds, starts and stops the resumer. Mutation-checked: a no that resumes, a resume with no audit entry, workers not told about the approval and a card filed without its task are each caught.

### autoscaling

Suite: `.claude/evals/suites/autoscaling.js`. Code under test: `src/runtime/autoscaler.js` (`tick`, `status`, `start`, `stop`), the `agent.add` rule in `src/runtime/policy.js`, `createApp`'s wiring and `AUTOSCALE_EVERY_SECONDS`, and `scripts/scale.js`. Real: a fresh database with the migrations for each case, the real decisions service, policy and card checker; the clock is a fake the test moves.

**Cases:** 9

The step 4.1 "done when": **a load test adds agents up to the cap, then produces a card, then scales back down.** Covers: with 12 tasks waiting for one agent, each tick adds one agent ("Aria 2", "Aria 3") and shares the waiting work out (4, 4, 4); at the cap a tick files ONE card and a second tick files none; once the work is done and the agents have been idle long enough they are removed one per tick, the copies only; **"queue" is waiting tasks per agent** (3 for one agent adds nobody, and sharing the work out stops the adding), only tasks that have not started move, and running or blocked work stays; **"wait" is counted from the newest agent's arrival**, so a task waiting 31 minutes adds an agent but a second is not added at once; **past the cap a plain card (an always-ask `agent.add` rule, in the people category, passing the card checker) asks once, an approval adds exactly one agent beyond the cap and the same answer announced again adds none, and a no is not asked about again for a day**; only an idle copy with no open work for long enough is removed, never an original, a lead, a paused or working agent, one holding blocked work, or another team's; rules come from `scaling_rules` with built-in defaults, a disabled rule switches a group off, and the most specific rule wins; **an open project space is closed (with its members marked as left) when its project is completed or cancelled, once**; nothing changes when the audit log is down or the runtime is blocked, a tick never throws, and two ticks at once run one; and `createApp` builds, starts and stops it, `AUTOSCALE_EVERY_SECONDS` is read and documented, and `npm run scale` exists. Mutation-checked: no cap, removing an original and an approval that adds twice are each caught (moving running work is stopped by a second guard in the move itself).

### guardrails

Suite: `.claude/evals/suites/guardrails.js`. Code under test: `src/runtime/guardrails.js` (`limits`, `teamStopped`, `stopTeam`, `startRun`, `status`), the daily cap, loop detection and team switch in `src/runtime/agents/agent.js` and `team.js`, `/pause` and `/resume` in `src/runtime/telegram/bot.js`, the two `guardrails.*` commands, the preload and the switches in `TeamsPanel.jsx`, and the `app_settings` migration. Real: a fresh database with the migrations for each case, the real agent loop, policy, agent control and bot, with a scripted model; the clock is a fake the test moves.

**Cases:** 8

The step 4.2 "done when": **a looping fake agent is stopped by the caps, and `/pause` stops an agent mid-task.** Covers: an agent whose every call is different is stopped by the step cap and by the token cap, and one that repeats the same call with the same result (3 times) or two calls taking turns is stopped sooner, by loop detection, before the model is asked again; a repeat whose result changes (polling) and different arguments are left alone, and the loop limit is read live (2 stops it at two, a nonsense value gives the default of 3); **a daily task cap per agent** counted in the audit log by India's date, so a third run is refused without asking the model, another agent has its own count, a raised limit takes effect at once and the next day starts again; **a team kill switch** stops a running agent at its next step (the second model call is never made), keeps that team from taking a new task (nothing saved, no model asked) and leaves other teams alone; the switch is audited first, remembered by another process, refuses nonsense and, when the audit log is down or the runtime is blocked, changes nothing; **a missing or odd settings table gives the defaults, says so once and never stops work, and a team switch then says plainly what to do**; **`/pause Aria` typed in the middle of a task stops it before the next model call, `/resume` lets it go on**, a stranger's command does nothing, a name matches whole-name first, an ambiguous or unknown name and a team that does not exist are said plainly, and `/pause team support` and `/resume team support` switch a whole team; and `createApp` builds the guardrails, the two commands and the Teams page switches exist. Mutation-checked: no loop detection, a running agent that ignores its team's switch, a stopped team that still takes work, a daily cap that is never reached and a switch saved with no audit entry are each caught.

### audit-search

Suite: `.claude/evals/suites/audit-search.js`. Code under test: `src/runtime/audit-search.js` (`search`), the `audit.search` command, `src/renderer/audit.mjs` (`searchFormView`, `auditRowsView`), `AuditPanel.jsx` and the preload. Real: a database with the migrations and the real services of the engineering test world (pods opened from founder cards, decisions, the audit writer), plus the kind of entries the gates leave.

**Cases:** 8

The step 4.3 "done when": **any action from the gate tests can be found by search.** Covers: **every distinct action in the log (including all the ones the three gate scenarios name: `runtime.started`, `decision.created`, `decision.resolve`, `task.created`, `task.status_changed`, `agent.tool_run`, `outbound.*`, `pod.opened` and more) is found by its exact name and by words from it**, and a tool name or an agent's name finds the runs that used it; filters combine (the founder, an agent or the system; one project; a time range) and all the words must appear, in any letter case; results are newest first with `before` for the next page, `more` and an honest `scanned` (the store filters on equality only, so a search reads a bounded window of the newest 1,000 entries and says how many it looked at); an entry is one plain line with no secret (removed when written and again here), no control character and at most 300 characters, and an odd entry (no detail, a deeply nested one, a bad date, a missing row) never makes a search fail; bad arguments are refused and the limit is held at 100; the command is read only, checks its arguments and answers `not_available` with no service; the page's logic turns the form into a search (the last N hours as a start time) and the result into rows with the time in IST; and the page shows text only, has no timer and is wired into the app and the preload. Mutation-checked: a search where any single word matches, and one that shows secrets again, are each caught.

### settings-page

Suite: `.claude/evals/suites/settings-page.js`. Code under test: `src/runtime/settings.js` (`get`, `setLimits`, `setScaling`), `guardrails.setLimits`, the three `settings.*` commands, `src/renderer/settings.mjs`, `SettingsPanel.jsx` and the preload. Real: a fresh database with the migrations for each case, the real agent loop, guardrails, autoscaler and decisions service.

**Cases:** 8

The step 4.3 "done when": **changing a limit takes effect without a restart.** Covers: the page reads the limits, the scaling rules for each team and role (a saved rule or the built-in default, saying which), the team switches, the approval period (**shown, and `editableHere` is false**) and the tools you added (not the removed ones); **a changed loop limit is used by the very next run (3 repeats before, 2 after), a lowered daily cap by the very next run, and a second process sees both**; limits are refused outside their bounds (never clamped), an unknown option is refused, and every change is audited first with the old and the new value, with nothing changed when the audit log is down or the runtime is blocked; **a changed agent cap is used by the autoscaler's next pass (at one agent with a cap of one it asks you, at a cap of three it adds one) and a disabled rule switches that group off**; a rule is saved once (no duplicate row), a partial change keeps the other values, and bounds, unknown teams and roles and extra options are refused; the approval period cannot be changed from the page (no function does it, and the three commands are exactly `settings.get`, `settings.setLimits` and `settings.setScaling`); the page's logic words the settings and checks the forms before anything is sent; and the page shows text only, has no timer and is wired in. Mutation-checked: a rule saved with no audit entry and a limit accepted outside its bounds are each caught.

## Planned evals (not built yet)

Each is added before the code it grades, in the step shown. Move it into the registry above when written.

| Planned suite | Grades | Plan step | Kind |
|---|---|---|---|
| `card-writer` | The model step that rewrites a request into a plain-language card, graded by the card checker plus a judge model | after 1.3 | model-graded |
| `orchestrator-approval` | A goal containing a spend pauses the graph and resumes when approved | 1.7 | deterministic |
| `mcp-tagging` | Every tool is tagged read or write; write tools that spend, send, deploy or sign go through the policy check | 1.10 | deterministic |
| `outbound-review` | An outbound client message can't be sent without review, and the first-2-weeks setting forces a decision | 2.2 | deterministic |
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
