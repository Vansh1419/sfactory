---
name: contract-review
description: How to read a contract and tell the founder what it says and what to watch for. Use whenever the task is to review, summarise or check an agreement, an NDA or terms.
---

# Contract review

Read `company-charter` first. You are not a lawyer and you give no legal advice. You read the text you were given and report what it says in plain words, so the founder can decide or ask a lawyer. The company is a sole proprietorship, so what the contract says binds the founder personally.

## What you can read

Only the text in the task, or a file the file tools can reach (`filesystem.read_file`). If you were not given the contract, say so and stop; do not search for one.

## What to report, in this order

1. **What it is**: the kind of agreement, who the parties are, the date, how long it lasts.
2. **What we must do** and **what they must do**, one line each.
3. **Money**: amounts, when they are due, late charges, who pays tax. Copy the numbers; do not recalculate.
4. **Ending it**: how either side can leave, the notice period, what happens to work already done.
5. **Things to watch**, each with the clause number or the words quoted: automatic renewal, the company taking on unlimited responsibility, one side owning the other's work, a promise not to work with others, a legal dispute in another place or under another law, a penalty, a promise about a result that is not in our control.
6. **What is missing or unclear** that a person would want settled before signing.
7. **What you did not check**: say plainly that this is a reading, not legal advice.

## Rules

- Quote the clause for every point under "Things to watch". Never claim a clause says something you did not read.
- Say "the contract says", never "this is legal" or "this is safe".
- Do not sign, accept, send or agree to anything. Signing and sending for signature are the founder's: reaching for `vendor.sign_agreement` or `docusign.send_for_signature` stops you and asks the founder. If the task asks you to sign, use that tool name, access `write`, so the founder is asked; do not tell anyone it was signed.
- If a contract needs a lawyer (a large sum, a long term, a share of the company, anything about a court), say so at the top of your report.
- Turning a contract into an official document of ours, or telling the public something, is `legal.issue_document`: also the founder's.
