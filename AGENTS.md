# software-factory-lab

This repository builds a software factory: a dark factory where agents turn issues into landed changes, and the Owner, the one human accountable for it, steps in only where human judgment is needed. Orchestrators hand issues to Workers; each Worker implements its issue, opens a pull request, and answers its review until the change lands. The Owner talks to the Orchestrators and approves the pull requests too critical to land alone.

The factory is built one subsystem at a time, and its design keeps moving. The Land loop, which carries a finished change through review to the Trunk, is the first subsystem in place, and it is still being built. Read what exists as one part of the factory, not as its whole shape. The app under `app/` is a small task CLI that gives the agents something to change; `docs/usage.md` documents it.

## Your task

- Each behaviour you add or change gets a test.
- Leave the push and the pull request to the Stop hook: it publishes your work when you stop.
- Do only the issue you were given. When it is done, end your turn without asking anything: a question left in your last message keeps the Stop hook from publishing your work.

## Commands

- `bun check` is the one check: CI's `validate` job and the Stop hook run it. It chains the typecheck, oxlint, the format check, the gates in `scripts/gates/`, knip, the tests with coverage, then the coverage floor.
- `bun test <file>` runs one test file; add `-t <name>` to run the tests whose name matches.
- `bun scripts/ci/mutation.ts run` is CI's `mutation` job: Stryker on each module `stryker.config.ts` lists that your branch changes, through its lines or its test file. `bun check` does not run it; run it before you stop when your change reaches one of those modules.
- `bun app/src/cli.ts <command>` runs the CLI on `todo.json`, or on the file `TODO_FILE` names.

## Architecture

The repository holds two packages, the app (`app/`) and the Land loop (`scripts/land-loop/`), the tooling that checks them (`scripts/gates/`, `scripts/lint/`, `scripts/ci/`, `scripts/hooks/`), and pure helpers both import (`scripts/lib/`).

### The Land loop

The Trunk is `dev`; `main` is the release branch.

1. The Stop hook (`scripts/land-loop/stop/`, wired in `.claude/settings.json`) runs when an Author stops on a branch ahead of `dev` with a clean tree. It runs `bun check` (the Stop checks), asks the Done judge, a fork of the session, whether the change is finished, then pushes, opens or readies the PR and tells the Author to arm its PR watch (`pr-watch.ts`; `thread.ts` answers a finding). It logs each step to `.lab/stop.log` and skips `dev`, `main` and `lab/*`.
2. The Merge bot (`scripts/land-loop/merge-bot/`) runs from `.github/workflows/merge-bot.yml`, checked out from the default branch, with the agents' GitHub App token: one Merge bot run per PR event, and a Sweep of every open PR on a push to `dev` and on a cron. It keeps a state record in one PR comment, calls the Judges, posts the Review check (`agent-review`) and the Land gate (`land-gate`), and enables the merge.
3. The Judges are headless Agent SDK calls whose answer a JSON schema binds:
   - the Routing rules (`routing/routing-rules.ts`), then the Routing judge, with no tool (`lib/ask.ts`), set the Land route (`auto`, or `owner` with a Land approval) and the Review depth. The Routing rules apply the routing policy of the factory config, `.github/software-factory.json`, which the Merge bot reads from its checkout of `dev`: an `ownerPaths` path (`.github/`, and `bun.lock` and `scripts/vendor/`, which the Code review does not read), and the config itself, sends the PR to the Owner; a `factoryPaths` path (the factory's code, `.claude/`, the agent docs and the build and gate configs) or a `deepReviewPaths` path (`app/src/store/`) gets a deep Code review and lands without the Owner once `validate` and `mutation` are green and no Important is open; a PR that touches a path outside `factoryPaths` goes to the Owner past `lineCap` or on a breaking commit, and the Routing judge, asked about its other paths, may send it to the Owner. The Owner holds any PR with the `land:human` label;
   - the Code review is Claude Code's native `/code-review`, run in its own job (`.github/workflows/code-review.yml`, `review/run-review.ts`) with read-only tools under a guard (`review/tool-guard.ts`). The Merge bot dispatches it, reads its result from the run's artifact, and posts the Important and Nit findings inline (`review/post-plan.ts`), in at most two Review rounds; an Important sends the PR back to draft;
   - the Principal judge (`review/principal-judge.ts`), with no tool, runs on a Routing answer with `needsFable`; its OK stands in for the Owner's Land approval, the `land-ok` label. No Routing rule sets `needsFable`, so it does not run.
4. GitHub's merge queue lands the change with a merge commit. `queue/repost.ts`, run by `.github/workflows/queue-checks.yml`, re-posts the App's two required checks on the queue's own commit.

Each step splits into a pure decision over a snapshot (`stop/decide.ts`, `merge-bot/decide.ts`, `routing/routing-rules.ts`) and an adapter that reads the state and acts on the decision (`stop/hook.ts`, `merge-bot/main.ts`). A Merge bot run re-reads the whole PR, so an event that arrives twice, late or never changes nothing. Put new decisions in the pure files, where the tests and mutation testing reach them. Adapters take their I/O through the types in `ports/`; `lib/` holds the live implementations, and tests pass fakes.

Strings stored outside the code keep their spelling when the code's vocabulary changes: the labels `land-ok`, `land:auto` and `land:human`, the check names `agent-review` and `land-gate`, `FORK_MARKER`, the state record's keys and the file names under `.lab/state/`. Open PRs, existing records and GitHub's ruleset read them.

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
