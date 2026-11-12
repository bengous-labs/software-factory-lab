---
paths:
  - ".claude/settings.json"
  - ".claude/skills/**"
  - ".claude/plugins/land/**"
  - "REVIEW.md"
  - ".github/workflows/**"
  - ".github/software-factory.json"
  - "scripts/hooks/**"
---

# What plugs the factory into this repository

These files wire the factory, and each design they serve is written beside the factory's code. Read it before you change one.

- `.claude/settings.json` and `scripts/hooks/`: `factory/hooks/AGENTS.md`.
- `.github/workflows/merge-bot.yml`: `factory/land/merge-bot/AGENTS.md`, and `factory/install/AGENTS.md` for the logins it names.
- `.github/workflows/code-review.yml`: `factory/land/review/AGENTS.md`.
- `.github/workflows/queue-checks.yml`: `factory/land/queue/AGENTS.md`.
- `.github/software-factory.json`: `factory/land/routing/AGENTS.md`.
- `.claude/skills/dispatch/` and `.claude/skills/watch/`: `factory/dispatch/AGENTS.md` and `factory/watch/AGENTS.md`.
- `.claude/plugins/land/`, the `/land` mod: `factory/install/AGENTS.md`, under Identities.
- `REVIEW.md`, the guide the Code review reads: `factory/land/review/AGENTS.md`.

A hook, a workflow or a skill names a file of `factory/bin/` or `factory/hooks/`, nothing else in `factory/`.
