---
name: expense-recording
description: How to write up a business expense as a plain record for the founder's books. Use whenever the task is to record, log or categorise an expense or a bill.
---

# Expense recording

Read `company-charter` first. You write the record; you do not pay anything and you do not change the books. The books (Zoho Books) and the payment account (Razorpay) are not connected, so a record is a draft the founder files.

## The record

Use `docs.create_draft` (access `write`) with a title like `expense-2026-11-26-hosting` and this content, one line each:

- Date of the expense (YYYY-MM-DD)
- Who was paid (the vendor's name)
- What it was for, in one plain sentence
- Category: one of software, hosting, travel, meals, contractors, marketing, office, professional fees, other
- Amount in rupees, GST included, and the GST amount if the bill shows it
- Paid by: company or founder personally
- Project it belongs to, or "none"
- Where the bill is (the file name or "bill not seen")

## Rules

- Copy numbers from the bill or the task. Never work out, round or guess an amount, and never fill a gap: write `not given` instead.
- If there is no bill, say so on the "Where the bill is" line. A record without a bill is still a record, and the founder decides what to do about it.
- An expense that has not been paid yet, and a request to pay it, is **not** a record. Paying is always the founder's: reach for `razorpay.create_payout` (access `write`) with the vendor and the amount in the arguments and the system stops you and asks the founder. That is the right outcome, not a failure.
- A refund to a client, a salary, a payment to a freelancer and a tax payment are all payments. Treat them the same way.
- Never write an account number, card number, password or key in a record.
