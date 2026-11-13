# Dispatch

Dispatch hands one issue to a Worker (`factory/bin/dispatch.ts`, or `/dispatch <issue>` in the Owner's session).
It creates the Worker's worktree under `.claude/worktrees/issue-<n>` on a new branch `issue/<n>-<slug>` from `origin/dev`, then launches the Worker as a background session in the main checkout, which enters that worktree itself; with `--api` it launches an API Worker instead, in a clone of its own, as the section below says.
A Worker holds the Author's token and does what its issue says, and the lab is public: only an issue the Owner wrote is handed to one.
The launch runs the Worker on the model `--model` names, `opus` by default, and at the effort `--effort` names, one of the levels `factory/lib/effort.ts` holds, Claude Code's own when it names none.
It refuses an issue that already has a worktree, a clone or a branch, and names what to remove.
The launch passes the Worker settings file by its path, never a token on the command line, and keeps of the caller's environment only what a session needs to start: no credential (`factory/install/AGENTS.md`).
The one launch prompt names the issue and the worktree; what a Worker does comes from its role (`factory/roles/worker.md`), never from the prompt.
`dispatch-plan.ts` holds what Dispatch decides, `dispatcher.ts` the calls it makes over its ports.

## An API Worker

`--api` hands the issue to an API Worker: a headless session, `claude -p`, whose turns bill the Owner's Console API key instead of the subscription.
The default stays the background Worker.
The key's credits are accepted from headless Claude Code alone, so an API Worker is never a background session, and nothing resumes it with `claude --bg --resume`.
It is meant to behave as a background Worker does; the last list of this section holds where it does not.

What holds the key is the sandbox, not a rule on a command's text: a Worker runs code.

- **The key.** The API Worker settings file names an `apiKeyHelper` that prints the key's file, so the key enters no command line and no environment.
  Dispatch reads the mode of that file, never the key, and refuses a file its group or others can read.
- **Its clone.** An API Worker works in a clone of its own, `~/.local/share/software-factory-lab/api-workers/issue-<n>` (`API_CLONES_DIR` of `factory/install/host.ts`), outside the main checkout, never in a worktree of it.
  A worktree shares the main checkout's git directory, and a command of the Worker would write its branches, each `HEAD` and each index: the main checkout is where every hook's files come from.
  Dispatch clones the main checkout's remote on the Trunk, then creates the branch in the clone and installs its dependencies there, while it holds the Trunk's files alone.
  A background Worker keeps its worktree.
- **The sandbox.** Every Bash command of the session runs in Claude Code's sandbox, with no retry outside it, and no command runs when the sandbox cannot start.
  A command writes under its clone alone, where what tells git which config to read and what to run stays read-only (`.git/config`, `.git/hooks`); it reaches GitHub and the package registry and no other host; it sees no other process, and three directories are empty for it, whatever it runs: the one that holds the key, the factory's config directory, which holds the Author's token (`factory/install/AGENTS.md`), and the main checkout.
  Deny rules keep Claude Code's own file tools, which run outside the sandbox, from reading or writing those directories, through a symbolic link too, and from writing in the git directory of a clone.
  Since the sandbox bounds every command, the session runs any command and edits any file under its clone, in `dontAsk` mode: a call that would ask is denied, as nobody answers.
- **What runs outside the sandbox asks the clone nothing.** A hook's command runs outside the sandbox, and the Worker writes its clone, so a hook that trusts it runs the Worker's code.
  Each turn loads no settings but the API Worker settings file (`--setting-sources ""`) and no MCP server but those its command names, which are none (`--strict-mcp-config`): no hook, plugin or MCP server of the clone, and no rule of the Owner's own settings, which could widen the sandbox.
  That file carries the hooks of the main checkout's `.claude/settings.json`, each rewritten to start in the main checkout and run the main checkout's file, through `LAB_MAIN_CHECKOUT`: `bun` reads the `bunfig.toml` and the `.env` of the directory it starts in, so a hook that started in the clone would run the Worker's preload first.
  A hook command of any other form than `bun "$CLAUDE_PROJECT_DIR"/<file>` fails the dispatch: rewritten by guess, it could still run a file of the clone.
  The Stop hook runs git in the main checkout, with the clone handed over through git's environment (`factory/land/stop/AGENTS.md`), and keeps its log and its state in the main checkout's `.lab/`.
  Three would still run the clone's code, and do not for an API Worker: `fix-edited.ts`, which runs the checkout's lint config; `install-deps.ts`, whose install follows what the clone holds; and the Stop checks, `bun check`.
  `refuse-commit-on-dev.ts` guards an API Worker as any session: it reads the branch from the checkout's files and runs no git.
  The guide each turn is given is the main checkout's `AGENTS.md`: Claude Code reads that file outside the sandbox, and a path of the clone can be a link to a secret.
- **Settings.** Dispatch writes `~/.config/software-factory-lab/api-worker-settings.json`, mode 600, from the Worker settings file and the main checkout's hooks, just before the launch: a dispatch it refuses leaves the file every running API Worker reads as it was.
- **Where it starts.** A headless session cannot enter a worktree: `EnterWorktree` fails there (`not a git repository: '/dev/null/not-a-git-repository'`).
  Dispatch launches the first turn in the clone itself, detached, with a session id it chooses.
  It looks at that turn for 10 s: one that ends with an error in that time, its key refused or its credits spent, fails the dispatch, which deletes the clone.
- **Its turns.** Each turn appends its result and Claude Code's cost estimate to `.lab/state/api-worker-<session>.log` of the main checkout, a file of its owner alone; Dispatch prints that path.
  `factory/land/shared/api-worker.ts` holds the commands of a turn, which the relay uses too (`factory/land/relay/AGENTS.md`).

Where an API Worker differs from a background Worker:

- It works in a clone, not in a worktree: `git worktree list` does not show it, the main checkout holds no branch of its issue, and deleting its clone is all that removes it.
- It loads no project settings, so Claude Code gives it the main checkout's root `AGENTS.md` alone, through its system prompt: it reads the `AGENTS.md` of a directory itself, in its clone, and has no project skill, plugin or MCP server.
- It takes nothing of the Owner's own settings: no hook, permission rule, plugin or variable of `~/.claude/settings.json`.
- It runs the Stop checks itself, at the Stop hook's asking; no hook fixes the format of a file it edits, or installs the dependencies it adds, which it installs itself.
- Its git reads the remote over HTTPS, as the sandbox holds no SSH agent: `git fetch` works as long as the repository is public.
- While a command runs, the sandbox holds empty placeholders at paths such as `.bashrc` or `.vscode` in the clone: `.gitignore` names them, so they reach no commit, and a name Claude Code adds to that list shows as an untracked empty file.
- Its first turn runs at the effort `--effort` names; a turn the relay resumes runs at Claude Code's own, since neither the session nor its transcript keeps it.
- One that stops with no pull request has no relay, and nothing gives it a turn: delete its clone, and dispatch the issue again.

What this does not hold:

- A clone's `.git/config` and `.git/hooks` are kept from the Worker by Claude Code's sandbox and by a deny rule, not by the factory's own code: the Stop hook's git reads them.
- The hooks an API Worker runs are the copy Dispatch took of the main checkout's: a guard that lands later reaches a running one at the next API dispatch (`factory/hooks/AGENTS.md`).
- Its commands still read the rest of the machine but those three directories, the Owner's other credentials among them.
- A hook is safe by what it reads: one added to `.claude/settings.json` that starts a program in the clone, or lets git find its repository from there, runs the Worker's code outside the sandbox.
