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
| `invariants` | The repo itself: architecture, security settings, docs in sync | 9 | 100% | 0.4 | pass |
| `policy-check` | `src/runtime/policy.js` | 32 | 100% | 1.4 | pending |
| `decision-cards` | `src/runtime/cards.js` | 15 | 100% | 1.5 | pending |
| `claude-code-provider` | `src/runtime/providers/claude-code.js` | 12 | 100% | 1.3 | pending |

Update the "Today" column when a suite's status changes.

## Suites

### invariants

Suite: `.claude/evals/suites/invariants.js`. No dataset; each case is a check function in the suite file. Runs against the repo today.

**Cases:** 9

| Case | Rule it protects |
|---|---|
| `runtime-never-imports-electron` | `src/runtime/` stays free of `electron` imports so it can run headless later |
| `window-security-flags` | `src/main.js` keeps `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| `renderer-csp-strict` | `index.html` has a CSP with `default-src 'self'` and no `'unsafe-inline'` or `'unsafe-eval'` |
| `dev-csp-relaxation-serve-only` | `electron.vite.config.mjs` may loosen the CSP for hot reload only with `apply: 'serve'`, so production builds keep the strict CSP |
| `preload-no-raw-ipcrenderer` | `src/preload.js` never hands `ipcRenderer` itself to the renderer |
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

## Planned evals (not built yet)

Each is added before the code it grades, in the step shown. Move it into the registry above when written.

| Planned suite | Grades | Plan step | Kind |
|---|---|---|---|
| `card-writer` | The model step that rewrites a request into a plain-language card, graded by the card checker plus a judge model | after 1.3 | model-graded |
| `decisions-service` | Resolving the same decision twice, from phone and dashboard, changes nothing the second time; nothing is auto-approved | 1.6 | deterministic |
| `orchestrator-approval` | A goal containing a spend pauses the graph and resumes when approved | 1.7 | deterministic |
| `mcp-tagging` | Every tool is tagged read or write; write tools that spend, send, deploy or sign go through the policy check | 1.10 | deterministic |
| `outbound-review` | An outbound client message can't be sent without review, and the first-2-weeks setting forces a decision | 2.2 | deterministic |
| `pod-isolation` | An agent in pod A can't read pod B's files, repo, memory or client data | 3.2 | deterministic |
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
