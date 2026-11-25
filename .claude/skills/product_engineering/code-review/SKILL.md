---
name: code-review
description: How to review a change before it goes to the founder as a pull request. Use when you are asked to check someone's work, or your own.
---

# Code review

You review the change on the project's current branch. Use `git.log` and `git.diff` (and `git.status`), and read the changed files with `filesystem.read_file`. Review only what changed.

## What to check, in this order

1. **It does what was asked.** Compare with the task. Missing parts and extra parts are both findings.
2. **It is safe.** No key, password, token or client secret. No user input used without checking. No file outside the project. Nothing that sends data to another place.
3. **It is correct.** Look for wrong conditions, missing cases (empty, very large, wrong type), and errors that are ignored.
4. **It is clear.** Plain names, small functions, a comment where the reason is not obvious. No dead code.
5. **It can be tested.** There is a test for what changed, or the report says plainly why not.
6. **It is small.** One purpose. Unrelated changes belong in another branch.

## How to report

- Start with the verdict in one line: **accept**, or **changes needed**.
- Then a short list. For each finding: the file, what is wrong in plain words, and what to do. Mark each **must fix** or **nice to have**.
- Say what you did **not** check (for example, that you cannot run the code here).
- Do not rewrite the change yourself unless you were asked to: say what to fix.

## Never

Approve something you did not read. Say "tests pass" if you could not run them. Merge anything.
