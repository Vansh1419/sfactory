---
name: testing
description: How to test a change when you cannot run code yourself, and what to say about it honestly. Use for every change that has behaviour.
---

# Testing

Be honest about what you can do. In this project you can read and write files, look at the history, and check a **public** web page in a browser. You cannot run a test command. So:

## What to do

1. **Write the test with the change.** If the project has a test folder or a test runner, add a test file next to the code in the same style (read an existing test first). Cover the normal case, an empty or missing input, a wrong input, and the edge you are most worried about.
2. **Make the test able to fail.** Say in your report what would make it fail. A test that cannot fail proves nothing.
3. **Check a preview if there is one.** If the task gives a public preview address (https), use `browser.check_page`. Look at the status, the title, the visible text and any errors the page showed. Say what you saw.
4. **Read your own change once more** the way a reviewer would, using `git.diff`.

## What to say

- Separate three things in your report: **what you checked**, **what you could not run**, and **what is still untested**.
- Never write "all tests pass" or "it works" unless a check you actually ran showed it. Say "I could not run the tests here; the founder or the project's own checks must."
- If a check shows a problem, report it plainly with what you saw. Do not hide it and do not explain it away.

## Never

Invent test results. Delete or weaken a test to make something pass. Test against a private or local address (the browser check refuses them).
