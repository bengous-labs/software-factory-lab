# software-factory-lab

This repository builds a software factory: a dark factory where agents turn issues into landed changes, and the Owner, the one human accountable for it, steps in only where human judgment is needed. Orchestrators hand issues to Workers; each Worker implements its issue, commits and stops, and the Land loop publishes its change as a pull request, brings the review back to it, and lands it. The Owner talks to the Orchestrators and approves the pull requests too critical to land alone.

The factory is built one subsystem at a time, and its design keeps moving. The Land loop, which carries a finished change through review to the Trunk, is the first subsystem in place, and it is still being built. Read what exists as one part of the factory, not as its whole shape. The app under `app/` is a small task CLI that gives the agents something to change; `docs/usage.md` documents it.

## Your task

- Each behaviour you add or change gets a test.
- Commit your work, then stop.
- Do only the issue you were given.
- Your last message is a checkpoint, not a report: what you committed, in a sentence or two. A question left in it keeps your work from being published: leave one only for a choice that is the Owner's.
- The Land loop starts a turn in your session when your pull request needs you: a failing check, a review finding, a comment of the Owner, a conflict with `dev`, the pull request back in draft. Fix what you accept with a commit, name in your last message each finding you reject and why, then stop. You arm no watch and answer nothing on GitHub.

## How to decide

The factory is young and its design moves: a rule serves the goal, it is not the goal.

- What we protect, in this order: no secret leaves the machine and no change lands around the Land gate; `dev` stays green; the change lands fast; the code stays tidy. Guards enforce the first: a gap in a guard is the defect to report.
- A choice a revert undoes is yours: take it, and give its reason in the commit message.
- A choice that changes how the factory works beyond your issue (a new step, a new actor, a door to the Owner that moves) is the Owner's: put it as a question in your last message. Nothing is published until the Owner answers.
- A rule gives its reason. Where the reason does not hold for your case, say so in the commit message. Where a rule is wrong, change it in the same pull request.

## Commands

- `bun check` is the one check: CI's `validate` job and the Stop hook run it. It chains the typecheck, oxlint, the format check, the gates in `scripts/gates/`, knip, the tests with coverage, then the coverage floor.
- `bun run mods` validates and tests the mods under `.claude/plugins/` with the Claude Code that `bun install` puts in `node_modules`; `bun check` runs it.
- `bun test <file>` runs one test file; add `-t <name>` to run the tests whose name matches.
- `bun scripts/ci/mutation.ts run` is CI's `mutation` job: Stryker on each module `stryker.config.ts` lists that your branch changes, through its lines or its test file. `bun check` does not run it; run it before you stop when your change reaches one of those modules.
- `bun app/src/cli.ts <command>` runs the CLI on `todo.json`, or on the file `TODO_FILE` names.
- `bun scripts/factory/dispatch.ts <issue> [--model <model>]`, or `/dispatch <issue>` in the Owner's session, hands an issue to a Worker: its worktree from `origin/dev`, and a background session launched with the one versioned prompt.

## Architecture

The repository holds three packages, the app (`app/`), the Land loop (`scripts/land-loop/`) and Dispatch (`scripts/factory/`), the tooling that checks them (`scripts/gates/`, `scripts/lint/`, `scripts/ci/`, `scripts/hooks/`), and pure helpers both import (`scripts/lib/`).

### The Land loop

The Trunk is `dev`; `main` is the release branch. A finished change goes through five steps, each in its own directory under `scripts/land-loop/`:

1. `stop/`: the Stop hook publishes an Author's committed branch as a pull request.
2. `relay/`: one process per pull request starts a turn in the Author's session when the pull request needs it.
3. `merge-bot/`: on each pull request event, the Merge bot routes the pull request, has it reviewed, posts the two required checks and enables the merge.
4. `routing/` and `review/`: the Judges that route and review.
5. `queue/`: GitHub's merge queue lands the change.

The rules under `.claude/rules/` hold each step's design. Claude Code loads one when you read a file it covers.

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
