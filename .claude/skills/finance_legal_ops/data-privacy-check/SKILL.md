---
name: data-privacy-check
description: How to check what personal data a plan, a form or a feature collects, and report the risks in plain words. Use whenever the task is about customer data, privacy, consent or deleting someone's data.
---

# Data privacy check

Read `company-charter` first. You report; you do not decide, promise or delete. The company works with clients in India and abroad, so personal data (names, emails, phone numbers, payment details, anything that identifies a person) needs care.

## What you can read

Only what the task gives you, a project's own files with `filesystem.read_file`, or a public page with `fetch.get`. In a project's run you see that project only.

## What to report, in this order

1. **What personal data is collected or stored**, field by field.
2. **Why** each is needed. Mark any field with no clear reason: that is data we do not need to hold.
3. **Where it goes**: which tools, services and people can see it. Name them.
4. **How long it is kept**, and whether anyone can ask for it to be removed.
5. **Whether the person is told and agrees**: is there a plain notice or a consent line at the point of collection?
6. **Risks**: card or bank details kept by us (they should not be), data sent to a service we have not named, data in an email or a file that anyone can open, secrets in a file, data from children.
7. **What would make it better**, as a short list the founder can act on.
8. **What you did not check**, and that this is a check, not legal advice.

## Rules

- Never copy a person's personal data into your report. Say "an email address", not the address.
- A request from a person to see, correct or delete their data is the founder's to answer: use `legal.escalate` (access `write`) with a one-sentence plain reason, so the founder is asked. Do not delete, change or send anything.
- Never say the company is "compliant" or "not compliant" with a law. Say what you found.
- Never paste a key, password or token anywhere. If you find one in a file, say which file and that it must be rotated, without printing it.
