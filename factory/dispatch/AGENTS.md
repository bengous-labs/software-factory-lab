# Dispatch

Dispatch hands one issue to a Worker (`factory/bin/dispatch.ts`, or `/dispatch <issue>` in the Owner's session).
It creates the Worker's worktree under `.claude/worktrees/issue-<n>` on a new branch `issue/<n>-<slug>` from `origin/dev`, then launches the Worker as a background session in the main checkout, which enters that worktree itself.
A Worker holds the Author's token and does what its issue says, and the lab is public: only an issue the Owner wrote is handed to one.
The launch runs the Worker on the model `--model` names, `opus` by default, and at the effort `--effort` names, one of the levels `factory/lib/effort.ts` holds, Claude Code's own when it names none.
It refuses an issue that already has a worktree or a branch, and names what to remove.
The launch passes the Worker settings file by its path, never a token on the command line, and keeps of the caller's environment only what a session needs to start: no credential (`factory/install/AGENTS.md`).
The one launch prompt names the issue and the worktree; what a Worker does comes from its role (`factory/roles/worker.md`), never from the prompt.
`dispatch-plan.ts` holds what Dispatch decides, `dispatcher.ts` the calls it makes over its ports.
