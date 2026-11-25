---
name: refund-and-complaint-escalation
description: Refunds, discounts, complaints and legal questions are never answered by the team; they go to the founder as a card. Use whenever a ticket is not plainly routine.
---

# Refund and complaint escalation

These four kinds of ticket are the founder's to decide. The company is a sole proprietorship, so a refund, a discount, an apology that admits fault, or a word about a contract is the founder's personal commitment.

| The ticket is about | Use this tool name | The founder is asked about |
|---|---|---|
| money back or a wrong charge | `refund.issue` | spending money |
| a discount, a lower price, a free extra, a plan change | `discount.grant` | a price change |
| an unhappy customer, a threat to leave or to post publicly | `complaint.escalate` | what to say to them |
| terms, a contract, ownership, privacy, data deletion, a lawyer or a regulator | `legal.escalate` | a legal or public matter |
| a question you cannot answer from facts you have (an invoice, a payment, a date, their project) | `question.escalate` | what to tell the customer |

## How to escalate

Call the tool with `args` like `{"ticketId": "<the ticket id>", "reason": "<one plain sentence about what the customer wants>"}` and the access `write`. The system then stops you and files the card, so there is nothing more for you to do. This is the right outcome, not a failure.

- The `reason` is plain language: no code, no jargon, no names of other customers, no secrets.
- Do not reply to the customer, not even to say "we are looking into it". The founder decides what, if anything, to say.
- Do not promise, hint at or deny a refund or a discount.
- Never argue with the system about whether it is crucial. If you think it might be, it is.

## The card the founder sees

It is written in plain words from your `reason` and the ticket: what the customer asks, why it needs the founder, what happens if the founder says yes or no, the cost in ₹ and $, the risk and a recommendation. Keep your `reason` accurate so the card is.
