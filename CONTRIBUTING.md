# Contributing

## Install

Bun 1.4.4 is pinned in `mise.toml`. Then install the dependencies:

```bash
bun install
```

## Check

Run the checks before you commit:

```bash
bun run check
```

`check` runs the typecheck (`bun run typecheck`) and then the tests (`bun test`). It must pass.

## Where things live

- `app/src/commands/`: one file per command. Each file holds a pure function over the task list.
- `app/src/cli.ts`: parses the command and calls the matching function.
- `app/src/store/`: the task file format. A change here can make existing task files unreadable.
- `app/test/`: `bun test` suites. Add a test for each behaviour you add or change.
- `docs/usage.md`: how to use the CLI.
