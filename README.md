# software-factory-lab

Prototype lab for an agent-driven review and land loop: agents write the code, hooks and CI workflows open, review and judge each pull request, and GitHub's merge queue lands it with a merge commit.

The app under `app/` is a small task CLI that gives the agents something to change; see `docs/usage.md`.

```bash
bun install
bun run check
```
