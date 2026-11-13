# The Stop hook

The Stop hook (`factory/land/stop/`, started by `factory/bin/stop-hook.ts`, which `.claude/settings.json` wires) acts on the stop of an Author: a session whose environment holds `LAB_AUTHOR=1`, which the launcher gives through the `env` of the settings file it passes at launch.
For any other session, and for a fork the hook launched, it logs why and does nothing.
It is a hook of a session: `factory/hooks/AGENTS.md` says which checkout a hook runs from, and what a worktree changes.
It publishes the branch checked out in the worktree the stop comes from, with a clean tree and a commit ahead of `dev`; it publishes nothing from the main checkout, a detached HEAD, `dev`, `main` or `lab/*`, nor a PR that is ready at this head, nor, when the branch has no open PR, the head one of its PRs had when it was closed without landing.
A stop on a tree with uncommitted changes blocks once, asking for the commit alone; a later stop of the chain on a tree still dirty lets the session end.
Claude Code marks every stop that follows a block, whatever the block said, so the hook leaves `.lab/state/commit-asked-<session>` when it asks for the commit, and the next stop reads it once: that block reported no failure, so the Author token, the Stop checks and the Done judge keep their own block after it, and a chain of stops blocks at most twice.
It reads only the PRs opened from this repository, never a fork's of the same branch name.
It runs `bun check` (the Stop checks), then asks the Done judge, a fork of the session, whether the change is finished, which question the Author's last message leaves to its user, which of the App's open findings the Author rejects, and which it says it fixed.
A stop that leaves a question, finished or not, lands nothing and asks the Owner on GitHub: the hook sends a ready PR back to draft, pushes, opens the PR in draft when the branch has none, and posts the Done judge's whole question there as the machine account, with the branch, the session and a question mark (`QUESTION_MARK`); then it leaves the PR's relay, which brings the Owner's answer back to the session.
A question stays open until a comment of the Owner in the PR's conversation follows it; a reply in a review thread does not close it.
While one is open the hook posts no other, so a stop that repeats the question tells it once, and a finished stop with no question readies and pushes nothing, whether the PR is in draft or not, and leaves its relay again: the draft lands only after the Owner answers and a stop that leaves no question readies it.
A stop on a PR ready at this head asks the Done judge nothing, so a question there is not seen.
On a finished change that leaves none it replies in the thread of each rejected finding with the Author's reason and resolves it, adds the open findings the Author says it fixed to its one comment on the PR (`FIXED_MARK`), pushes, opens or readies the PR, resolves the App's open Nit threads, and leaves the PR's relay; the stop then ends with no text.
That comment is written before the push, so the Merge bot run the push starts reads it for its ledger; a failure to write it is logged, and the PR is published.
No reply it posts cites a commit, and none declares a fix: the Author's word on a fix goes to that comment alone, and closes no finding.
It logs each step to `.lab/stop.log`, and one line per stop of an Author to `.lab/outcomes.log` of the main checkout: `published` with the PR, `asked` with the draft PR and its reason, or `not-published` with its reason.
In the session of an API Worker, whose environment holds `LAB_API_WORKER=1` (`factory/dispatch/AGENTS.md`), the forks bill the API key too: their settings name the same key helper, so a stop publishes while the subscription has no usage left, and a fork reads the prompt cache its session wrote.
Such a fork loads no settings but its own and runs its commands in the session's sandbox.
The fork guard of every fork starts in the checkout that holds the hook's files, never in the fork's own directory.
An API Worker works in a clone of its own, outside the main checkout; the hook is outside its sandbox, and the Worker writes that clone, so the hook lets git find nothing from it (`clone-git.ts`).
It takes the clone from the session's directory and from where Dispatch puts the clones, runs git in the main checkout with that clone handed over through `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE`, so git reads the config and the hooks of the clone's own `.git`, which the sandbox and a deny rule keep from the Worker, and enters no submodule; it runs gh in the main checkout, and keeps its log and its state in the main checkout's `.lab/`.
A stop that comes from no clone publishes nothing.
The hook runs no Stop checks there: `bun check` is the Worker's code.
It blocks the stop once, asking the Worker to run `bun check` itself, then goes on to the Done judge at the next stop, and does not ask again on that head; CI's own run of the checks is what holds the change.
The hook then hands the relay the session's model and worktree, which a headless resume needs, and its line in `.lab/outcomes.log` says `"api":true`, which the watch reads.
In a Worker's session, an Author's or one the Worker bench launches with `LAB_ROLE=worker`, a PreToolUse guard (`factory/hooks/refuse-author-publish.ts`) refuses `git push`, `gh pr create` and `gh pr ready`.
