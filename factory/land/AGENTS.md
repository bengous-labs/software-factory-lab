# The Land loop

The Trunk is `dev`; `main` is the release branch.
A finished change goes through five steps, each in its own directory:

1. `stop/`: the Stop hook publishes an Author's committed branch as a pull request.
2. `relay/`: one process per pull request starts a turn in the Author's session when the pull request needs it.
3. `merge-bot/`: on each pull request event, the Merge bot routes the pull request, has it reviewed, posts the two required checks and enables the merge.
4. `routing/` and `review/`: the Judges that route and review.
5. `queue/`: GitHub's merge queue lands the change.

`shared/` holds what several steps use and none owns: the call to a model and its tool guard, a PR's findings and conversation, the Author's marks and token.

## The Judges

The Judges answer through a JSON schema: the Done judge, a fork of the Author's session, and the Routing judge and the Code review, headless Agent SDK calls.
Every Judge and every Stop hook fork reads with `Read`, `Grep`, `Glob` and one read-only `git` command per `Bash` call, under the guard of `shared/tool-guard.ts`: no write tool, never an empty tool list, never `Monitor` for a fork.
Each text a Judge reads lives in a `*.prompt.ts` file, and each Judge's tools and timeout, with its model when it has one of its own, in a `*.actor.ts` file beside it: `review/code-review.actor.ts`, `routing/routing-judge.actor.ts`, `stop/done-judge.actor.ts`.
A Judge's port takes them whole, as `judgeSettings`, and a fork's command reads them; the lint rule `local/judges` (`scripts/lint/judges.ts`) refuses them written anywhere else.

## The code of a step

Each step splits into pure decisions over a snapshot (`stop/decide.ts`, `merge-bot/decide.ts` and the rules it assembles, `routing/routing-rules.ts`, `relay/wakes.ts` with the relay's turn and its counts of failed stops and of failed headless starts in `relay/main.ts`) and a shell that reads the state and acts on the decision (`stop/hook.live.ts`, `merge-bot/main.live.ts`, `relay/relay.live.ts`).
A Merge bot run re-reads the whole PR, so an event that arrives twice, late or never changes nothing.
Put new decisions in the pure files, where the tests and mutation testing reach them.
A shell takes its I/O through the types in the `*.port.ts` files; the `*.live.ts` files hold the live implementations, the doors under `factory/bin/` pass them, and tests pass fakes.
A step can be replaced without touching another: it imports no other step, and what it leaves for the others is stored at GitHub.

Strings stored outside the code keep their spelling when the code's vocabulary changes: the labels `land-ok`, `land:auto` and `land:human`, the check names `agent-review` and `land-gate`, `FORK_MARKER`, the state record's keys and the file names under `.lab/state/`.
Open PRs, existing records and GitHub's ruleset read them.
