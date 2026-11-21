# AI-Driven Organization — Project Kickoff Blueprint

Nov 21, 2026 · @vansh

## Summary

One founder runs a company where AI agent teams do the daily work and only crucial decisions reach the founder. Version 1 must run in 2–4 weeks on free APIs.

**What we know from the interview**

| Topic | Answer |
| --- | --- |
| Business | Software/SaaS + Agency services, both in parallel |
| Teams | Product & Engineering, Marketing & Sales, Customer Support, Finance/Legal/Ops |
| Stage | Just an idea |
| Founder skill | Developer |
| AI stack | Mix: multiple models + an orchestration framework |
| Budget | Free APIs to start |
| Founder interface | Custom dashboard + WhatsApp/Telegram |
| Spend approval | Every amount needs founder approval |
| Market | Global customers, company in India |
| First version | 2–4 weeks |

**Scope of v1:** an orchestrator, 4 team leads, a few worker agents each, one approval queue, one dashboard, one Telegram bot. No real money moves without the founder.

## Org structure

You talk to one agent, the Orchestrator; it splits goals into tasks, gives them to team leads, and sends only crucial items back to you.

&#91;embedded content: org structure · founder, orchestrator, 4 teams\]

Each team lead plans its team's work and checks its workers' output before marking a task done.

| Team | Main job | Key numbers it reports |
| --- | --- | --- |
| Product & Engineering | Build SaaS + client projects | Tasks shipped, bugs open, PRs waiting |
| Marketing & Sales | Find and win clients | Leads, replies, proposals sent, deals won |
| Customer Support | Help clients and users | Tickets open, reply time, satisfaction |
| Finance, Legal & Ops | Money, contracts, process | Revenue, invoices due, spend requests |

## Multiple projects and scaling

Every project runs in its own pod, specialists are shared by all pods, and the orchestrator adds or removes agents by workload up to a cap you set.

&#91;embedded content: multi-project model · pods + shared specialists\]

**How it works**

1. **New project** — the orchestrator creates a pod from a template (agency client or SaaS product).
2. **Priority** — each project has a priority (P1–P3) and a deadline; shared specialists serve higher priority first.
3. **Isolation** — each project has its own memory, files, repo and client data; pod A cannot read pod B.
4. **Scale up** — when a role's task queue or wait time passes a threshold, the orchestrator adds an agent of that role.
5. **Scale down** — idle agents are removed; a pod closes when its project ends.
6. **Dashboard** — a per-project view: progress, agents in the pod, blockers, deadline.

| Situation | Action | Needs you? |
| --- | --- | --- |
| Queue or wait time over threshold | Add an agent of that role | No, if under the cap |
| Agent idle | Remove it | No |
| New agent would pass the cap | Decision card | Yes |
| New client project | Create a new pod | Yes (signing a client is already your call) |
| Two projects need the same specialist | Higher priority goes first | No; you see it in the brief |

On free APIs, rate limits are the real ceiling: more agents means more calls, so the cap must stay within your free-tier limits.

**New tables:** `pods`, `pod_members`, `scaling_rules`.

## Decision rights

Agents act alone on routine work; four kinds of action always stop and wait for you.

&#91;embedded content: approval flow · 1 policy check, 1 founder decision\]

A policy check (code, not an AI guess) decides if an action is crucial, so an agent cannot talk its way past it.

| Always needs you | Teams handle alone |
| --- | --- |
| Any spending, any amount | Research, drafts, internal planning |
| Hiring, firing, signing clients/vendors/freelancers | Writing code and opening pull requests |
| Production launches and price changes | Answering routine support tickets |
| Legal documents and public statements | Bookkeeping entries, reports, reminders |

**Each decision card shows:** what, why, cost, risk, options, the agent's recommendation, and a deadline. Unanswered cards are reminded after a set time and never auto-approved.

### Approvals in plain language

Every approval request, on the dashboard and on Telegram/WhatsApp, is written so a non-technical person understands it in under 30 seconds.

**Rules**

- Short sentences, everyday words; no code, jargon or abbreviations.
- If a technical word cannot be avoided, explain it in brackets.
- Money shown in ₹ and $; times in IST.
- Technical details stay hidden behind a "Show details" button.
- Same fixed format every time:
  1. What do you need to decide?
  2. Why now?
  3. If you say yes — what happens
  4. If you say no — what happens
  5. Cost
  6. Risk: Low / Medium / High, with one line why
  7. Our recommendation

**How it is enforced:** the agent's request goes to a writer step that rewrites it in plain language, then a checker step rejects any card with jargon, code or missing fields. Only cards that pass reach you.

**Example**

| Before (technical) | After (what you see) |
| --- | --- |
| Approve deploy of v1.3 to prod; DB migration on users table, rollback via snapshot. | The new login page for Client A is ready. Can we make it live for their customers? **Yes:** it goes live tonight. **No:** it waits until you decide. **Cost:** ₹0. **Risk:** Low — we can switch back to the old page if anything goes wrong. **We recommend:** Yes. |

## Tech architecture

Use one orchestration framework, a model router, and one database. Everything below has a free tier or is open-source; free-tier limits change often, so check each provider before building.

| Layer | Recommended pick | Why |
| --- | --- | --- |
| Orchestration | LangGraph (Python) | Stateful agent graphs, built-in pause for human approval |
| Model router | LiteLLM | One API for many models; swap or fall back without code changes |
| Models (free) | Gemini free tier, Groq, OpenRouter free models, Ollama (local) | Mix of quality, speed and zero cost |
| Database + memory | Postgres + pgvector (Supabase free tier) | Tasks, decisions, logs and agent memory in one place |
| Backend API | FastAPI | Serves the dashboard and bot |
| Dashboard | Next.js (Vercel free tier) | Approval queue, team status, reports |
| Mobile approvals | Telegram Bot API (free) first; WhatsApp Cloud API later | Telegram is free and fast to build; WhatsApp needs Meta business setup |
| Agent tools | GitHub, email, web search, docs | Each team gets only the tools it needs |
| Hosting | Your own machine or a free/cheap VPS | Agents run as background workers |

**Model routing rule:** cheap/fast model for simple tasks (sorting, drafts), strongest available model for planning, code review and anything that reaches the founder.

**Core data tables:** `tasks`, `agents`, `decisions` (approval queue), `audit_log`, `memory`, `clients`, `projects`.

## Connectors, MCP servers and skills

Each team gets only the tools and skills it needs, set in one config file per team and loaded into LangGraph through [langchain-mcp-adapters](https://github.com/langchain-ai/langchain-mcp-adapters).

- **Connector** = the account link (API key or login) to an outside app.
- **MCP server** = the bridge that lets an agent use that app as a tool.
- **Skill** = a folder with a `SKILL.md` file: written instructions on how to do one job well. Works with any model, because it is loaded into the agent's prompt.

### Where to add them

```
config/mcp/
  shared.yaml         # loaded by every agent
  orchestrator.yaml
  engineering.yaml
  marketing_sales.yaml
  support.yaml
  finance_ops.yaml
skills/
  shared/<skill>/SKILL.md
  engineering/<skill>/SKILL.md
  ...one folder per team
.env / secrets vault  # API keys, never in git
```

When the orchestrator creates an agent, it loads `shared` + that team's MCP config + that team's skills. Inside a project pod, file and git tools are limited to that project's folder.

### MCP servers

| MCP server | Team | Add in | Use |
| --- | --- | --- | --- |
| Filesystem (official reference) | All | Week 1 | Read/write files, limited to the project folder |
| [GitHub](https://github.com/github/github-mcp-server) (official) | Engineering, all pods | Week 1 | Repos, issues, pull requests |
| Fetch (official reference) | All | Week 1 | Read web pages |
| [Supabase](https://mcp.so/blog/best-mcp-servers) (official) | Orchestrator, Ops | Week 1 | Tasks, projects, reports; read-only for most agents |
| Gmail / Google Drive | Marketing & Sales, Support | Week 2 | Outreach, client replies, shared docs |
| HubSpot (free CRM) | Marketing & Sales | Week 2 | Leads and deals (remote MCP works on the free plan) |
| Search: Exa, Firecrawl or Brave | Marketing & Sales | Week 2 | Market and lead research (free tiers vary) |
| [Playwright](https://mcp.so/blog/best-mcp-servers) (official, Microsoft) | Engineering QA, Marketing | Week 3 | Test websites, check competitor pages |
| Context7 | Engineering | Week 3 | Up-to-date library docs while coding |
| [Razorpay](https://razorpay.com/docs/mcp-server) (official) | Finance | Week 3 | Payment links, payment status (India) |
| [Zoho Books](https://www.zoho.com/in/books/help/mcp/zoho-books-mcp.html) (official) | Finance | Week 3 | Invoices, expenses, GST records |
| Stripe (official) | Finance | Later | Global client payments, if you use Stripe |
| Sentry (official) | Engineering / DevOps | After launch | Error reports from live products |
| Vercel or Cloudflare | DevOps | Week 4 | Preview and live deploys |

**Safety rule:** every MCP tool is tagged *read* or *write*. Write tools that spend money, send messages outside, deploy or sign anything go through the policy check and your approval first.

The Telegram/WhatsApp bot is built in-house (FastAPI), not as an MCP server, because it is your control channel.

### Sales, marketing and development tools

Linked tools have an official MCP server from the vendor itself. Check each tool's free-plan limits before you sign up. These are suggestions; swap any of them.

| Area | Tool | What the agents do with it | Team config |
| --- | --- | --- | --- |
| Sales | [HubSpot CRM](https://developers.hubspot.com/changelog/remote-hubspot-mcp-server-is-now-generally-available) | Store leads and deals, update stages | `marketing_sales.yaml` |
| Sales | [Apollo.io](https://docs.apollo.io/docs/apollo-mcp) | Find prospects, enrich contacts, run outreach sequences | `marketing_sales.yaml` |
| Sales | [Cal.com](https://cal.com/docs/mcp-server) | Book discovery calls with leads into your calendar | `marketing_sales.yaml` |
| Sales | Gmail / Google Drive | Send proposals, follow-ups | `marketing_sales.yaml` |
| Marketing | [Brevo](https://developers.brevo.com/docs/mcp-protocol) | Email campaigns, contact lists, campaign results | `marketing_sales.yaml` |
| Marketing | [Google Analytics](https://developers.google.com/analytics/devguides/MCP) | Read website traffic and conversions (read-only) | `marketing_sales.yaml` |
| Marketing | Exa, Firecrawl or Brave + Playwright | Market research, competitor pages, SEO checks | `marketing_sales.yaml` |
| Development | GitHub | Code, pull requests, issues | `engineering.yaml` |
| Development | [Figma](https://github.com/figma/mcp-server-guide) | Turn designs into front-end code | `engineering.yaml` |
| Development | Context7 | Current library docs while coding | `engineering.yaml` |
| Development | Playwright | Test websites like a real user | `engineering.yaml` |
| Development | Supabase | Database for SaaS and client apps | `engineering.yaml` |
| Development | Sentry | Error reports after launch | `engineering.yaml` |
| Development | Vercel or Cloudflare | Preview and live deploys | `engineering.yaml` |
| Development (optional) | [Linear](https://www.builder.io/blog/linear-mcp-server) | Only if you want an issue tracker beyond your own task board | `engineering.yaml` |

**Approval rules still apply:** sending a campaign, starting an outreach sequence, or deploying to production goes to you first, written in plain language.

### Skills to write

| Team | Skills (`skills/<team>/...`) |
| --- | --- |
| Shared | company-charter, plain-language-approval, escalation-rules, handoff-notes |
| Orchestrator | task-breakdown, pod-creation, scaling-rules, priority-rules |
| Product & Engineering | git-workflow (PRs only), code-review, testing, deploy-checklist |
| Marketing & Sales | ideal-client-profile, cold-outreach, proposal-writing, seo-content, brand-voice |
| Customer Support | ticket-triage, reply-tone, refund-and-complaint escalation, client-onboarding |
| Finance, Legal & Ops | invoice-with-GST, expense-recording, contract-review, data-privacy-check (DPDP/GDPR) |

Write the shared skills in week 1; each team's skills arrive in the same week as that team.

## Founder interface

The dashboard is the full control room; Telegram/WhatsApp is for quick approvals on the phone.

**Dashboard pages**

1. **Approval queue** — each item shows: what, why, cost, risk, the agent's recommendation, and Approve / Reject / Ask-more buttons.
2. **Teams** — live status of each team, open tasks, blocked tasks.
3. **Daily brief** — revenue, leads, tickets, deployments, spend requests.
4. **Audit log** — every agent action, searchable.
5. **Settings** — rules, approval limits, kill switch per agent or team.

**Mobile bot commands**

- Push: new approval request with Approve / Reject buttons
- `/brief` — today's summary
- `/status <team>` — team status
- `/pause <agent>` — emergency stop
- Morning digest at a fixed time (IST)

**Rule:** an approval on the phone and on the dashboard write to the same `decisions` table, so nothing is approved twice.

### Project view

Selecting a project opens one screen with three panels: its files, its agents, and a live feed of the selected agent.

&#91;embedded content: project view · files, agents, live feed (example content)\]

| Panel | You see | You can do |
| --- | --- | --- |
| Files | Full folder tree of the project, file history | Open, edit, upload, see who changed what |
| Agents | Every agent in the pod: role, status (working / waiting / blocked / idle), current task | Pause / resume, send a message, reassign the task |
| Live feed | Click an agent: each step as it happens (file read, file written, tool used, test run, help asked) | Type an instruction straight to that agent |

**How it is built**

- **Files:** one git repo per project; the tree reads from it, so every change (yours or an agent's) has history and can be undone.
- **Your edits:** saving a file creates an event; agents working on that file are told to reload it before their next step.
- **No clashes:** a file being edited by you is locked for agents until you save.
- **Live feed:** every agent step is written to an `agent_events` table and pushed to the dashboard in real time (WebSocket / Supabase Realtime).
- **Controls:** pause, message and reassign are logged in the audit log like any other action.

## 4-week build plan

Build the approval spine first, then the client-facing teams, then engineering and finance, and go live in week 4.

&#91;embedded content: 4-week build plan · one gate per week\]

A week is done only when its gate passes. Client-facing teams come before engineering because the agency side brings the first money.

## Risks and guardrails

The biggest risks are agents acting wrongly in public, free-API limits, and legal gaps; each has a simple guardrail.

| Risk | Guardrail |
| --- | --- |
| Agent sends wrong email / message to a client | All outbound client messages go through a review agent; first 2 weeks, founder approves every outbound message |
| Agent spends money | Agents hold no payment credentials; every payment is a founder approval |
| Code breaks production | Agents open pull requests only; deploy to production = founder approval |
| Free API rate limits / downtime | LiteLLM fallback chain across providers; task retries with backoff |
| Free tiers may use your data for training | Check each provider's terms; never send client secrets to those models |
| Runaway loops | Max steps and max tokens per task; daily task cap per agent |
| Hallucinated facts in sales/legal output | Legal and public statements always go to founder (already a rule) |
| Secrets leak | Secrets in env vars / vault, never in prompts or logs |

**India + global compliance (to confirm with a CA / lawyer):**

- Company registration (e.g. Pvt Ltd or LLP) and GST for export of services
- India DPDP Act 2023 for personal data you handle
- GDPR if you serve EU clients
- Client contracts must state AI is used to deliver the work
- Foreign payments via a compliant gateway (FIRC/FIRA for export income)

This is not legal advice; a CA and a lawyer should confirm it.

## Open questions and next steps

These answers are still needed before or during week 1.

- [ ] Company name and legal entity type?
- [ ] Which agency service first (web dev, marketing, content, AI automation)?
- [ ] Which SaaS idea first, and for which customer?
- [ ] Hosting: own machine or a VPS?
- [ ] Telegram first, or WhatsApp from day one?
- [ ] When budget appears, which paid model gets priority?
- [ ] Should client calls/meetings be human-only (you) or AI-assisted?
- [ ] Agent cap: max agents in total and per pod?
- [ ] Scale-up threshold: how many waiting tasks or hours of wait before adding an agent?
- [ ] Max projects running at once in v1?

**Start today**

- [ ] Create GitHub repo + Supabase project
- [ ] Get free API keys (Gemini, Groq, OpenRouter)
- [ ] Create Telegram bot
- [ ] Write the company charter: mission, rules, approval policy (agents read this as their base prompt)