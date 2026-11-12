# What an installation sets

`factory/install/` holds what names the repository the factory is installed in: the repository, its Trunk, its config directory and its API key file (`host.ts`), its three logins (`logins.ts`), and the factory config's schema and path (`factory-config.ts`).
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
The sandbox of an API Worker needs `bubblewrap` and `socat` on the machine: without them its session runs no command.
It hides `~/.api-agent` and `~/.config/software-factory-lab` from the Worker's commands; a background Worker's commands read both.
The key pays the turns of the API Worker and the forks of its stops; the Merge bot's Judges run in CI on their own credential.
