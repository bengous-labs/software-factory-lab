---
name: dispatch
description: Hand a GitHub issue of this repository to a Worker with `bun scripts/factory/dispatch.ts`. Use when the Owner types /dispatch <issue>.
argument-hint: <issue> [--model <model>]
disable-model-invocation: true
allowed-tools: Bash(bun scripts/factory/dispatch.ts:*)
---

Run, from the project directory, with no other step and no question:

```
bun scripts/factory/dispatch.ts $ARGUMENTS
```

Reply with what it printed. When it fails, reply with its error, which names what to remove, and do nothing else: you never create the worktree, launch a session or implement the issue yourself.
