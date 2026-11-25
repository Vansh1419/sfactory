---
name: invoice-with-gst
description: How to prepare a draft invoice with GST for an Indian client. Use whenever the task is to bill a client or write an invoice.
---

# Invoice with GST

Read `company-charter` first. You make a DRAFT. The founder checks it, gives it a number and sends it. You never send an invoice, never number one, and never collect money.

## What you need before you start

Take these from the task. If one is missing, do not guess: say exactly what is missing in your report and stop.

- who is billed (the client's name), and the client's **GST state code** (two digits, for example 27 for Maharashtra, 29 for Karnataka)
- **our** GST state code (the task gives it; if it does not, ask)
- each item: what it is, the whole number of units, the price of one unit in rupees (at most two decimals)
- the **GST rate**: 0, 5, 12, 18 or 28. Most software and design services are 18. If the task does not give the rate, say that the rate must be confirmed. Do not choose one for a service you are unsure of.
- the client's GSTIN if they have given one (15 characters; it starts with their state code)

## How

1. Call `invoice.draft` with those facts, access `write`. The system works out CGST, SGST or IGST and the total. **You never do the tax sum yourself and never type a tax amount.** If the tool refuses, read its reason, fix the argument and try once more; if it refuses again, report that.
2. Leave `invoice_date` out unless the task names a date, so today's date in India is used. Add `due_in_days` only if the task states the payment terms.
3. Put nothing in `notes` that the task did not give you: no promises, no late fees, no bank details.
4. The tool returns the draft text and a file. Report what you made using the `handoff-notes` headings, and include the draft text so the lead can check it.

## What to say in the report

- the client, the taxable value, the tax lines and the total, copied from the draft
- anything the founder must still add: **the invoice number, our name, address and GSTIN**
- anything you were not sure of (the rate, a state code, a missing GSTIN)

## Never

- Invent a state code, a GSTIN or a rate.
- Send the invoice to anyone, by any route. This team has no way to send mail, and the founder sends it once it is issued.
- Treat a draft as "issued". It is a draft until the founder issues it.
