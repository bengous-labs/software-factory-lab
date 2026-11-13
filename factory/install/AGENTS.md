# What an installation sets

`factory/install/` holds what names the repository the factory is installed in: the repository, its Trunk, its config directory, its API key file and the directory of its Workers' clones (`host.ts`), those places as paths under a home (`paths.ts`), its three logins (`logins.ts`), the factory config's schema and path (`factory-config.ts`), and what a Worker reads under the Owner's home (`sandbox-paths.ts`).
No source file of the factory outside `install/` spells one of these names, nor a path under a user's home: `host-names.test.ts` fails on one that does.
It reads no test and no guide, and it lets the release branch's name pass, a common word.
A change to `logins.ts` waits for the Owner: it says whose word the Land loop obeys.

## Identities

The Owner, `bengous`, gives the Land approval, the `land-ok` label, by hand on GitHub or with `/land <n>` in a session whose `gh` acts as `bengous`: the mod `.claude/plugins/land/` puts the label on the Owner's own typing alone, at the terminal or through Remote Control, shows its result in a band the model never reads, and refuses an agent's command that puts the label.
A `/land` typed in a Worker's session puts the label as the Author, and counts for nothing.
The Owner also gives the `land:human` veto, and releases `main`.
The Author's PR is pushed, opened, readied and answered as the machine account `bengous-labs-author`, by the Stop hook alone: the hook and the relay read its fine-grained token from `~/.config/software-factory-lab/author-token` (`LAB_AUTHOR_TOKEN_FILE` overrides the path), and the hook publishes nothing without it.
A `land-ok` it puts counts for nothing.
The Merge bot and the Code review act as the agents' App, `bengous-labs-agents[bot]`.
`merge-bot.yml` names the three logins: `OWNER`, `AUTHOR_LOGIN`, `APP_LOGIN`.
`logins.ts` names the same three for the code that runs outside that workflow, and `factory/land/workflows.test.ts` holds the two equal.
Every Worker is launched with a settings file whose `env` holds `LAB_AUTHOR=1`, which makes it an Author, and `GH_TOKEN` set from that file, so any `gh` it runs acts as the machine account, and `outputStyle` set to `Proactive`, so a Worker never takes the output style of the checkout it is launched from.
Its `claudeMdExcludes` names the Owner's global `CLAUDE.md` by its absolute path (`/home/<owner>/.claude/CLAUDE.md`), so a Worker reads the instructions of its role and of this repository alone: what it needs from the Owner's global file lives in `factory/roles/worker.md`.
The launcher passes the settings file by its path: a token never goes in an environment prefix nor in inline JSON on the command line.

The Owner provisions the machine account: a member of `bengous-labs` with the Write role on this repository, and a fine-grained token whose resource owner is `bengous-labs`, limited to this repository, with Contents, Pull requests, Issues and Workflows in read and write.
Workflows is needed because the Author pushes branches that change `.github/workflows/`: GitHub refuses such a push from a token without it.
The token file is mode 600.

## The API key

An API Worker (`factory/dispatch/AGENTS.md`) bills a Claude Console API key the Owner provisions in `~/.api-agent/key`, mode 600: `(umask 077 && wl-paste -n > ~/.api-agent/key)` puts it there from the clipboard, so it never crosses a conversation.
No code of the factory reads that file: Dispatch reads its mode, and Claude Code runs the helper that prints it.
Dispatch writes `~/.config/software-factory-lab/api-worker-settings.json` itself, from the Worker settings file, whose token it copies there, and the main checkout's hooks: after a change to either, the next API dispatch writes it again, and a session launched before keeps what it was launched with until then.
The key pays the turns of the API Worker and the forks of its stops; the Merge bot's Judges run in CI on their own credential.

## What a Worker reads

A Worker runs code, so what holds a secret is the sandbox of its commands and the rules of its file tools, never a rule on a command's text.
`factory/land/shared/worker-sandbox.ts` is the one definition, for an API Worker, a background Worker and the forks of their stops; `sandbox-paths.ts` holds its two lists.

A command of a Worker, of either kind, reads:

- under the Owner's home, its own clone, which is its working directory, and this list alone: `~/.local/share/mise/installs`, `~/.bun/install/cache`, `~/.gitconfig`, `~/.config/git/config` and `~/.config/git/ignore`.
  The rest of the home is denied, a secret nobody listed included: SSH and GPG keys, the Owner's `gh` login, Claude Code's own login, shell history, the other checkouts of the machine;
- never the main checkout, whose files every hook runs, nor another Worker's clone: the main checkout is hidden from it;
- what lies outside the home: the system's files and the temporary directory;
- the Author's `GH_TOKEN`, which its environment holds by design: its `gh` acts as the machine account.

`~/.api-agent`, `~/.config/software-factory-lab` and the main checkout are hidden from every command, whatever else is allowed, and a command reaches GitHub and the package registry and no other host.

Claude Code's own file tools run outside the sandbox.
They read the files under the session's working directory alone, the Worker's clone, and deny rules name the three hidden directories and each credential path of `sandbox-paths.ts`, which holds through a symbolic link too.

What runs outside the sandbox is a hook's command, and a Worker's hooks are the main checkout's, which its settings file carries: it loads no settings of its clone (`factory/hooks/AGENTS.md`).
No hook runs `bun check` or the format fix for an Author.
No hook installs for a Worker either: Dispatch runs `bun install` in its clone before the Worker exists.

- Both settings files, `api-worker-settings.json` and `background-worker-settings.json` in `~/.config/software-factory-lab/`, are generated: Dispatch writes each from the Worker settings file and the main checkout's hooks at a dispatch of its kind.
  Change the Worker settings file or `worker-sandbox.ts`, never a generated file.
- Every Worker needs `bubblewrap`, `socat` and the sandbox's seccomp filter on the machine: a session whose sandbox cannot start runs no command.
- A Worker's commits and tags are unsigned: the home holds the signing key.
- `bun install` in a Worker's session fills a cache of that Worker's own, `.lab/bun-cache` in its clone, which git ignores: no command writes outside its clone and the session's temporary directory, and no Worker installs a package another one left. The Owner's own cache stays read-only.
- No command of a Worker makes or reaches a Unix socket: the one test of `bun check` that listens on one, in `factory/land/relay/deliver.live.test.ts`, is skipped there, and runs in CI.
- The Worker bench (`scripts/lab/bench.ts`) launches its sessions unsandboxed: their commands read what the Owner's user reads.

`bun factory/bin/sandbox-probe.ts` shows this on the machine, with canary files where credentials live and never a real credential.
It runs two headless sessions, `claude -p`, each in a clone of its own under the clones' directory, as a Worker works: one on the sandbox alone, and one on a background Worker's settings, the main checkout's hooks included; each tries the reads that must fail, a canary in the main checkout among them, by a command and by a file tool, and the commands a Worker must still pass: `bun install`, `bun check`, `git fetch origin`, `git ls-remote origin`, `gh issue view` and `git commit`.
It prints every path it writes before it writes one, removes them at its end, keeps each session's output in the `.lab/sandbox-probe/` of its checkout, and ends with `sandbox-probe: <n>/<n> as expected` under one line per probe.
It shows what the settings hold in a session that loads them; it starts no `claude --bg` session and resumes none, so that a background session loads them at its launch and keeps them at a resume is Claude Code's own behaviour, which the probe does not show (`factory/land/relay/AGENTS.md`).
The Owner runs it, never a Worker, since it writes in the home: after a change to `worker-sandbox.ts`, to `sandbox-paths.ts` or to the settings Dispatch writes, and after an update of Claude Code.
