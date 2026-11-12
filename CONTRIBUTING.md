# Contributing

## Install

Bun 1.4.4 is pinned in `mise.toml`. Then install the dependencies:

```bash
bun install
```

## Check

Run the checks before you commit:

```bash
bun check
```

`check` runs the typecheck (`bun run typecheck`), the lint (`bun run lint`), the format check (`bun run format:check`), the gates on lint suppressions, typecheck coverage, budget exceptions and paths that name no file (`bun run gates`), the dead code check (`bun run knip`: unused files, exports and dependencies), then the tests with their coverage (`bun test --coverage`), and last the coverage floor (`scripts/gates/check-coverage-floor.ts`), which fails when the suite's total line or function coverage falls under the floor it sets. It must pass. `bun fmt` formats the files the format check reads.

CI's `mutation` job mutates each module `stryker.config.ts` lists whose lines or tests your branch changes, and fails on a mutant that survives on a changed line, or one the tests killed on `origin/dev` that survives now. Run it before you push:

```bash
bun scripts/ci/mutation.ts run
```

## Where things live

- `app/src/commands/`: one file per command. Each file holds a pure function over the task list.
- `app/src/cli.ts`: parses the command and calls the matching function.
- `app/src/store/`: the task file format. A change here can make existing task files unreadable.
- `app/test/`: `bun test` suites. Add a test for each behaviour you add or change.
- `docs/usage.md`: how to use the CLI.
