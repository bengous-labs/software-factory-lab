# software-factory-lab

Prototype lab for an agent-driven review and land loop: agents write the code, hooks and CI workflows open, review and judge each pull request, and GitHub's merge queue lands it with a merge commit.

The app under `app/` is a small task CLI that gives the agents something to change; see `docs/usage.md`.

```bash
bun install
bun run check
```

## Commands

Each command runs as `bun app/src/cli.ts <command>`.

- `add <title>` adds an open task and prints its id.
- `list [--all | --done]` shows open tasks. `--all` shows every task. `--done` shows only done tasks. The two flags cannot be combined.
- `done <id>` marks a task as done.
- `clear` removes every done task.
- `rename <id> <title>` changes the title of a task.

See [docs/usage.md](docs/usage.md) for examples.
