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
| `invariants` | The repo itself: architecture, security settings, docs in sync | 13 | 100% | 0.4 | pass |
| `policy-check` | `src/runtime/policy.js` | 44 | 100% | 1.4 | pass |
| `decision-cards` | `src/runtime/cards.js` | 44 | 100% | 1.5 | pass |
| `claude-code-provider` | `src/runtime/providers/claude-code.js` | 12 | 100% | 1.3 | pending |
| `database-schema` | `supabase/migrations/*.sql` and `supabase/seed.sql` | 24 | 100% | 1.1 | pass |
| `runtime-core` | `src/runtime/{config,audit,runtime,commands}.js` and `src/ipc-guard.js` | 26 | 100% | 1.2 | pass |
| `decisions-service` | `src/runtime/decisions.js`, against a real Postgres with the migrations | 32 | 100% | 1.6 | pass |
| `policy-tools` | `src/runtime/policy-tools.js` (the founder adding tools from Telegram), against a real Postgres | 22 | 100% | 1.6 follow-up (used by the bot in 1.8) | pass |

Update the "Today" column when a suite's status changes.

## Suites

### invariants

Suite: `.claude/evals/suites/invariants.js`. No dataset; each case is a check function in the suite file. Runs against the repo today.

**Cases:** 13

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
| `env-example-names-only` | `.env.example` exists, every line is a comment or a `NAME=` with no value, so no key is ever committed through it, **and it names every setting the code reads** (so a deleted line, like `SUPABASE_ACCESS_TOKEN=`, fails here instead of going unnoticed) |
| `policy-is-the-only-source-of-allow` | Nothing under `src/` except `src/runtime/policy.js` builds an `allowed: true` answer, and `policy.js` grants in exactly one place, so no code path can approve an action without going through the policy check |
| `only-the-decisions-service-answers-decisions` | Nothing under `src/` except `src/runtime/decisions.js` writes a decision's status or its resolution fields (`resolved_via`, `resolved_at`, `resolution_note`), and the service's answer channels are exactly `dashboard` and `telegram`, so "nothing is auto-approved" cannot be broken by a new code path or a new "agent" channel |
| `only-the-policy-tools-service-touches-the-policy-table` | Nothing under `src/` except `src/runtime/policy-tools.js` mentions the `policy_tools` table, so no other module has a way to read or change the founder's additions to the policy, and nothing an agent is handed can loosen it |
| `evals-doc-in-sync` | This file lists every suite, with a correct `**Cases:**` count |

### policy-check

Suite: `.claude/evals/suites/policy-check.js`. Dataset: `.claude/evals/datasets/policy-check.json`. Code under test: `src/runtime/policy.js`. Unit tests that sweep every listed tool (`src/runtime/policy.test.js`) back the dataset up.

**Cases:** 44

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

**Cases:** 44

Contract: `checkCard(card) -> { pass, problems, findings }`, where problems are `missing_field`, `jargon`, `contains_code`, `bad_risk_level`, `cost_format` and `time_format`; and `produceCard({ request, write, maxAttempts }) -> { status: 'ready', card, attempts } | { status: 'flagged', problems, rejectedDraft, attempts }`. The full contract is in the header of the suite file. This grades the deterministic checker and the writer-checker loop (with a scripted writer), not the model that will write the cards.

| Group | Cases | What it checks |
|---|---|---|
| `good-*` | 7 | The kickstart's "after" example passes; a technical word explained in brackets passes, and may be reused afterwards; times with IST pass; technical text in `details` is exempt; everyday business words (invoice, website, sales pipeline) are not flagged; a High risk and two IST times pass |
| `bad-*` | 29 | Jargon (the kickstart's "before" example, an unexplained abbreviation, jargon in the risk reason, a thin explanation, an explanation that comes after the first use, a version number, plurals and capitals, a term hidden by an invisible character); missing risk, blank recommendation, risk without a reason, a field of only invisible characters, a field that is not text, a `null` card; code in founder-facing text (backticks, a code fence, a command without backticks, SQL); cost without both ₹ and $ (or without numbers, or in words); a risk level other than exactly Low, Medium or High; times without a zone, in UTC, or in another zone; a card with every kind of problem reports all of them |
| `loop-*` | 8 | Passes on the first try; fixed on the second try after being told what was wrong; flagged after the limit; stops at the limit even if a later try would pass; a writer that crashes counts as a try (and, if it always crashes, is flagged as `writer_error`); a ready card holds only the seven fields (plus `details`) and drops anything else the writer added; a flagged result has no `card` property, so it cannot be sent |

Checked by mutation on Nov 23, 2026: 36 realistic mistakes were introduced into `cards.js` one at a time (a check removed, explanations that are too thin accepted, invisible characters or look-alike letters not folded, `details` read like the other fields, any time zone accepted, one currency accepted, case-insensitive risk levels, an everyday word made jargon, a retry too many, a flagged result that carries a card, error text leaking, no snapshot before checking, and more). The first run missed 4: two thin-explanation rules that hid each other, SQL `select ... from` never tested, and a deleted jargon term (the tests read the term list, so deleting a term deleted its test). Tests were added for each, and all 36 are now caught.

Judgment calls, **confirmed by the founder on Nov 23, 2026** (the three below; the jargon list itself is still a starting set to tune against real cards): the jargon list is a starting set of 56 words and will need tuning against real cards (words like `production`, `branch` and `ram` are deliberately not on it, because they are ordinary words or names); an explanation in brackets needs at least three words and twelve letters; a clock time must be followed by `IST`, so a card that also quotes another zone in brackets is rejected; every cost must show both currencies with numbers, so "free" has to be written `₹0 ($0)`.

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

**Cases:** 24

How it works: the migrations are applied, in filename order, to a real Postgres running inside the test (PGlite, which is PostgreSQL 18, with pgvector). It is dressed like Supabase: the `anon`, `authenticated` and `service_role` roles, an `auth.jwt()` that reads the request's claims, and Supabase's default grants (which the migrations must take back). A fixture creates two pods with rows in every table. Each case then acts as someone specific (a pod agent with a `pod_id` claim, no claim, `anon`, the runtime's `service_role`, or the table owner) and tries things, always inside a transaction that is rolled back. Attack cases include a positive control (the same action on the pod's own data must succeed) so a case cannot pass just because everything is blocked. The contract (tables and columns the fixture inserts into) is in the header of the suite file.

Limits: this proves the policies and rules, not that they apply to your real project. It uses a stub of Supabase's `auth.jwt()`, and PostgreSQL 18 where Supabase currently runs an older version. Applying the migrations to the real project is checked separately (`npm run check:db`).

| Group | Cases | What it checks |
|---|---|---|
| Schema | 5 | Migrations apply to an empty database; all 12 core tables exist; row-level security is on for every public table (a future table without it fails this); `anon` has no privileges on any table; `memory.embedding` is a 768-dimension `pgvector` column and nearest-neighbour search works |
| Reading | 5 | A pod reads only its own rows in six tables; sees only its own pod and project; sees only its own project's client; sees only its own members plus shared specialists; a request with no pod claim sees nothing anywhere |
| Writing | 5 | A pod cannot write into, or move rows to, another pod; cannot approve its own request, including a fully forged approval; cannot read scaling rules or touch the audit log; cannot delete its rows; **a pod, a request with no pod claim and `anon` cannot read or write the policy table** (the runtime can) |
| Runtime | 1 | The runtime's `service_role` sees everything |
| Integrity | 7 | The audit log is append-only even for the table owner (update, delete, truncate); a resolved decision is frozen; a decision's content (card, action, category, pod, amounts) cannot change after filing; approved or rejected needs a resolver and a time; a card needs all seven fields; **a policy rule is fixed once it exists (tool, kind, category, access) and cannot be deleted, a removed rule stays removed; a rule must be well formed (an ask rule has a category and no access tag, a routine rule the reverse, lower-case ASCII names, no agent as proposer, no active rule nobody confirmed) and a tool has one live rule at a time, though a removed tool can be proposed again** |
| Seed | 1 | The seed creates exactly one fake pod and one fake agent, all labelled `[seed]`, and can run twice without duplicating |

Checked by mutation on Nov 21, 2026: 8 realistic mistakes were each introduced into the migrations one at a time (a policy that lets everything through, a missing append-only trigger, pods allowed to update decisions, row-level security off on one table, `anon` grants not revoked, the decision-freeze trigger removed, pre-approved requests allowed, the card-field check removed). All 8 were caught. The first run missed "pods allowed to update decisions" because the attack was too weak; the attack was strengthened.

### runtime-core

Suite: `.claude/evals/suites/runtime-core.js`. No dataset; each case is a check function with an in-memory fake store that records every call. Code under test: `src/runtime/config.js`, `audit.js`, `runtime.js`, `commands.js` and `src/ipc-guard.js`.

**Cases:** 26

Contract: the full contract (function signatures, error codes, the store interface) is in the header of the suite file. Nothing here touches Electron, the network or a real database, so it runs in milliseconds. The Electron wiring (`src/main.js`, `src/ipc.js`, `src/preload.js`) is covered by the `invariants` checks, and by launching the real app (see PLAN.md step 1.2).

| Group | Cases | What it checks |
|---|---|---|
| Config | 4 | Both Supabase settings are required and problems name the setting, never the value; a URL that is not `*.supabase.co` or local is rejected, so the key can't be sent elsewhere; the printable description hides the key |
| Audit | 3 | Secrets in an entry (by field name, and by value shape: Groq, Anthropic, Supabase, JWT, Telegram) are redacted before writing; an invalid entry is refused and writes nothing; a valid entry becomes one `audit_log` row with the right columns |
| Command bus | 11 | Unknown commands are refused and not logged; **a command can choose which of its arguments the audit log keeps (a broken chooser records nothing rather than everything)**; malformed or oversized arguments are refused before anything runs; **the audit entry is written before the handler runs; if it cannot be written the handler never runs**; a crashing handler returns a generic message (no internals, no secrets) and the failure is audited; `CommandError` passes its code through; never-audited commands (status) skip the log and work without a database; events reach subscribers, with a wildcard, and a bad listener breaks nothing; a stopped runtime refuses everything; a blocked runtime refuses actions but still answers status |
| Commands | 6 | Exactly the four planned commands exist; `decisions.list` defaults to pending, caps the size and rejects bad options; `decisions.resolve` calls the decisions service as `dashboard` (the caller cannot pick the channel, a `via` is refused), passes its answer through, lets its plain errors reach the window, keeps other errors generic and answers `not_available` with no service; **the dashboard answer records that there was a note, not what it said, in the command audit entry**; `agents.pause` validates its arguments but refuses with `not_implemented` and changes nothing; status reports the database state without leaking the error |
| IPC guard | 2 | Only the app's own page (the built `index.html`, or the dev server's exact origin in dev only) is trusted; payloads must be a plain command name with plain-object arguments |

Checked by mutation on Nov 21, 2026: 8 realistic mistakes were introduced into the runtime one at a time (audit failure no longer blocking, internal errors leaking, redaction off, any file URL trusted, argument checks removed, status audited, a stopped runtime still accepting commands, the dev server trusted in production). All 8 were caught.

### decisions-service

Suite: `.claude/evals/suites/decisions-service.js`. No dataset; each case is a check function. Code under test: `src/runtime/decisions.js`. Unit tests (`src/runtime/decisions.test.js`, 19 tests, and three end-to-end tests in `runtime.integration.test.js`) back it up against an in-memory store that adds delays between every step.

**Cases:** 32

How it works: the cases run the service against a **real Postgres with the real migrations** (`scripts/fake-supabase.js`: PGlite behind real HTTP, using the runtime's own REST store), so the integrity triggers are live and "two answers at once" is two real concurrent requests. Each case starts from an empty `decisions` table and logs every write, so it can check the order (audit first) and that a refused call wrote nothing. The full contract (`create`, `resolve`, `cancel`, `get`, `remindDue`, `DecisionError`) is in the header of the suite file.

| Group | Cases | What it checks |
|---|---|---|
| Filing | 9 | A decision is filed `pending` and audited first; the category comes from the policy check and the caller cannot set a category, status or resolver; an action the policy allows needs no decision; a card the checker rejects is refused and the stored card is the checked copy; an unknown tool is filed as `unknown`; nothing is written if the audit log is down; bad input is refused before anything is written |
| Answering | 13 | Approving records who and when; **the phone and the dashboard answering at once take effect once** (six rounds); approve against reject at once, and a burst of ten, leave one winner and everyone is told the truth; answering again changes nothing; a final decision cannot be flipped; "ask more" then decide works, and asking twice changes nothing; an unknown id is "not found"; bad input and channels other than the founder's two are refused; the audit entry comes before the write; nothing is written if the audit log is down or the runtime is blocked; a key or token pasted into a note or card is not stored |
| Cancelling | 2 | A cancelled decision stays closed; cancelling a decided one changes nothing |
| Live screens | 1 | The live event stream hears about a new and a decided decision exactly once, with no card text |
| Reminders | 7 | A reminder never changes a status, a resolver or a time of answer; it waits for the interval; it stops at the limit and the card stays waiting; only waiting cards are chased; two runs at once remind once; a failed notification gives its claim back so the next run retries; a deadline passing does not approve |

Checked by mutation on Nov 23, 2026: 35 realistic mistakes were introduced into `decisions.js` one at a time (no compare-and-set guard, conflicts never or always reported, every caller told it changed something, an answer or a cancel allowed from a final status, the caller allowed to choose the category, an allowed action still filed, the card unchecked or stored raw, the audit entry optional or written after the write, any channel or an `agent` channel accepted, unknown options accepted, a blocked runtime still answering, an unknown id looking fine, a pasted secret stored, money unvalidated, a duplicate answer announced, card text in an event, a non-atomic reminder claim, a failed notification or an unauditable reminder keeping its claim, the reminder limit or interval ignored, a reminder that approves past a deadline, an overlapping or app-pinning reminder job). All were caught by the eval, the unit tests or the invariants, except one that is an **equivalent mutant**: making the reminder query return answered decisions changes nothing, because the reminder claim is itself guarded by `status = 'pending'`, so the rule is protected twice. Two things went wrong along the way and were fixed: the harness also ran the `invariants` suite, which was failing for an unrelated reason (this file was behind), so every result looked "caught" (the run was stopped, this file updated, and a "baseline must be clean" check added before any mutation); and one mutation's edits overlapped and did not apply, so it was re-run on its own.

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

## Planned evals (not built yet)

Each is added before the code it grades, in the step shown. Move it into the registry above when written.

| Planned suite | Grades | Plan step | Kind |
|---|---|---|---|
| `card-writer` | The model step that rewrites a request into a plain-language card, graded by the card checker plus a judge model | after 1.3 | model-graded |
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
