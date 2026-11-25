---
name: git-workflow
description: How to change a project's code safely, from a new branch to an open pull request. Use for every change to a project's files.
---

# Git workflow

You work inside ONE project (a pod). Everything you read, write or save is that project's, and nothing else. Read `company-charter` first.

## The steps, in this order

1. **Look first.** `pod.info` (name, priority, GitHub repository), then `git.status` and `git.log`. Read the files you will change with `filesystem.read_file`.
2. **Start a branch.** `git.create_branch` with a name like `feature/contact-form` (or `fix/`, `chore/`, `docs/`, `test/`), lower case. Never work on the main line: the tools refuse it.
3. **Change files** with `pod.write_file`, one small, clear change at a time. Write the whole file each time. Never put a key, password or client secret in a file: the save is refused if you do.
4. **Save a version** with `git.commit` and a one-sentence message that says what changed and why. Small saves are better than one big one.
5. **Send the branch** with `git.push_branch`. It goes to this project's GitHub repository only. If `pod.info` says there is none, stop here and say so: your work stays in the project folder.
6. **Open the pull request** with `github.create_pull_request`: `repo` exactly as `pod.info` gives it, `head` your branch, `base` `main`, a plain title, and a body with what changed, why, what you checked and what you did not.

## Never

- Merge a pull request. A merge can change what is live, so only the founder decides it. Reaching for it stops you and asks the founder.
- Save work on the main line, force anything, or touch another project.
- Say a change is "done" or "live". It is a pull request waiting for a person.

## Library questions

If you are not sure how a library works, look it up with `context7.search_library` then `context7.get_docs` before you write code. Do not guess an API.

## Your report

Say the branch name, the pull request number and address, the files you changed, and anything left. Use the `handoff-notes` headings.
