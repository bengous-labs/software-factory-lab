---
name: dispatch
description: Hand a GitHub issue of this repository to a Worker with `bun factory/bin/dispatch.ts`. Use when the Owner types /dispatch <issue>.
argument-hint: <issue> [--model <model>]
disable-model-invocation: true
allowed-tools: Bash(bun factory/bin/dispatch.ts:*)
---

Run, from the project directory, with no other step and no question:

```
bun factory/bin/dispatch.ts $ARGUMENTS
```

Reply with what it printed. When it fails, reply with its error and do nothing else: you never create the worktree, launch a session or implement the issue yourself.
