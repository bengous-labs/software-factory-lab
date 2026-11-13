# Dispatch

Dispatch hands one issue to a Worker (`factory/bin/dispatch.ts`, or `/dispatch <issue>` in the Owner's session).
It makes the Worker a clone of its own, `~/.local/share/software-factory-lab/api-workers/issue-<n>` (`CLONES_DIR` of `factory/install/host.ts`: the directory keeps its on-disk name, which existing clones and running sessions hold, whatever kind of Worker a clone is for), outside the main checkout, on a new branch `issue/<n>-<slug>` from the Trunk, then launches the Worker there: a background session, or with `--api` an API Worker, as the section below says.
A Worker holds the Author's token and does what its issue says, and the lab is public: only an issue the Owner wrote is handed to one.
The launch runs the Worker on the model `--model` names, `opus` by default, and at the effort `--effort` names, one of the levels `factory/lib/effort.ts` holds, Claude Code's own when it names none.
It refuses an issue that already has a clone or a branch, and names what to remove.
The launch passes the settings file Dispatch wrote for the Worker by its path, never a token on the command line, and keeps of the caller's environment only what a session needs to start: no credential (`factory/install/AGENTS.md`).
The one launch prompt names the issue and the clone; what a Worker does comes from its role (`factory/roles/worker.md`), never from the prompt.
`dispatch-plan.ts` holds what Dispatch decides, `dispatcher.ts` the calls it makes over its ports.

## A Worker's clone

Every Worker, background or API, works in a clone of its own, never in the main checkout nor in a worktree of it.
The main checkout is where every hook's files come from, and a hook runs outside the sandbox: a Worker that could write there would run code with the Owner's access.
A worktree shares the main checkout's git directory, and a command of the Worker would write its branches, each `HEAD` and each index.

- Dispatch clones the main checkout's remote on the Trunk, then creates the branch in the clone and installs its dependencies there, while the clone holds the Trunk's files alone.
  No hook installs for such a Worker: an install in a directory the Worker has written follows what it left there.
- `git worktree list` does not show a Worker, the main checkout holds no branch of its issue, and deleting its clone is all that removes it.
- The Worker's session starts in its clone, and its settings name the main checkout (`LAB_MAIN_CHECKOUT`): that variable is what makes a session one that works in a clone, for every hook that would otherwise trust the Worker's tree (`factory/hooks/AGENTS.md`).

## What runs outside the sandbox asks the clone nothing

A hook's command runs outside the sandbox, and the Worker writes its clone, so a hook that trusts it runs the Worker's code.

- A Worker's session loads no settings but the file Dispatch wrote for its kind (`--setting-sources ""`) and no MCP server but those its command names, which are none (`--strict-mcp-config`): no hook, plugin or MCP server of the clone, and no rule of the Owner's own settings, which could widen the sandbox.
- That file carries the hooks of the main checkout's `.claude/settings.json`, each rewritten to start in the main checkout and run the main checkout's file, through `LAB_MAIN_CHECKOUT`: `bun` reads the `bunfig.toml` and the `.env` of the directory it starts in, so a hook that started in the clone would run the Worker's preload first.
  A hook command of any other form than `bun "$CLAUDE_PROJECT_DIR"/<file>` fails the dispatch: rewritten by guess, it could still run a file of the clone.
- The Stop hook runs git in the main checkout, with the clone handed over through git's environment (`factory/land/stop/AGENTS.md`), and keeps its log and its state in the main checkout's `.lab/`.
- `install-deps.ts`, whose install follows what the clone holds, and `fix-edited.ts`, whose fix runs git and the lint config of the tree, do nothing in an Author's session nor in one that works in a clone; the Stop checks, `bun check`, run for no Author.
  `refuse-commit-on-dev.ts` guards a Worker as any session: it reads the branch from the checkout's files and runs no git.
- The guide a session is given is the main checkout's `AGENTS.md`, through its system prompt: Claude Code reads that file outside the sandbox, at the session's first request and again after a compaction, and a path of the clone can be a link to a secret.
  The Worker reads the `AGENTS.md` of a directory itself, in its clone, and has no project skill, plugin or MCP server.
- Both settings files, `background-worker-settings.json` and `api-worker-settings.json` in `~/.config/software-factory-lab/`, are written, mode 600, from the Worker settings file and the main checkout's hooks, just before the launch: a dispatch Dispatch refuses leaves the file every running Worker of that kind reads as it was.
  The hooks a Worker runs are the copy Dispatch took of the main checkout's: a guard that lands later reaches a running Worker at the next dispatch of its kind (`factory/hooks/AGENTS.md`).

## The sandbox of every Worker

`factory/land/shared/worker-sandbox.ts` is the one definition, for a background Worker, an API Worker and the forks of their stops (`factory/land/stop/AGENTS.md`); `factory/install/AGENTS.md` says what a Worker reads, and how the Owner probes it.

- Every Bash command of the session runs in Claude Code's sandbox, with no retry outside it, and no command runs when the sandbox cannot start.
- A command reads nothing under the Owner's home but its working directory, its clone, and a short list: the toolchain, bun's cache, git's configuration.
  The sandbox lets a command read and write its working directory with no entry, and no entry may hold it: with a parent of the working directory allowed to read, `bwrap` does not start (`Can't create file …/.claude/settings.local.json: Read-only file system`).
- Three directories are hidden whatever else is allowed: the one that holds the API key, the factory's config directory, which holds the Author's token, and the main checkout.
- A command writes under its clone alone, where what tells git which config to read and what to run stays read-only (`.git/config`, `.git/hooks`) and `.git` itself can be neither renamed nor replaced; bun's install cache lies there too, one per Worker (`factory/install/AGENTS.md`); it reaches GitHub and the package registry and no other host; it sees no other process.
- Claude Code's own file tools, which run outside the sandbox, read under the working directories alone, and deny rules keep them from reading or writing the hidden directories, from reading each credential path, through a symbolic link too, and from writing in the git directory of a clone.
- Since the sandbox bounds every command, the session runs any command and edits any file under its clone, in `dontAsk` mode: a call that would ask is denied, as nobody answers.
- Git reads the remote over HTTPS, as the sandbox holds no SSH agent and no key: `git fetch` works as long as the repository is public. Commits and tags are unsigned.
- While a command runs, the sandbox holds empty placeholders at paths such as `.bashrc` or `.vscode` in the clone: `.gitignore` names them, so they reach no commit, and a name Claude Code adds to that list shows as an untracked empty file.
- No hook runs the Worker's code: the Stop hook asks the Worker for `bun check`, and no hook fixes the format of a file it edits (`factory/hooks/AGENTS.md`).

What this does not hold:

- A Worker reads what lies outside the home, and writes in the session's temporary directory.
- Its environment holds the Author's `GH_TOKEN`, and it reaches `github.com`: what it reads, it can send there as the machine account.
- A hook is safe by what it reads: one added to `.claude/settings.json` that starts a program in the clone, or lets git find its repository from there, runs the Worker's code outside the sandbox.
- The hooks and the root guide are those of the main checkout's working tree, whatever it has checked out, while a clone starts from the Trunk: keep the main checkout on the Trunk (`git fetch origin && git reset --hard origin/dev`).
- A session Dispatch did not launch, whose environment holds no `LAB_MAIN_CHECKOUT`, has none of this: it is no Worker in a clone, and its hooks treat it as the Owner's own tree.

## A background Worker

The default kind.
Dispatch launches `claude --bg` in the clone, on `background-worker-settings.json`, with the flags above and the main checkout's root guide (`--append-system-prompt-file`).
Its settings hold the mode, `dontAsk`: a background session keeps its launch options, and the relay resumes it with the bare `claude --bg --resume`, run in its clone, where Claude Code keeps its conversation (`factory/land/relay/AGENTS.md`).
Claude Code starts and restarts a background session only in a workspace whose trust the Owner accepted in a terminal, and trust never reaches a clone from the directory that holds it: where no dialog can appear, as in Dispatch, `claude --bg` in a new clone exits with `Workspace not trusted`, the dispatch fails, and it names the clone to remove.
A headless session asks no trust, so an API Worker launches; issue #212 holds the way out for a background Worker.

## An API Worker

`--api` hands the issue to an API Worker: a headless session, `claude -p`, whose turns bill the Owner's Console API key instead of the subscription.
The key's credits are accepted from headless Claude Code alone, so an API Worker is never a background session, and nothing resumes it with `claude --bg --resume`.
It works in a clone, in the sandbox and on the main checkout's hooks, as a background Worker does; this section holds what differs.

- **The key.** The API Worker settings file names an `apiKeyHelper` that prints the key's file, so the key enters no command line and no environment.
  Dispatch reads the mode of that file, never the key, and refuses a file its group or others can read.
  What holds the key is the sandbox, which hides its directory, not a rule on a command's text: a Worker runs code.
- **Its first turn.** Dispatch launches the first turn in the clone, detached, with a session id it chooses.
  It looks at that turn for 10 s: one that ends with an error in that time, its key refused or its credits spent, fails the dispatch, which removes the clone.
- **Its turns.** Each turn passes the settings file, the flags and the mode again, since a headless session saves no launch option, and appends its result and Claude Code's cost estimate to `.lab/state/api-worker-<session>.log` of the main checkout, a file of its owner alone; Dispatch prints that path.
  `factory/land/shared/api-worker.ts` holds the commands of a turn, which the relay uses too (`factory/land/relay/AGENTS.md`).
- Its first turn runs at the effort `--effort` names; a turn the relay resumes runs at Claude Code's own, since neither the session nor its transcript keeps it.
- One that stops with no pull request has no relay, and nothing gives it a turn: delete its clone, and dispatch the issue again.
