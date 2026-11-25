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
| `invariants` | The repo itself: architecture, security settings, docs in sync | 13 | 100% | 0.4 | pass |
| `policy-check` | `src/runtime/policy.js` | 44 | 100% | 1.4 | pass |
| `decision-cards` | `src/runtime/cards.js` | 52 | 100% | 1.5 | pass |
| `claude-code-provider` | `src/runtime/providers/claude-code.js` | 12 | 100% | 1.3 | pass |
| `model-router` | `src/runtime/router.js` | 35 | 100% | 1.3 | pass |
| `http-providers` | `src/runtime/providers/{groq,ollama,index}.js` | 21 | 100% | 1.3 | pass |
| `telegram-bot` | `src/runtime/telegram/{bot,api,poller}.js` | 72 | 100% | 1.8 | pass |
| `database-schema` | `supabase/migrations/*.sql` and `supabase/seed.sql` | 30 | 100% | 1.1 | pass |
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
| `skills-loader` | `src/runtime/agents/skills.js` (shared plus a team's skills) | 10 | 100% | 2.1 | pass |
| `agent-loop` | `src/runtime/agents/agent.js` (one agent's step loop) | 20 | 100% | 2.1 | pass |
| `team-framework` | `src/runtime/agents/{lead,team,index}.js` (lead, workers and the factory, on a real database) | 21 | 100% | 2.1 | pass |
| `outbound-review` | `src/runtime/outbound/{review,settings}.js` (the review agent and the founder-approval setting) | 15 | 100% | 2.2 | pass |
| `outbound-gate` | `src/runtime/outbound/{service,tools}.js` (the step 2.2 done-when, on a real database) | 20 | 100% | 2.2 | pass |
| `goals-view` | `src/renderer/goals.mjs` (the logic behind the window's Goals panel, including the Download button) | 27 | 100% | 1.9 follow-up | pass |
| `runtime-core` | `src/runtime/{config,audit,runtime,commands}.js` and `src/ipc-guard.js` | 30 | 100% | 1.2 | pass |
| `decisions-service` | `src/runtime/decisions.js`, against a real Postgres with the migrations | 32 | 100% | 1.6 | pass |
| `policy-tools` | `src/runtime/policy-tools.js` (the founder adding tools from Telegram), against a real Postgres | 22 | 100% | 1.6 follow-up (used by the bot in 1.8) | pass |

Update the "Today" column when a suite's status changes.

## Suites

### invariants

Suite: `.claude/evals/suites/invariants.js`. No dataset; each case is a check function in the suite file. Runs against the repo today.

**Cases:** 14

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

**Cases:** 72

Contract: `createBot({ api, founderChatId, decisions, policyTools, orchestrator?, onError? })` returns `handleUpdate(update)`, `pushCard(decision)` and `notifyReminder(decision)`; `createTelegramApi({ token, fetchImpl })` and `createPoller({ api, handle, sleep, onError })` are the thin layers around it. The full contract is in the header of the suite file.

| Group | Cases | What it checks |
|---|---|---|
| Only the founder | 5 | A message or a button tap from any other chat does nothing (no reply, no service call); the sender must be the founder even inside the founder's chat; the chat id matches as a string or a number; garbage updates never throw |
| Cards | 7 | A card goes to the founder's chat with Approve and Reject buttons; the text shows all seven fields and never the "Show details" text; button data fits Telegram's 64-byte limit; a card that is not pending is never sent; a reminder says it is a reminder; a very long card is cut below 4096 characters; every message is plain text with no parse mode |
| Taps | 13 | A database problem is explained in a sentence that says what to do (a missing table points to the migrations, an unreachable database to the connection, a rejected key to `SUPABASE_SERVICE_ROLE_KEY` in `.env`), and any other database error stays generic with the store's own text never shown (added after the first real-Telegram try, Nov 24, 2026); if editing the message fails after an answer or a policy confirm, the outcome is sent as a new message and the founder is never told "nothing was changed"; a failing callback answer is reported to `onError`, never thrown (added after the code review of Nov 24, 2026). Approve and Reject resolve through the decisions service as `via: 'telegram'` and nothing else; the message then shows the answer and loses its buttons; every tap answers the callback so the spinner stops; a card answered elsewhere first is reported as it is, not as the tap; a raw error never reaches the founder (a pasted key included) while a `DecisionError`, which is written for the founder, does; bad button data calls nothing |
| Policy commands | 8 | `/tools` lists additions; `/addtool <tool> ask <category>` is active at once; the category words map to the four policy categories; a routine addition asks Yes or No first, and only Yes confirms (No cancels); `/removetool` removes; badly formed commands get help and call nothing; a `PolicyToolError` is shown and other errors are not |
| Add this tool | 4 | A tool name that is odd (newlines, spaces, over 100 characters, empty) is refused and never shown or proposed; an unknown-tool card offers the buttons and no other card does; the tool name comes from the stored decision, never from the button; the routine option asks for a Yes before it takes effect |
| Other commands | 5 | A command that fails is reported to `onError` while the founder gets the generic sentence; `/brief`, `/status` and `/pause` say they are not available yet (their data arrives with later steps) and call nothing; `/help` and `/start` list the commands; unknown commands and plain text get a hint and call nothing; `/tools@botname` works |
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

**Cases:** 21

The step 2.1 "done when" is the first two cases: a team of one lead and one worker completes a task (queued, in_progress, in_review, done, with the lead's review before done), and **the lead rejects a bad worker output once, the worker tries again with the feedback in its prompt, and the task is done**. Also: rejected twice blocks the task with a reason and it is never done; a review that is not a plain `accept: true` (yes, "true", 1, `{}`, garbage, no answer) counts as a rejection; zero allowed revisions blocks at the first rejection; a plan naming an unknown worker, empty, too long or garbled runs no worker and blocks the task; a two-subtask plan runs in order and stops at the first block; a worker that needs the founder blocks the task and hands the request back, a worker that stops or fails blocks it with a plain reason; every status change is audited before it is made and an audit failure leaves the status where it was; the audit log has the task from creation to done in order; agents are registered once with the right role and tier; a task with no or an odd title is refused with no row and no model call; a secret in a task is never stored or logged. The factory: builds a team from `shared` plus its own tools and skills and no other team's, refuses to build without the company charter, refuses unknown teams and odd names, reports config problems, never gives a team a tool with no policy rule, and passes its limits to every agent.

Checked by mutation on Nov 25, 2026: 14 deliberate breaks (a task done without the lead accepting, a truthy review counting as yes, status changes not audited, an unknown worker allowed in a plan, a crucial action run instead of handed back, the tool run not audited first, no step cap, tool output and final output not cleaned of secrets, no charter required, another team's tools loaded, the feedback not sent back, unlimited revisions, any team name reaching a folder), all caught.

### outbound-review

Suite: `.claude/evals/suites/outbound-review.js`. Code under test: `src/runtime/outbound/review.js` (`checkMessage`, `createReviewer`) and `settings.js` (`parseApprovalUntil`, `approvalRequired`). A scripted model.

**Cases:** 15

Covers: **code checks that cannot be argued with** (one recipient, a one-line subject, a body of sensible size, nothing that looks like a key, no unfinished placeholder text such as `[Name]` or `TODO`); a message that fails them never reaches a model. The **model review can only make it stricter**: only a plain `"pass"` passes, `escalate` means the founder must decide, and an odd answer, `PASS`, `true`, a pass that lists problems (a contradiction), no answer or a model that cannot be reached is a **fail**. The message is data in a random fence and the review is told what to look for (promises, legal or public statements, keys, claiming to be human). **The founder-approval setting fails safe**: `OUTBOUND_FOUNDER_APPROVAL_UNTIL` unset, empty, garbled or in the future means the founder approves every message; a date on its own means the end of that day in India; only a date that has clearly passed ends the period.

### outbound-gate

Suite: `.claude/evals/suites/outbound-gate.js`. Code under test: `src/runtime/outbound/service.js` (`createOutbound`) and `tools.js` (`email.submit`, `email.send`), the table `outbound_messages` (migration `20261125000000_outbound_messages.sql`). Real Postgres with the real migrations; the policy, decisions service, runtime event bus and reviewer are real (its model is scripted); the mail transport is a fake that records what it is asked to send.

**Cases:** 20

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

**Cases:** 30

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

**Cases:** 30

Contract: the full contract (function signatures, error codes, the store interface) is in the header of the suite file. Nothing here touches Electron, the network or a real database, so it runs in milliseconds. The Electron wiring (`src/main.js`, `src/ipc.js`, `src/preload.js`) is covered by the `invariants` checks, and by launching the real app (see PLAN.md step 1.2).

| Group | Cases | What it checks |
|---|---|---|
| Config | 4 | Both Supabase settings are required and problems name the setting, never the value; a URL that is not `*.supabase.co` or local is rejected, so the key can't be sent elsewhere; the printable description hides the key |
| Audit | 3 | Secrets in an entry (by field name, and by value shape: Groq, Anthropic, Supabase, JWT, Telegram) are redacted before writing; an invalid entry is refused and writes nothing; a valid entry becomes one `audit_log` row with the right columns |
| Command bus | 11 | Unknown commands are refused and not logged; **a command can choose which of its arguments the audit log keeps (a broken chooser records nothing rather than everything)**; malformed or oversized arguments are refused before anything runs; **the audit entry is written before the handler runs; if it cannot be written the handler never runs**; a crashing handler returns a generic message (no internals, no secrets) and the failure is audited; `CommandError` passes its code through; never-audited commands (status) skip the log and work without a database; events reach subscribers, with a wildcard, and a bad listener breaks nothing; a stopped runtime refuses everything; a blocked runtime refuses actions but still answers status |
| Commands | 6 | Exactly the four planned commands exist; `decisions.list` defaults to pending, caps the size and rejects bad options; `decisions.resolve` calls the decisions service as `dashboard` (the caller cannot pick the channel, a `via` is refused), passes its answer through, lets its plain errors reach the window, keeps other errors generic and answers `not_available` with no service; **the dashboard answer records that there was a note, not what it said, in the command audit entry**; `agents.pause` validates its arguments but refuses with `not_implemented` and changes nothing; status reports the database state without leaking the error |
| IPC guard | 2 | Only the app's own page (the built `index.html`, or the dev server's exact origin in dev only) is trusted; payloads must be a plain command name with plain-object arguments |

Checked by mutation on Nov 21, 2026: 8 realistic mistakes were introduced into the runtime one at a time (audit failure no longer blocking, internal errors leaking, redaction off, any file URL trusted, argument checks removed, status audited, a stopped runtime still accepting commands, the dev server trusted in production). All 8 were caught.

**`goals.list` (Nov 24, 2026):** the window gets one more read-only command, so the exact-command-list case is now `the-runtime-registers-exactly-the-planned-commands` and lists five. 4 new cases: it returns the orchestrator's goals and limits the size (1 to 50, default 20); with no orchestrator it says "not available"; a failing orchestrator gives a generic error that carries none of its text; and it is audited like any other command.

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
