---
paths:
  - "scripts/land-loop/**"
---

# The Land loop's code

Each step splits into a pure decision over a snapshot (`stop/decide.ts`, `merge-bot/decide.ts`, `routing/routing-rules.ts`, `relay/wakes.ts`) and an adapter that reads the state and acts on the decision (`stop/hook.ts`, `merge-bot/main.ts`, `relay/main.ts`). A Merge bot run re-reads the whole PR, so an event that arrives twice, late or never changes nothing. Put new decisions in the pure files, where the tests and mutation testing reach them. Adapters take their I/O through the types in `ports/`; `lib/` holds the live implementations, and tests pass fakes.

Strings stored outside the code keep their spelling when the code's vocabulary changes: the labels `land-ok`, `land:auto` and `land:human`, the check names `agent-review` and `land-gate`, `FORK_MARKER`, the state record's keys and the file names under `.lab/state/`. Open PRs, existing records and GitHub's ruleset read them.
