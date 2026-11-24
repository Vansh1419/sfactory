---
name: plain-language-approval
description: How to write a request for the founder to decide, so a non-technical person understands it in under 30 seconds. The seven parts, the rules for money, time and technical detail, and one good and one bad example. Load for every agent that can ask the founder for a decision.
---

# Plain-language approval

Read the `company-charter` skill first. This is the long form of its section "Asking the founder to decide".

A writer step turns your request into a card, and a checker (code, not a model) rejects any card that breaks these rules. A card that never passes is **not sent**, and the task does not go ahead. Write it correctly the first time.

## The seven parts, always in this order

1. **What do you need to decide?** One question the founder can answer with yes or no.
2. **Why now?** Why it needs an answer today and not later.
3. **If you say yes**, what happens.
4. **If you say no**, what happens.
5. **Cost.** Money in ₹ and in $, for example "₹4,150 ($50)". Free is "₹0 ($0)".
6. **Risk:** Low, Medium or High, with one line saying why.
7. **Our recommendation:** Yes or No, and the reason in a few words.

## Rules

- Short sentences and everyday words. No code, commands, file names, ids or abbreviations.
- If a technical word cannot be avoided, explain it in brackets.
- Show every time in IST, for example "6 pm IST".
- Put technical detail in the optional `details` field. The founder sees it only after pressing "Show details".
- **Never invent a price.** If the amount is not known, write exactly "Price not known yet" in the cost line, with no digits. Money of an unknown size is never Low risk: use Medium or High.
- Do not say the founder already agreed to anything. Only a recorded approval says so.
- Do not put keys, passwords or tokens anywhere in the card.

## A good card

```json
{
  "decide": "Can we make the new login page for Client A live for their customers?",
  "why_now": "The page is finished and checked, and the client is waiting to start using it.",
  "if_yes": "The new page goes live for their customers.",
  "if_no": "The old page stays and the new one waits until you decide.",
  "cost": "₹0 ($0)",
  "risk": { "level": "Low", "reason": "We can switch back to the old page if anything goes wrong." },
  "recommendation": "Yes"
}
```

## A card the checker rejects

It is full of jargon, hides the real question, and has no cost in ₹ and $.

```json
{
  "decide": "Approve deploy of v1.3 to prod; DB migration on users table, rollback via snapshot.",
  "why_now": "CI is green.",
  "if_yes": "Deploys.",
  "if_no": "Does not deploy.",
  "cost": "minimal",
  "risk": { "level": "Low", "reason": "Has a rollback." },
  "recommendation": "Approve"
}
```

Unanswered requests are reminded after a set time. They are never approved automatically.
