# The factory

`factory/` holds the code that turns an issue into a landed change, and imports nothing outside itself.
The repository's tooling (`scripts/`) checks it, and the app (`app/`) is what its agents change.

## Where things are

- `bin/`: one file per process.
  A hook, a workflow or a skill names these files and the three hooks of `hooks/`, nothing else in `factory/`.
  A door builds the real ports and hands them to what it starts: the `main` of a shell for the Stop hook, the Merge bot, the relay and the watch, and for the others the logic itself, called in the door.
- `hooks/`: the hooks of a session: its role, and the two guards.
- `roles/`: the instructions a session reads at start.
- `land/`: the Land loop, one directory per step, and `shared/` for what several steps use and none owns.
- `dispatch/`, `watch/`, `measure/`: hand an issue to a Worker, follow the Workers, measure the Land loop.
- `install/`: what names the repository the factory is installed in, and its logins.
- `contract.ts`: every name stored outside the code.
- `lib/`: small pure helpers and the launch of a process.
  The tooling imports it too.

## A file's name says its layer

| Name                         | What it is                                        | What it may do                                                                                           |
| ---------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `x.ts`                       | logic                                             | no I/O of its own: it reaches outside through a port it is handed; from `effect`, the data toolbox alone |
| `x.live.ts`                  | a call outside: a process, a model, a file        | I/O                                                                                                      |
| `x.port.ts`                  | the type through which logic takes a call outside | no I/O                                                                                                   |
| `x.prompt.ts`                | a Judge's text                                    | no I/O                                                                                                   |
| `x.actor.ts`                 | a Judge's settings: tools, timeout, its own model | no I/O                                                                                                   |
| `x.test.ts`, `x.fixtures.ts` | a test, and what tests share                      | anything; a test the mutation job runs starts no process (see Mutation)                                  |
| a file of `bin/` or `hooks/` | a process's entry                                 | I/O                                                                                                      |

The `local/layers` lint rule reads the layer in the name and refuses the rest.
Logic takes its I/O as an argument: a port, passed from `bin/`.
No module captures the real `run`.
Put a decision in a logic file, where the tests and the mutation job reach it.

## What may import what

A directory imports only what lies below it, in this order: `bin/` and `hooks/`; `dispatch/`, `watch/` and `measure/`; a step of `land/`; `land/shared/`; `install/` and `contract.ts`; `lib/`.
Two directories of one rank never import each other: a step of the Land loop never imports another step.
The Merge bot alone calls two steps, the routing and the review.
Two steps talk through what is stored at GitHub, under a name `contract.ts` holds, never through each other's code.
When two directories need one thing, it moves down to where both may import it.
A test imports anything.
The same lint rule holds all of this, and its message names the way out.

## Before you write a helper

Look first in what is installed, in this order.

- Bun: `Bun.Glob`, `Bun.file`, `Bun.spawn`, `$`, `Bun.YAML`, `Bun.TOML`, `bun:test`.
- Effect, as a data toolbox everywhere: `Schema` for every decode, `Result` and `Option` for a failure as a value, `Exit` for a schema's default, `Predicate` for a type guard.
  Read `node_modules/effect/AGENTS.md` first.
- Effect, as a runtime, in `x.live.ts` and `bin/` only, and only where a test proves the same behaviour on every path, a cleanup that fails to start included.
  The shells are plain `async`/`await`.
  Never in a logic file, never in the two guards of `hooks/`, which run on every tool call.
- Node: `node:fs`, `node:path`, `node:os`.
- The factory's own: `lib/json.ts` to decode JSON by a schema, `lib/run.port.ts` for `checked`, `lib/env.ts` for a variable a process cannot run without, `lib/markdown.ts` for text that reaches GitHub, `land/shared/` for a PR's threads, findings and conversation.

## Names stored outside the code

A label, a check name, a marker in a comment, a key of the state record, a variable a session holds: each keeps its spelling whatever the code calls the thing, since GitHub's ruleset, open pull requests and existing records hold it.
`contract.ts` holds the ones several steps read, a module the ones it alone writes and reads, and `contract.test.ts` pins every one, wherever it lives: a name that changes changes the test.
A name that says `lab` stays as it is.

## Mutation

Every logic file is mutated against the tests of its directory that are no `x.live.test.ts`: no list to keep, a file joins when a `x.test.ts` sits in its directory (`stryker.config.ts`).
A test of a shell is a `x.live.test.ts`: it does not count.
A logic file with no such test in its directory fails the silent-breaks gate (`scripts/gates/check-silent-breaks.ts`).
A test the mutation job runs starts no process: a process takes its time from the machine's load, and a test that times out under Stryker's parallel runs kills a mutant no assertion checked.
`scripts/ci/no-process.test.ts` runs them all with each start refused and printed (`scripts/ci/no-process.ts`), and fails on a refusal even one the code under test catches: a test that starts a process, through a fixture or a `x.live.ts` too, is a `x.live.test.ts`.

## Commands

- `bun factory/bin/dispatch.ts <issue> [--model <model>] [--effort <level>] [--api]`, or `/dispatch <issue>` in the Owner's session, hands an issue to a Worker; `--api` makes it an API Worker, which bills the Owner's Console API key (`factory/dispatch/AGENTS.md`).
- `bun factory/bin/watch.ts [--standing] [<issue>...]`, or `/watch` in the Owner's session, follows the Workers.
- `bun factory/bin/measure.ts --since YYYY-MM-DD` prints the Land loop's measure for the Owner.
- `bun factory/bin/sandbox-probe.ts`, which the Owner runs, shows on the machine that the sandbox of a Worker holds (`factory/install/AGENTS.md`).
