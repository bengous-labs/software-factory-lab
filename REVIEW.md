# Review guide

The CI reviewer reads this guide in its prompt. It sets the bar for this repository.

## What Important means here

Important is reserved for a change that breaks behaviour: a command that gives a wrong result, loses or corrupts a task file, crashes on an input a user can type, or makes an existing task file unreadable. A missing test for a behaviour the change adds is Important. Style, naming and refactoring are Nit at most.

## Cap the nits

Report at most three Nits per review.

## Pre-existing

A problem the change did not introduce is Pre-existing, whatever its weight. It never blocks.

## Do not report

- Anything `bun run check` enforces: type errors, failing tests.
- Formatting.
- `bun.lock`.
