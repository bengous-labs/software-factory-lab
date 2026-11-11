---
paths:
  - "scripts/land-loop/merge-bot/**"
  - "scripts/land-loop/queue/**"
  - ".github/workflows/merge-bot.yml"
  - ".github/workflows/queue-checks.yml"
---

# The Merge bot and the merge queue

The Merge bot (`scripts/land-loop/merge-bot/`) runs from `.github/workflows/merge-bot.yml`, checked out from the default branch, with the agents' GitHub App token: one Merge bot run per PR event, and a Sweep of every open PR on a push to `dev`, when CI completes on that push (the Sweep that reads `dev`'s red), and on a cron. It keeps a state record in one PR comment, calls the Judges, posts the Review check (`agent-review`) and the Land gate (`land-gate`), and enables the merge.

GitHub's merge queue lands the change with a merge commit. `queue/repost.ts`, run by `.github/workflows/queue-checks.yml`, re-posts the App's two required checks on the queue's own commit.
