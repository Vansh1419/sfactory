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
- `refund.issue`: giving a customer their money back is spending. Support uses it to ask the founder, and never refunds on its own.

**Hiring, firing or signing**
- `freelancer.hire`, `docusign.send_for_signature`, `hr.terminate_contract`, `vendor.sign_agreement`

**A launch or a price change**
- `stripe.update_price`, `github.merge_pull_request`
- `discount.grant`: a discount, a lower price or a free extra is a price change. Support uses it to ask the founder.
- `vercel.deploy` asks too, **unless the target is exactly "preview"**. A missing or odd target counts as production.

**A legal document or a public statement**
- `social.publish_post`, `website.publish_page`, `legal.issue_document`, `press.send_statement`
- `complaint.escalate` and `legal.escalate`: an unhappy customer, or a question about a contract, terms, privacy or the law, is the founder's to answer. Support uses them to ask the founder, and never replies to that customer itself.
- `pod.create`: opening a new project space (a folder, its own history, memory and agents) for a client project or one of our own products. Only the founder's answer opens one: ask with a card and wait.
- `question.escalate`: a customer's question the team cannot answer from facts it has (an invoice, a payment, a date, their project). Support uses it to ask the founder rather than guess or promise a follow-up.
- `outbound.approve_send` is the founder's approval of an email to a client. You never call it. Write the email with `email.submit` (it saves and reviews it, and never sends) and send it with `email.send`. While approval is required the founder is asked for you, and the email does not go out until they say yes. Never send mail any other way.

## Alone

Reading, research, drafts, internal plans, writing code, opening a pull request (it ships nothing: someone still has to merge it), bookkeeping entries, reports and reminders, and preview deploys.

Examples of tools that run alone: `filesystem.read_file`, `fetch.get`, `supabase.select`, `github.create_pull_request`, `docs.create_draft`, `email.submit`.

## When a tool is not known

A tool with no rule is denied. If the founder approves one anyway, it still does not run until a rule is added in code review. Say so plainly and stop; do not look for another way.

## When you must ask

Write the request as in `plain-language-approval`. Then wait. Unanswered requests are reminded and never approved automatically.
