# software-factory-lab

A lab for an agent-driven Land loop. The app under `app/` is a small task CLI that exists only so agents have something to change; `docs/usage.md` documents it.

## Your task

- Do the task you were given, then prove it works: `bun check` green, and a test for each behaviour you add or change.
- Commit your work on a branch, never on `dev`. Commits are signed by the git config; never pass `--no-gpg-sign`.
- Do not push, open, ready or merge a pull request: the Stop hook publishes your work when you stop, and the merge queue merges it.
- Do only the issue you were given. When it is done, end your turn without asking anything: a question left in your last message keeps the Stop hook from publishing your work.

## Layout

- `app/src/commands/`: one command per file, pure functions over the task list.
- `app/src/store/`: the file format. A change there is risky: it can make existing task files unreadable.
- `app/test/`: `bun test` suites.
