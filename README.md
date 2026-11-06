# software-factory-lab

Prototype lab for an agent-driven Land loop: agents write the code, the Stop hook and GitHub workflows carry each pull request through the Land loop, with Judges for the questions code cannot answer, and GitHub's merge queue merges it with a merge commit.

The app under `app/` is a small task CLI that gives the agents something to change; see `docs/usage.md`.

```bash
bun install
bun check
```

## Commands

Each command runs as `bun app/src/cli.ts <command>`.

- `add <title>` adds an open task and prints its id.
- `list [--all | --done]` shows open tasks. `--all` shows every task. `--done` shows only done tasks. The two flags cannot be combined.
- `done <id>` marks a task as done.
- `clear` removes every done task.
- `rename <id> <title>` changes the title of a task.

See [docs/usage.md](docs/usage.md) for examples.
