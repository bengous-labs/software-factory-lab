# software-factory-lab

This repository builds a software factory: a dark factory where agents turn issues into landed changes, and the Owner, the one human accountable for it, steps in only where human judgment is needed. Orchestrators hand issues to Workers; each Worker implements its issue, opens a pull request, and answers its review until the change lands. The Owner talks to the Orchestrators and approves the pull requests too critical to land alone.

The factory is built one subsystem at a time, and its design keeps moving. The Land loop, which carries a finished change through review to the Trunk, is the first subsystem in place, and it is still being built. Read what exists as one part of the factory, not as its whole shape. The app under `app/` is a small task CLI that gives the agents something to change; `docs/usage.md` documents it.

## Your task

- Each behaviour you add or change gets a test.
- Leave the push and the pull request to the Stop hook: it publishes your work when you stop.
- Do only the issue you were given. When it is done, end your turn without asking anything: a question left in your last message keeps the Stop hook from publishing your work.

## Commands

- `bun check` is the one check: CI's `validate` job and the Stop hook run it. It chains the typecheck, oxlint, the format check, the gates in `scripts/gates/`, knip, the tests with coverage, then the coverage floor.
- `bun run mods` validates and tests the mods under `.claude/plugins/` with the Claude Code that `bun install` puts in `node_modules`; `bun check` runs it.
- `bun test <file>` runs one test file; add `-t <name>` to run the tests whose name matches.
- `bun scripts/ci/mutation.ts run` is CI's `mutation` job: Stryker on each module `stryker.config.ts` lists that your branch changes, through its lines or its test file. `bun check` does not run it; run it before you stop when your change reaches one of those modules.
- `bun app/src/cli.ts <command>` runs the CLI on `todo.json`, or on the file `TODO_FILE` names.

## Architecture

The repository holds two packages, the app (`app/`) and the Land loop (`scripts/land-loop/`), the tooling that checks them (`scripts/gates/`, `scripts/lint/`, `scripts/ci/`, `scripts/hooks/`), and pure helpers both import (`scripts/lib/`).

### The Land loop

The Trunk is `dev`; `main` is the release branch.

1. The Stop hook (`scripts/land-loop/stop/`, wired in `.claude/settings.json`) runs when an Author stops on a branch ahead of `dev` with a clean tree. It runs `bun check` (the Stop checks), asks the Done judge, a fork of the session, whether the change is finished, which may answer `YES, HOLD: <reason>` to hold the PR for the Owner's read (the hook puts `land:human` under the Author's identity, a hold only the Owner lifts), then pushes, opens or readies the PR and tells the Author to arm its PR watch (`pr-watch.ts`; `thread.ts` answers a finding, `comment.ts` posts on the PR's conversation). It logs each step to `.lab/stop.log` and skips `dev`, `main` and `lab/*`.
2. The Merge bot (`scripts/land-loop/merge-bot/`) runs from `.github/workflows/merge-bot.yml`, checked out from the default branch, with the agents' GitHub App token: one Merge bot run per PR event, and a Sweep of every open PR on a push to `dev`, when CI completes on that push (the Sweep that reads `dev`'s red), and on a cron. It keeps a state record in one PR comment, calls the Judges, posts the Review check (`agent-review`) and the Land gate (`land-gate`), and enables the merge.
3. The Judges are headless Agent SDK calls whose answer a JSON schema binds: Every Judge and every Stop hook fork reads with `Read`, `Grep`, `Glob` and one read-only `git` command per `Bash` call, under the guard of `review/tool-guard.ts`: no write tool, never an empty tool list, never `Monitor` for a fork.
   - the Routing rules (`routing/routing-rules.ts`), then the Routing judge, with read-only tools under the guard (`lib/ask.ts`, `review/tool-guard.ts`), set the Land route (`auto`, or `owner` with a Land approval) and the Review depth. The Routing rules apply the routing policy of the factory config, `.github/software-factory.json`, which the Merge bot reads from its checkout of `dev`: an `ownerPaths` path (`.github/`, and `bun.lock` and `scripts/vendor/`, which the Code review does not read), and the config itself, sends the PR to the Owner; a `factoryPaths` path (the factory's code, `.claude/`, the agent docs and the build and gate configs) or a `deepReviewPaths` path (`app/src/store/`) gets a deep Code review and lands without the Owner (a light one when it only deletes files and those among them are Markdown or text) once `validate` and `mutation` are green and no Important is open; a PR that touches a path outside `factoryPaths` goes to the Owner on a breaking commit; past `lineCap` it gets a deep Code review and lands without the Owner. The Routing judge, asked about the paths no rule names, sets their Review depth and whether a Patch delta is read again; it never sends a PR to the Owner. The Owner holds any PR with a `land:human` label a login other than the Merge bot's App set; one the Merge bot set follows the route of each patch;
   - the Code review is Claude Code's native `/code-review`, run in its own job (`.github/workflows/code-review.yml`, `review/run-review.ts`) with read-only tools under a guard (`review/tool-guard.ts`). The Merge bot dispatches it, reads its result from the run's artifact, and posts the Important and Nit findings inline (`review/post-plan.ts`), in at most three Review rounds; a PR that touches an `ownerPaths`, `factoryPaths` or `deepReviewPaths` path or the factory config gets a security pass in the same round (`review/security-prompt.ts`), posted as `(security)` findings: the third runs after a round 2 that posted an Important, or on a push that needs a read; an Important in round 3, or a push after it that needs a read, holds the PR for the Owner, but a push from round 3's head that only answers the Nits of a round 3 with no Important, in files round 3 posted a Nit on, outside `deepReviewPaths` and in at most 100 lines, needs none (`withNitAnswers`); an Important sends the PR back to draft; the PR watch wakes the Author on an Important or a Nit, and the Author fixes or rejects each;
4. GitHub's merge queue lands the change with a merge commit. `queue/repost.ts`, run by `.github/workflows/queue-checks.yml`, re-posts the App's two required checks on the queue's own commit.

Each step splits into a pure decision over a snapshot (`stop/decide.ts`, `merge-bot/decide.ts`, `routing/routing-rules.ts`) and an adapter that reads the state and acts on the decision (`stop/hook.ts`, `merge-bot/main.ts`). A Merge bot run re-reads the whole PR, so an event that arrives twice, late or never changes nothing. Put new decisions in the pure files, where the tests and mutation testing reach them. Adapters take their I/O through the types in `ports/`; `lib/` holds the live implementations, and tests pass fakes.

Strings stored outside the code keep their spelling when the code's vocabulary changes: the labels `land-ok`, `land:auto` and `land:human`, the check names `agent-review` and `land-gate`, `FORK_MARKER`, the state record's keys and the file names under `.lab/state/`. Open PRs, existing records and GitHub's ruleset read them.

### Identities

The Owner, `bengous`, gives the Land approval, the `land-ok` label, by hand on GitHub or with `/land <n>` in a session whose `gh` acts as `bengous`: the mod `.claude/plugins/land/` puts the label on the Owner's own typing alone, at the terminal or through Remote Control, shows its result in a band the model never reads, and refuses an agent's command that puts the label. A `/land` typed in a Worker's session puts the label as the Author, and counts for nothing. The Owner also gives the `land:human` veto, and releases `main`. The Author, every Worker, pushes, opens, readies and answers its PR as the machine account `bengous-labs-author`: the Stop hook, `thread.ts` and `comment.ts` read its fine-grained token from `~/.config/software-factory-lab/author-token` (`LAB_AUTHOR_TOKEN_FILE` overrides the path) and publish nothing without it. A `land-ok` it puts counts for nothing. The Merge bot and the Code review act as the agents' App, `bengous-labs-agents[bot]`. `merge-bot.yml` names the three logins: `OWNER`, `AUTHOR_LOGIN`, `APP_LOGIN`. Every Worker is launched with `GH_TOKEN` set from that file, so any `gh` it runs acts as the machine account.

The Owner provisions the machine account: a member of `bengous-labs` with the Write role on this repository, and a fine-grained token whose resource owner is `bengous-labs`, limited to this repository, with Contents, Pull requests, Issues and Workflows in read and write. Workflows is needed because the Author pushes branches that change `.github/workflows/`: GitHub refuses such a push from a token without it. The token file is mode 600.

### The app

`app/src/commands/` holds one pure function over the task list per command; `app/src/cli.ts` parses argv, loads the store and saves the result. `app/src/store/` is the task file format: a change there can make existing task files unreadable, and both format versions in `app/test/fixtures/` must still read.

### Layers

`scripts/lint/layers.map.ts` places every linted file in a package and a layer, and the `local/layers` lint rule holds each file to what its layer may import and do. The domain layer takes from `effect` only `Schema`, `Data`, `Option`, `Result` and `Struct` as values. Only the infra, entry, tooling and test layers do I/O (`fetch`, `process`, any `Bun` member but `Bun.Glob`). A file that no glob of the map matches fails the lint. The map and the rule belong to the Owner: fix a refused import by moving the I/O to the entry point or behind a port.

## Gates

- A lint suppression names its rules and gives its reason on the same line: `// oxlint-disable-next-line some-rule -- why`. `local/layers` and the budget rules of `scripts/lint/exceptions.ts` admit no suppression.
- `scripts/lint/exceptions.ts` lists the functions over budget, each with its measure. The list only shrinks: an entry leaves when its function is fixed, and the ratchet fails when a listed measure moves.
- The coverage floor in `scripts/gates/check-coverage-floor.ts` only rises.
- Property tests use fast-check. `FAST_CHECK_SEED` fixes their seed; the mutation passes set it.
- A test that runs git on a fixture repository passes `fixtureEnv` (`scripts/gates/fixture-env.ts`) as its environment, so an inherited `GIT_DIR` cannot reach the real repository.

## Effect

The code uses Effect for schemas and results. Before writing Effect code, read `node_modules/effect/AGENTS.md`. Search `node_modules/effect/src` for what that guide does not cover.

## Agent SDK

The Judges call Claude Code through `@anthropic-ai/claude-agent-sdk`. Before writing Agent SDK code, read its types in `node_modules/@anthropic-ai/claude-agent-sdk/`: `sdk.d.ts` holds `query`, its `Options` and the messages it streams, and `sdk-tools.d.ts` the input and output of each built-in tool. The guide is https://code.claude.com/docs/en/agent-sdk/typescript.
