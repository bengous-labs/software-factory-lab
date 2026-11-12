# The merge queue

GitHub's merge queue lands the change with a merge commit.
The Merge bot posts the Review check (`agent-review`) and the Land gate (`land-gate`) on the PR's head, while the queue tests a commit of its own.
`factory/bin/queue-checks.ts`, run by `.github/workflows/queue-checks.yml`, re-posts both on the queue's commit, each green only when the App's latest check of that name is green on the PR's head (`repost.ts`).
GitHub reads the workflow from the queue's commit, and the script from a checkout of the default branch.
