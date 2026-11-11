## Problem

`count` prints how many tasks are open, and nothing about the done ones: `bun app/src/cli.ts count` on a list of three tasks, two of them done, prints `1 open`, and the user cannot tell how far along the list is.

## Hints

- `app/src/commands/count.ts` builds the line; `docs/usage.md` shows its output.

## Done when

- [ ] `count` prints the open and the done tasks, such as `1 open, 2 done`.
- [ ] `docs/usage.md` shows the new output.
- [ ] `bun check` passes.
