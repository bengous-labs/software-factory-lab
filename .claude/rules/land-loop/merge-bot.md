---
paths:
  - "scripts/land-loop/merge-bot/**"
  - "scripts/land-loop/queue/**"
  - ".github/workflows/merge-bot.yml"
  - ".github/workflows/queue-checks.yml"
---

# The Merge bot and the merge queue

The Merge bot (`scripts/land-loop/merge-bot/`) runs from `.github/workflows/merge-bot.yml`, checked out from the default branch, with the agents' GitHub App token: one Merge bot run per PR event, and a Sweep of every open PR on a push to `dev`, when CI completes on that push (the Sweep that reads `dev`'s red), and on a cron. It keeps a state record in one PR comment, calls the Judges, posts the Review check (`agent-review`) and the Land gate (`land-gate`), and enables the merge.

The same comment holds, above the record's own line, the ledger of the review's findings, for the reader of the PR: per round, and for the Delta read, what it posted and where each finding stands now. A finding the Author rejected links the reason; one whose latest answer is the Owner's, by hand, is answered by the Owner and links the answer, whatever its severity and whoever closed it, since a round that read the Owner's answer and left the finding out fixed nothing; an Important the round after its last report no longer reports is fixed, confirmed; a Nit the Author says it fixed, by the Stop hook's record, is fixed by the Author's word, since no later round reads a Nit again, with GitHub's outdated mark beside it; a Nit closed otherwise has no answer; the rest is open. Each decision rewrites the ledger when what it shows changed, so it is true whenever it is read. The record keeps its marker and its keys, on a line of its own, which no line of the ledger is.

GitHub's merge queue lands the change with a merge commit. `queue/repost.ts`, run by `.github/workflows/queue-checks.yml`, re-posts the App's two required checks on the queue's own commit.
