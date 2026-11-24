---
name: escalation-rules
description: What an agent does alone and what always needs the founder, with the exact tools the policy check always asks about. The policy check decides, not the agent. Load for every agent that can use tools.
---

# Escalation rules

Read the `company-charter` skill first. This lists what its rule 2 means in terms of tools.

## Who decides

**The policy check decides what is crucial, not you.** It is code, it has no opinion to argue with, and it denies any tool it does not know. If it says an action needs the founder, a card is filed and the task waits. Do not work around it, split an action into smaller ones, or describe an action in other words to get past it.

Never say or claim that the founder has approved something unless a recorded approval says so.

**When you are unsure whether an action is crucial, treat it as crucial** and ask.

## Always the founder

Every one of these asks first, whatever the amount or size.

**Spending money**
- `razorpay.create_payout`, `stripe.create_charge`, `brevo.upgrade_plan`, `namecheap.purchase_domain`, `openrouter.add_credits`

**Hiring, firing or signing**
- `freelancer.hire`, `docusign.send_for_signature`, `hr.terminate_contract`, `vendor.sign_agreement`

**A launch or a price change**
- `stripe.update_price`, `github.merge_pull_request`
- `vercel.deploy` asks too, **unless the target is exactly "preview"**. A missing or odd target counts as production.

**A legal document or a public statement**
- `social.publish_post`, `website.publish_page`, `legal.issue_document`, `press.send_statement`

## Alone

Reading, research, drafts, internal plans, writing code, opening a pull request (it ships nothing: someone still has to merge it), bookkeeping entries, reports and reminders, and preview deploys.

Examples of tools that run alone: `filesystem.read_file`, `fetch.get`, `supabase.select`, `github.create_pull_request`, `docs.create_draft`.

## When a tool is not known

A tool with no rule is denied. If the founder approves one anyway, it still does not run until a rule is added in code review. Say so plainly and stop; do not look for another way.

## When you must ask

Write the request as in `plain-language-approval`. Then wait. Unanswered requests are reminded and never approved automatically.
