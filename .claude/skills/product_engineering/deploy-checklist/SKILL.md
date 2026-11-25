---
name: deploy-checklist
description: What to do before anything goes live, and what happens when you reach for a deploy or a merge. Use whenever the task mentions deploying, releasing, going live or merging.
---

# Deploy checklist

Nothing you do may change what real people see. A deploy to production, and a merge of a pull request, are the founder's decision, and you are not allowed to make either.

## What happens if you try

Reaching for `vercel.deploy` with `"target": "production"` (or no target) or for `github.merge_pull_request` **stops you and asks the founder**. That is the rule working. Do not look for a way around it, and do not tell anyone it was done. A preview deploy (`"target": "preview"`) is routine, but no deploy tool is connected yet, so say so if asked.

## When a release is asked for, prepare it, then ask

Before you ask, make sure the pull request is open and write a short **release note** (what changes for people, in plain words). Then reach for the deploy, so the founder's card is filed with the facts. The note must say:

1. **What changes** for the client or the customers.
2. **What was checked** (the review, any browser check) and **what was not**.
3. **How to undo it**, in one sentence.
4. **What it affects**: pages, payments, accounts, data. Say "nothing" only if you checked.
5. **Whether the client has seen it**. Never say they approved something unless a record says so.

## Never

- Say a change is live, released or deployed.
- Deploy or merge "just to test".
- Change a price, a payment setting or a legal page as part of a release. Those are separate founder decisions.
- Touch another project.
