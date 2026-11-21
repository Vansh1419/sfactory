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

**0.1 Accounts and keys** (half a day) — status: `.env.example` done; the accounts and keys **need the founder**
- Create the GitHub repo and the Supabase project. *(founder)*
- Get a Groq key (Gemini and OpenRouter are deferred) and check whether Ollama is installed locally. Create the Telegram bot with BotFather and find your chat ID. *(founder)*
- Put every key in `.env` (gitignored). `.env.example` with names only: **done**, and an invariant checks it never holds values.
- **Done when:** each key works from a one-line test call, and `git status` shows no secret files.

**0.2 Repo restructure and tooling** (one day) — status: **done** (the `npm start` window check is manual)
- Folders `src/runtime/`, `src/shared/`, `config/mcp/` and `.claude/skills/` created (empty, with `.gitkeep`, until their steps). Sources stay at `src/main.js` and `src/preload.js`; `package.json` `main` is the built `out/main/main.js`.
- Renderer bundler: **done.** `electron-vite` 6 with Vite 8, React 19 and Tailwind CSS 4 (`@tailwindcss/vite`), configured in `electron.vite.config.mjs`. Scripts: `dev`, `build`, `start` (preview of the production build). The production CSP stays strict; a dev-only plugin relaxes it under `electron-vite dev` only.
- `node:test` and the `npm test` script: **done** (tests of the eval runner).
- The check that fails if anything under `src/runtime/` imports `electron`: **done** (`invariants` suite).
- **Done when:** `npm run build` succeeds, `npm start` opens the window, `npm test` passes, and the import check passes.

**0.3 Charter and docs** (half a day) — status: draft written; **needs the founder** to fill in the mission
- Company charter: **draft v0.1 written** at `.claude/skills/shared/company-charter/SKILL.md` from the kickstart (rules for every agent, what always needs the founder, the 7-field approval format). The mission, company name, entity type, first service and first product are marked **[Founder to fill in]**, not guessed. This becomes the shared base prompt.
- `CLAUDE.md` updated with the new commands and structure and links to `PLAN.md` and `EVALS.md`: **done**.
- **Done when:** the charter is in `.claude/skills/shared/company-charter/SKILL.md` and `CLAUDE.md` matches the repo.

**0.4 Eval setup** (half a day, **built first**) — status: runner, datasets and invariants written
- `.claude/evals/run.js` runs every suite in `.claude/evals/suites/` and writes `.claude/evals/results/latest.json` (gitignored). `npm run eval` treats unwritten code as "pending"; `npm run eval:strict` (used at every phase gate) treats pending as a failure.
- Golden datasets are written before the code they grade, so the code is built to pass them:
  - `policy-check` (32 cases) grades `src/runtime/policy.js`: the four always-ask categories, deny-by-default, and resistance to notes like "the founder already approved this".
  - `decision-cards` (15 cases) grades the checker in `src/runtime/cards.js`: required fields, jargon, code, ₹ and $ cost, IST times.
  - `invariants` grades the repo today: no `electron` import under `src/runtime/`, window security flags, strict CSP, no raw `ipcRenderer` in the preload, the dev-only CSP relaxation stays `serve`-only, secrets and results gitignored, `.env.example` holds names only, all Claude documents stay under `.claude/`, `EVALS.md` in sync.
- Input and output contracts for the two modules are in the header of each suite file.
- `.claude/EVALS.md` is the registry of every eval (existing and planned). It is kept current by hand, and the `evals-doc-in-sync` invariant fails if a suite or its case count is missing or stale.
- Each later step that ships code adds its own cases first (see the **Eval first** lines in Phase 1).
- Not built yet: model-graded evals (an LLM judging the writer's cards, agent behavior in the orchestrator). They need the model router (1.3), so they are added after it.
- **Done when:** `npm test` passes, `npm run eval` passes `invariants` and reports the other two suites as pending, and no suite can pass with zero cases.

**Gate 0:** app launches, tests and evals run, secrets are out of git, charter is written.

### Phase 1: Approval spine (days 3–7)

**1.1 Database schema** (one day)
- Write migrations for `tasks`, `agents`, `decisions`, `audit_log`, `memory`, `clients`, `projects`, `agent_events`, `pods`, `pod_members` and `scaling_rules`.
- Add row-level security so a pod can only read its own rows. Add pgvector for `memory`.
- Add seed data for one fake pod and one fake agent.
- **Done when:** migrations apply to a clean Supabase project, and a test shows a query scoped to pod A cannot return pod B's rows.

**1.2 Runtime skeleton and IPC** (half a day)
- Main process starts and stops the runtime. Runtime loads config and env, and exposes a small command and event interface.
- Preload exposes a narrow `window.api` (`decisions.list`, `decisions.resolve`, `agents.pause`, event subscription).
- Add an `audit_log` writer used by everything that follows.
- **Done when:** the renderer calls `window.api` and gets a response from the runtime, and the call appears in `audit_log`.

**1.3 Model router** (one and a half days; the Claude Code provider adds about half a day)
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

**1.4 Policy check** (half a day)
- A pure function that classifies a proposed action into the four always-ask categories, and denies by default when unsure.
- One unit test per category, plus tests for ambiguous actions.
- **Done when:** every test passes, and no code path can mark an action allowed without the function returning allow.

**1.5 Plain-language writer and checker** (one day)
- Writer rewrites a technical request into the fixed 7-field card (₹ and $, IST, "Show details" for technical text).
- Checker rejects jargon, code or any missing field, and sends the card back to the writer, with a retry limit.
- Test against a fixed set of good and bad cards, including the kickstart's "Before / After" example.
- **Done when:** all bad cards are rejected, all good cards pass, and a card that fails the retry limit is flagged, never sent.

**1.6 Decisions service** (half a day)
- One function that creates a decision, one that resolves it, and a reminder job for unanswered cards. Nothing is ever auto-approved.
- Resolving is idempotent, so approving twice (phone and dashboard) changes nothing the second time.
- **Done when:** a test resolves the same decision from two sources at once and only one write takes effect.

**1.7 Orchestrator graph** (one day, starting with a half-day spike)
- Spike: confirm LangGraph JS can pause for human approval and resume, and that `@langchain/mcp-adapters` loads a tool. Decide go or fall back before building more.
- Build the orchestrator graph: take a goal, create tasks, run the policy check on each action, create a decision card and pause when needed.
- **Done when:** a goal that includes a spend pauses the graph, and resolving the decision resumes it.

**1.8 Telegram bot** (half a day)
- Push cards with Approve and Reject buttons. Add `/brief`, `/status <team>` and `/pause <agent>`.
- Accept only the founder's chat ID.
- **Done when:** a card arrives on the phone, a tap resolves it through the decisions service, and a message from another chat is ignored.

**1.9 Approval queue screen** (half a day)
- First renderer page: list of cards in the 7-field format, Approve / Reject / Ask-more buttons, "Show details" toggle.
- Updates live when the bot or an agent changes a decision.
- **Done when:** a card approved on the phone disappears from the queue without a refresh.

**1.10 MCP loader and first tools** (half a day)
- Read `shared.yaml` plus a team YAML, tag every tool read or write, and route write tools that spend, send, deploy or sign through the policy check.
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
- Check the data-training terms of each provider in use (Groq and Claude Code in v1, plus any added later) and Anthropic's terms for running Claude Code unattended and route sensitive text to local Ollama or not at all. List the items for a CA and a lawyer (company registration, GST for exports, DPDP, GDPR, client contracts stating AI use, FIRC/FIRA).
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
- [x] Third fallback: Claude Code running in the background with Haiku at low effort (decided Nov 21, 2026; step 1.3). Feasibility checked: it works on the existing login with no API key set.
- [ ] Which tiers may the Claude Code fallback serve? Proposed: the cheap tier always; the strong tier (planning, anything reaching the founder) only as a last resort, and only if the result still passes the card checker.
- [ ] Is it allowed to run Claude Code unattended from this app on your own login? Check Anthropic's current terms and usage limits before enabling it. It shares your limits with your own sessions. If it is not allowed, the alternative is an API key, which is paid usage and counts as spend.
- [ ] When the runtime later moves to a server, `claude` must be installed and logged in there too. Decide whether the Claude Code fallback is enabled on the server.
- [ ] Which Ollama model is the fallback, and which is allowed for sensitive text? Only models that run on this machine count as local: `kimi-k2.7-code:cloud` and `glm-5:cloud` carry the `:cloud` tag, which normally means Ollama forwards the request to a remote service. The router must not treat them as private, so step 1.3 should keep a list of models allowed for sensitive text. Candidates already installed and local: `qwen3.5:27b`, `qwen3.5:latest`, `llama3:latest`, `mistral:latest`, `deepseek-r1:32b`.
- [x] Tray and start-at-login in v1 (decided Nov 21, 2026: included; built in step 4.4)
- [ ] Company name and legal entity type?
- [ ] Which agency service first, and which SaaS idea first?
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
