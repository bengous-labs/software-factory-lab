---
paths:
  - "scripts/land-loop/lib/author.ts"
  - "scripts/lib/author-session.ts"
  - ".claude/plugins/land/**"
  - ".github/workflows/merge-bot.yml"
---

# Identities

The Owner, `bengous`, gives the Land approval, the `land-ok` label, by hand on GitHub or with `/land <n>` in a session whose `gh` acts as `bengous`: the mod `.claude/plugins/land/` puts the label on the Owner's own typing alone, at the terminal or through Remote Control, shows its result in a band the model never reads, and refuses an agent's command that puts the label. A `/land` typed in a Worker's session puts the label as the Author, and counts for nothing. The Owner also gives the `land:human` veto, and releases `main`. The Author's PR is pushed, opened, readied and answered as the machine account `bengous-labs-author`, by the Stop hook alone: the hook and the relay read its fine-grained token from `~/.config/software-factory-lab/author-token` (`LAB_AUTHOR_TOKEN_FILE` overrides the path), and the hook publishes nothing without it. A `land-ok` it puts counts for nothing. The Merge bot and the Code review act as the agents' App, `bengous-labs-agents[bot]`. `merge-bot.yml` names the three logins: `OWNER`, `AUTHOR_LOGIN`, `APP_LOGIN`. Every Worker is launched with a settings file whose `env` holds `LAB_AUTHOR=1`, which makes it an Author, and `GH_TOKEN` set from that file, so any `gh` it runs acts as the machine account, and `outputStyle` set to `Proactive`, so a Worker never takes the output style of the checkout it is launched from. Its `claudeMdExcludes` names the Owner's global `CLAUDE.md` by its absolute path (`/home/<owner>/.claude/CLAUDE.md`), so a Worker reads the instructions of its role and of this repository alone: what it needs from the Owner's global file lives in `.claude/roles/worker.md`. The launcher passes the settings file by its path: a token never goes in an environment prefix nor in inline JSON on the command line.

The Owner provisions the machine account: a member of `bengous-labs` with the Write role on this repository, and a fine-grained token whose resource owner is `bengous-labs`, limited to this repository, with Contents, Pull requests, Issues and Workflows in read and write. Workflows is needed because the Author pushes branches that change `.github/workflows/`: GitHub refuses such a push from a token without it. The token file is mode 600.
