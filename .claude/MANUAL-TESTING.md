# Manual testing guide

How to try every feature of sfactory by hand: what to do, what you should see (cause and effect), and the Telegram command that goes with it.
The automated checks (`npm test`, `npm run eval`) prove the code; this guide proves it on YOUR accounts and screen. Tick each box as you go.

Legend: **Do** = what you do. **Expect** = what should happen. **Audit** = the line to look for on the Audit log page. **Not connected** = the feature cannot be tried until that account is set up.

---

## 0. Before you start

| Check | How | Expect |
|---|---|---|
| [ ] Settings are in `.env` | `npm run check:keys` | One line per account (Groq, Telegram, Supabase, Ollama, Claude CLI, git hygiene), each OK. No secret is printed. |
| [ ] Database tables exist | `npm run db:migrate -- --dry-run`, then `npm run db:migrate` | Lists unapplied migrations, applies them in order. Running it again changes nothing. |
| [ ] All tables present | `npm run check:db` | All core tables found. |
| [ ] App starts | `npm run dev` (or `npm start` for the production build) | The window opens; the **Runtime** box says running and the database is connected. |
| [ ] Telegram works | Send `/help` to your bot | The list of commands. A message from any OTHER chat gets no answer. |
| [ ] Automated checks | `npm test`, `npm run eval`, `npm run build`, `npm run gate:1`, `gate:2`, `gate:3` | All pass. |

Tip: keep the **Audit log** page open; most tests below leave a line there.

---

## 1. Runtime and safety spine

### 1.1 Runtime status and block
- **Do:** open the window. Then put a wrong `SUPABASE_URL` in `.env` and restart.
- **Expect:** with settings right, status is running. With them wrong, the Runtime box says blocked and gives a plain reason (for example "Cannot reach the database"); actions are refused, the status still answers.
- **Audit:** `runtime.started` on a good start.

### 1.2 Approval cards (the core of the product)
- **Do:** `npm run gate:1` (a fake agent proposes a spend), or trigger any card in a section below.
- **Expect:** the same card appears on **Telegram** (buttons **Approve** and **Reject**) and in the window's approval queue. Tap one: Telegram shows "Approved. You answered this on Telegram." and the window updates by itself. Answering on the other screen afterwards says "Already approved/rejected": a card is answered once.
- **Cause and effect:** approve → the held action runs once; reject → nothing happens. An unanswered card gets reminders.
- **Audit:** `decision.created`, `decision.resolved`, and the action itself.

### 1.3 Card wording
- **Do:** read any card.
- **Expect:** plain language, a risk level, costs in both ₹ and $, times in IST, technical detail only under "Show details". A card that cannot be made plain is never sent.

### 1.4 Policy check
- **Do:** ask an agent for something crucial (spend money, send mail, merge, deploy, sign).
- **Expect:** the agent stops and a card is made; nothing runs before you answer. Unknown tools are denied by default.

### 1.5 Adding your own tool rules (Telegram only)
| Command | Expect |
|---|---|
| `/tools` | Lists the tools you added (or says none). |
| `/addtool stripe.refund ask spend` | Active at once: from now on that tool always asks you first. (Categories: spend, people, launch, legal.) |
| `/addtool notes.read routine read` | A card asks "Yes, let it run" / "No, keep asking me"; only Yes loosens the rule. |
| `/removetool stripe.refund` | Removed at once. |

- Also try an unknown tool name from an agent: the card has an **Add this tool** button.
- Window: **Settings → Tools you added** shows the same list (read only).

### 1.6 Kill switches and pauses
| Command | Expect |
|---|---|
| `/pause Aria` | "Paused Aria. It stops at its next step." A running task becomes blocked with a plain reason. |
| `/resume Aria` | "Aria can work again." |
| `/pause team support` | The whole team is switched off; it takes no new work. |
| `/resume team support` | Switched on again. |
| `/pause Nobody` | "I could not find an agent called…". |

- Window: **Teams → Team switches** does the same for teams; the **Agents** page pauses one agent.

---

## 2. Goals and the daily brief

### 2.1 Goals
- **Telegram:** `/goal Get 5 new clients for web design this month`
- **Expect:** an acknowledgement at once; the plan arrives as a second message when the lead has planned. Any step that needs you becomes a card.
- **Window:** the **Goals** panel lists the goal, its tasks and where each stands; a finished goal has a **Download** button (one file as itself, several as a `.zip`).

### 2.2 Brief
- **Telegram:** `/brief`. **Window:** the **Brief** panel.
- **Expect:** one headline and seven sections (Waiting for you, Revenue, Leads, Tickets, Deployments, Spend requests, Shared specialists). **The window and the phone show the same lines.** Revenue and Deployments say "Not tracked yet" (no invented numbers). Up to five waiting cards, oldest first, with how long each has waited.
- **Morning digest:** set `DIGEST_TIME_IST` to two minutes from now (HH:MM, Indian time), restart. **Expect:** the brief arrives on Telegram once; restarting does not send it again that day. `off` disables it; a bad value disables it and the app says so.

### 2.3 Team status
- **Telegram:** `/status`, `/status sales`, `/status support`. **Window:** the **Teams** page.
- **Expect:** each team's agents (working / idle / paused), open and blocked tasks; the same words on both screens.

---

## 3. Marketing and Sales team (needs a model provider and Supabase; `TAVILY_API_KEY` for research)

### 3.1 Give it a lead
- **Telegram:** `/lead Acme Online Shoes https://acme-shoes.example hello@acme-shoes.example`
- **Terminal:** `npm run lead -- --company "Acme Ltd" --website https://acme.example --email hello@acme.example --price "₹50,000"`
- **Window:** Teams → Start work → the sales form.
- **Expect:** an acknowledgement; minutes later a result message. The lead is saved (status `lead`), and **a proposal email appears as a card** with the email text under "Show details". Nothing is sent to the company.
- **Cause and effect:** approve the card → the email is marked ready, and it goes out only through the mail transport (**Not connected yet**: with none, nothing can be sent). Reject → it is never sent.
- **Also try:** the same lead twice → a second email to the same address is refused as a duplicate.
- **Not connected without keys:** no Tavily key → no search tool; no Google keys → no Gmail/Drive tools (drafts only, never sending).

### 3.2 Outbound gate rules
- **Expect for every client message:** checked by code, then by a model that can only make it stricter, saved, then either ready or a card. While `OUTBOUND_FOUNDER_APPROVAL_UNTIL` is empty, in the future or not a date, **every** message needs your Yes. Set it to a past date to see the rule loosen (a review can still force a card).

---

## 4. Customer Support team

### 4.1 Tickets
| Command | Expect |
|---|---|
| `npm run ticket -- add --email ann@example.com --subject "Where is my invoice?" --message "I cannot find it."` | A ticket is saved as open. |
| `npm run ticket -- list` | Latest tickets and where each stands. |
| `npm run ticket -- work` (or `--id <id>`) | The oldest open ticket (or the one you name) is taken. |
| Telegram `/ticket` or `/ticket <ticket id>` | Same, started from the phone; the result comes as a second message. |

- **Routine ticket** (an invoice question): a reply is written, reviewed, and waits on a card; the ticket becomes answered only after a reviewed reply to that customer exists.
- **Refund / discount / complaint / legal / "I can't answer this"** ticket (try "I want my money back"): **a founder card**, the ticket becomes `escalated`, **nothing is written to the customer**. After you answer the card, Telegram sends a plain follow-up: nothing was done, the customer has heard nothing.
- **Cause and effect:** a run that does not finish puts the ticket back to open; two runs cannot answer one ticket.

---

## 5. Projects (pods)

### 5.1 Create
- **Terminal:** `npm run pod -- propose --name "Acme site" --template agency_client --priority P1 --deadline 2026-12-31 --note "Needs a booking page"` (templates: `agency_client`, `saas_product`). Needs `PODS_ROOT` in `.env`.
- **Expect:** ONE card; no folder yet. **Approve** → the project row, a folder named `<name>-<first 8 of the card id>` under `PODS_ROOT`, a git history with one commit, a first memory note and the template's agents. Reject → nothing is created. An approved card is also opened on the next start.
- `npm run pod -- list` lists the pods.

### 5.2 Priority and shared specialists
- `npm run pod -- priority <pod id> P1` (or P2, P3) → audited. `npm run pod -- queue` lists who waits for a shared specialist, highest priority first, then oldest. Changing priority re-orders what is waiting; running work is not interrupted.
- **Brief → Shared specialists** shows who goes first and who waits.

### 5.3 Isolation (try to break it)
- Put a secret word in each of two pods' files. Ask the Engineering or Finance team to work in pod A and to "look at the other project".
- **Expect:** nothing of pod B is ever visible (files, notes, repository, tasks). Tools that do not declare pod access are refused in a pod run.

### 5.4 Project files panel
- **Window → Project files:** pick a project; see the file tree and git history.
- **Edit** a file → agents cannot write it while you edit (they get a plain "Not done"); **Save** commits only that file as "Founder"; **Cancel** releases it. Upload a new file: refused over an existing one. Secret names (`.env`), `.git` and links are refused.

---

## 6. Engineering team (needs a project; `GITHUB_TOKEN` and `GITHUB_REPOS` for pull requests)

- **Telegram:** `/engineer Alpha | Add a contact page` (the project in words, then a bar)
- **Terminal:** `npm run engineer -- --pod <pod id> --title "Add a contact page" [--description …]`. **Window:** Teams → Engineering task.
- **Expect:** Dev makes the change on a new branch (`feature/…`, `fix/…`, `chore/…`, `docs/…` or `test/…` only), saves it, pushes it to the project's repository and opens **one pull request**; Tess reviews and says what was and was not checked. A project without a repository stops after saving and says so.
- **Cause and effect (the safety rules):**
  - Ask it to merge → **a card** tied to the project; approving it does nothing by itself (no merge tool exists); the follow-up says "Nothing was done".
  - Ask it to go live → **a card**; after you approve a production deploy the system (never an agent) starts it exactly once from `main` (needs `VERCEL_TOKEN`); the phone says how it went.
  - A preview deploy of a branch runs without a card (needs `VERCEL_TOKEN`).
  - A commit with a secret file name or key-looking text is refused; nothing is ever pushed to `main`, and nothing is forced.
- **Resume after approval:** when you approve an Engineering or Finance card whose task is blocked, the SAME task goes back to queued and continues; it is told that approval merged or paid nothing. A card approved while the app was closed is picked up once on start.
- Sentry: `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` let the team list a live product's recent errors (read only).

---

## 7. Finance, Legal and Ops team (needs a model provider and Supabase)

- **Telegram:** `/finance Invoice Acme Studio for the website design` or `/finance Alpha | Invoice the client for the website design`
- **Terminal:** `npm run finance -- --title "Invoice Acme Studio" [--description …] [--pod <pod id>]`. **Window:** Teams → Finance task.
- **Try four jobs:** an invoice draft; an expense record; reading a contract; a data-privacy check.
- **Expect:**
  - Invoice: GST worked out **in code**, never by the model: same state → CGST + SGST; different state → IGST; whole paise, and the parts always add up. The draft has **no invoice number** (you assign it) and is never sent.
  - Expense: a draft record only.
  - "Pay the vendor ₹20,000" / "sign this agreement" / "issue this legal document" → **a card**; approving does not pay or sign (no such tool exists); the follow-up says nothing was done.
- Razorpay and Zoho Books are **not connected**: the team holds no payment credentials.

---

## 8. Agents panel (live feed)

- **Window → Agents:** every agent with its status, and a **Live feed** of plain lines (each tool step, start, idle) that updates by itself; **Refresh** reloads.
- **Pause** an agent mid-task → it stops at its next step. **Send note** → the agent sees your note at its next step (up to 20 queued; the audit log keeps only its length). **Reassign** a waiting or blocked task to another agent of the same team (a shared specialist's only to another shared specialist). **Waiting tasks** lists what is queued.

---

## 9. Scaling and guardrails

### 9.1 Autoscaling
- `npm run scale` shows each team's queues; `npm run scale -- run` does one pass. The app also does it every `AUTOSCALE_EVERY_SECONDS` (default 60; `off` stops it; minimum 10).
- **Load test:** queue many tasks for one team (several `/ticket` runs or specialist requests).
- **Expect:** an agent is added ("Aria 2") when waiting tasks per agent reach the threshold, and work is shared out evenly; at the agent cap **one card** (`agent.add`) appears instead, and approving adds exactly one beyond the cap; when idle, one copy is removed per pass (never an original, a lead, or a working or paused agent). A project space closes when its project is completed or cancelled (set in the database).

### 9.2 Guardrails
- **Loop:** a run that makes 3 identical calls with identical results in a row is stopped before the model is asked again.
- **Daily cap:** default 40 runs per agent per India date; beyond it the run is refused without asking the model.
- **Kill switch:** section 1.6. Needs the `app_settings` migration (`20261128000000_app_settings.sql`); without it the defaults apply and the team switch says so.

---

## 10. Window pages

| Page | Do | Expect |
|---|---|---|
| **Audit log** | Search words; pick who (the founder / an agent / the system); an exact action name; one project; last N hours; **Show older entries** | Newest first, one plain line each, no secrets. It reads the newest 1,000 entries that fit your filters and says so. Every action from the tests above is findable. |
| **Settings → Limits** | Change the daily cap or loop repeats, **Save the limits** | Takes effect at the next step with no restart; out-of-range values are refused, not clamped; the change is audited with old and new value. |
| **Settings → Scaling rules** | Change a team's agent cap or thresholds, **Save this rule** | Used by the next autoscaler pass. |
| **Settings → Approvals** | Look | The client-message approval period is shown but NOT editable here: change `OUTBOUND_FOUNDER_APPROVAL_UNTIL` in `.env`. |
| **Teams → Start work** | Use the lead, ticket, finance and engineering forms | The job starts at once (two at a time); the end is announced; same result as the phone command. Refresh reloads (also on window focus). |

---

## 11. Tray and background running

- **Do:** close the window with the X.
- **Expect:** the app keeps running (tray icon: **Open sfactory**, **Start at login**, **Quit sfactory**). With the window closed, send `/brief` or approve a card on Telegram: it still works. Clicking the tray icon reopens the window; only **Quit** (or Cmd+Q or a shutdown) ends the app and records `runtime.stopped`.
- **Start at login:** works in an installed app only; in `npm run dev` the item is greyed out and says so.

---

## 12. Known gaps (do not report these as bugs)

- Mail transport not connected: nothing is ever sent to a client. Razorpay and Zoho Books: no tools. Cloudflare deploys: not built.
- Gmail inbox reader needs its migration and Google sign-in.
- Memory search is by words (no embedding model).
- No packaged installer yet, so start at login cannot be tried.
- Several live pieces have only been tested against stand-ins: the window pages, the tray, Vercel and Sentry, the Google tools and the phone digest. If one fails for you, that is its first real use: note the exact words you saw and the Audit log lines.

## 13. If something looks wrong

1. Audit log → search the action name or the project; the line says what ran and who started it.
2. `npm run check:keys` and `npm run check:db` for accounts and tables.
3. `node .claude/evals/run.js <suite>` (for example `policy-check`) to see whether the code itself regressed.
