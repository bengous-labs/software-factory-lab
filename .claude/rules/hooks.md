---
paths:
  - ".claude/settings.json"
  - "scripts/hooks/**"
  - "scripts/land-loop/stop/**"
---

# Hooks and worktrees

- Claude Code runs a hook's command from `$CLAUDE_PROJECT_DIR`, the checkout the session started in. After `EnterWorktree`, and in a subagent with `isolation: worktree`, that is still the main checkout, while the input's `cwd` is the worktree. A hook takes the tree a call works in from its input, the `cwd` field or the path of the file it handles. `import.meta.dir` and `$CLAUDE_PROJECT_DIR` name where the hook's own files and the project live, never that tree.
- A session started with `claude --worktree` has `$CLAUDE_PROJECT_DIR` in the worktree, so it runs its own branch's hooks, the Stop hook included. A Worker starts in the main checkout and enters its worktree with `EnterWorktree`, so it runs the hooks of whatever the main checkout has checked out, which need not be the Trunk's latest.
- `fix-edited.ts` and `prepare-worktree.ts` run a checkout's own tools or install only in a checkout of the project's repository, found by its git common directory, and install with `--ignore-scripts`. The Stop hook runs `bun check` in whatever checkout `cwd` is in.
- A subagent fires `SubagentStop` with `cwd` in its worktree, never `Stop`: the Stop hook does not run for it.
- A Bash command that writes a file fires no `PostToolUse` on `Edit|Write`. The Stop checks catch its format.
- A hook that must stop a call exits 2 or prints a deny. Exit 1, an uncaught throw and a timeout are non-blocking errors: the call runs. Such a guard turns its own failures into exit 2, and bounds any network call well below its hook's timeout.
