# Review guide

The Code review and the Principal judge read this guide in their prompt. Review each change against what failure means in the area it touches.

## What failure looks like here

- `app/`: a command gives a wrong result, loses or corrupts the task file, crashes on input a user can type, or leaves an existing task file unreadable. Both format versions in `app/test/fixtures/` must still read.
- `scripts/land-loop/`: a change lands without the review, the checks or the `land-ok` its route requires; an Important finding stops blocking; a Merge bot run acts differently when an event arrives twice, late or never.
- `scripts/hooks/`, `.claude/`: a guard fails open and lets through what it exists to refuse, refuses valid work, or keeps a session blocked with no way out.
- `.github/`: text or code from the pull request runs, or is obeyed, next to the job's secrets; a secret or token reaches a log, a comment or a model's prompt; a trigger or a permission widens.
- `scripts/gates/`, `scripts/lint/` and the gate configs: a gate stops failing on what it was built to catch.
- Agent docs (`AGENTS.md`, `REVIEW.md`, skills): a line that contradicts the code. For a doc, failure is that it lies.

## Severity

- **Important**: a failure from the list above that this change introduces, or a behaviour the change adds or changes with no test. It blocks the merge.
- **Nit**: anything else worth saying, such as a name, a structure or a simpler form. At most three per review.
- **Pre-existing**: a defect this change did not introduce, whatever its weight. It never blocks.

## Evidence

Anchor every finding on the changed line that causes it, and give the failure scenario: the input or state, then the wrong result. Follow the code a change reaches, such as its callers and its tests, before you report what it breaks. When the failure shows in another file, name that place in the finding.

When one defect appears at several places in the change, report it once as a class and name every place, so the author fixes all of them in one round.

## Later rounds

A thread of an earlier round is settled once the author fixed it or rejected it with a reason; a thread still open stays the author's to answer. Report a settled finding again only when the code shows the fix missing or the reason wrong.

## Out of scope

- What `bun check` enforces: types, lint, formatting, failing tests, the coverage floor and the gates.
- `bun.lock` and `scripts/vendor/`.
