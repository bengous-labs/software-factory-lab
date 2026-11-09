---
paths:
  - ".claude/settings.json"
  - "scripts/hooks/**"
  - "scripts/land-loop/stop/**"
---

# Hooks and worktrees

- Claude Code runs a hook's command from `$CLAUDE_PROJECT_DIR`, the checkout the session started in. After `EnterWorktree`, and in a subagent with `isolation: worktree`, that is still the main checkout, while the input's `cwd` is the worktree. A hook takes the tree it acts on from its input, the `cwd` field or the path of the file it handles, never from `import.meta.dir` or `$CLAUDE_PROJECT_DIR`.
- A session started with `claude --worktree` has `$CLAUDE_PROJECT_DIR` in the worktree, so it runs its own branch's hooks, the Stop hook included. A Worker starts in the main checkout and enters its worktree with `EnterWorktree`, so it runs the hooks of whatever the main checkout has checked out, which need not be the Trunk's latest.
- A hook that runs a checkout's own tools or install acts only on a checkout of the project's repository, found by its git common directory, and installs with `--ignore-scripts`.
- A subagent fires `SubagentStop` with `cwd` in its worktree, never `Stop`: the Stop hook does not run for it.
- A Bash command that writes a file fires no `PostToolUse` on `Edit|Write`. The Stop checks catch its format.
- A hook that must stop a call exits 2 or prints a deny. Exit 1 is a non-blocking error: the call runs.
