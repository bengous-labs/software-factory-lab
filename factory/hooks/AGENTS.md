# Hooks and worktrees

`.claude/settings.json` wires six hooks.
Four are the factory's: the role a session reads at start (`role.ts`), the two guards on Bash (`refuse-commit-on-dev.ts`, `refuse-author-publish.ts`), and the Stop hook (`factory/bin/stop-hook.ts`, `factory/land/stop/`).
`refuse-author-publish.ts` holds a rule of the Land loop, that the Stop hook alone publishes: `factory/land/stop/AGENTS.md`.
Two serve this repository's own toolchain and live in `scripts/hooks/`: `fix-edited.ts` and `install-deps.ts`.

- Claude Code runs a hook's command from `$CLAUDE_PROJECT_DIR`, the checkout the session started in.
  After `EnterWorktree`, and in a subagent with `isolation: worktree`, that is still the main checkout, while the input's `cwd` is the worktree.
  A hook takes the tree a call works in from its input, the `cwd` field or the path of the file it handles.
  `import.meta.dir` and `$CLAUDE_PROJECT_DIR` name where the hook's own files and the project live, never that tree.

- A session started with `claude --worktree` has `$CLAUDE_PROJECT_DIR` in the worktree, so it runs its own branch's hooks, the Stop hook included.
  A Worker starts in the main checkout and enters its worktree with `EnterWorktree`, so it runs the hooks of whatever the main checkout has checked out, which need not be the Trunk's latest.
  An API Worker starts in its worktree, where a headless session cannot enter one, and still runs the main checkout's hooks: it loads no project settings, and its settings file carries the main checkout's hooks, each named through `LAB_MAIN_CHECKOUT` where `.claude/settings.json` says `$CLAUDE_PROJECT_DIR` (`factory/dispatch/AGENTS.md`).
  A hook's command runs outside the sandbox that holds such a Worker's code, so a hook that would run a file of the worktree does not for it: `fix-edited.ts` does nothing in its session, and the Stop hook runs no `bun check`.
  A hook added to `.claude/settings.json` that runs the checkout's own code needs the same care.

- `fix-edited.ts` and `install-deps.ts` act only on a checkout of the project's repository, found by its git common directory.
  The Stop hook runs `bun check` in whatever checkout `cwd` is in, except for an API Worker, which it asks to run it.

- A subagent fires `SubagentStop` with `cwd` in its worktree, never `Stop`: the Stop hook does not run for it.

- A Bash command that writes a file fires no `PostToolUse` on `Edit|Write`.
  The Stop checks catch its format.

- The hooks that run on every tool call, `refuse-commit-on-dev.ts`, `refuse-author-publish.ts` and `fix-edited.ts`, import no `effect`, directly or through what they import: loading it adds about 85 ms to each call.
  They read their input with `factory/lib/plain-json.ts`, and `scripts/hooks/per-call-imports.test.ts` fails when one loads a package other than `bun` and `node:` modules.
  The other hooks and the Land loop keep Effect Schema.

- A hook that must stop a call exits 2 or prints a deny.
  By default a hook that fails, with exit 1 or an uncaught throw, or times out lets the call run.
  A guard that must also stop the call when it fails itself sets `"onFailure": "block"` on its entry in `.claude/settings.json`: the two guards do, and `factory/hooks/guards.test.ts` holds them to it.
  A session reads the `.claude/settings.json` of the checkout it started in and runs each hook's file from that checkout: one that entered a worktree with `EnterWorktree` reads the main checkout's entries, never the worktree's, and one started inside the worktree reads the worktree's, so the entries and the files a session runs always come from one checkout.
  A running session reads that file again when it changes: an entry the file drops stops firing.
  An entry with `"onFailure": "block"` blocks every call only when its own checkout lacks its file.
  A guard a change adds or moves reaches the Workers once the main checkout is pulled, since they run its hooks.
  An API Worker is the one session whose entries and files come from two places: it reads no `.claude/settings.json`, its entries are the copy of the main checkout's that Dispatch put in the API Worker settings file, and each runs its file from the main checkout.
  That copy changes when an API dispatch writes the file again, and each turn reads it at its start: after a pull that adds or moves a guard, a running API Worker keeps the entries of its last dispatch, and one of them with `"onFailure": "block"` whose file the pull moved blocks every call of its later turns until an API dispatch rewrites the file.

- Each worktree gets its own `node_modules`: `install-deps.ts` installs it at SessionStart, SubagentStart and after EnterWorktree, the three events whose `cwd` is a new worktree, and does nothing in a Stop hook fork; an API Worker's fork loads no hook but the fork guard.
  The packages it places are copies, not hardlinks into bun's cache, so a write to them cannot reach the main checkout's `node_modules`, from which the hooks load.
  An install a session runs itself uses bun's default, which hardlinks on Linux.

- `role.ts` gives a session its role's text at SessionStart, `worker.md` to an Author or a session of the Worker bench (`LAB_ROLE=worker`, which makes no Author, so the Stop hook publishes nothing), except on a resume or a fork (`--fork-session` with `--resume`, which Claude Code's hooks reference lists as the SessionStart source `fork`, the Stop hook's forks included): the transcript already holds it, and the relay resumes a Worker at each Wake, so the text would pile up.
  A clear or a compaction fires SessionStart again and drops the text, so the hook gives it again.

- `worktree.baseRef: fresh` branches a worktree from `origin/HEAD`, which Claude Code's own fetch never moves.
  A clone whose `origin/HEAD` names another branch than the Trunk runs `git remote set-head origin --auto` once.
