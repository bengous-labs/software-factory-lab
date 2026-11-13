# What the steps share

`shared/` holds what several steps use and none owns, and imports no step.

- `ask.port.ts`, `ask.live.ts`, `review.port.ts`, `tool-guard.ts` and `resolve.live.ts`: a call to a model and the guard of its tools, which holds every Judge to reading (`factory/land/AGENTS.md`).
- `author.live.ts` and `author-mark.ts`: the Author's token, and the marks the Author's comments carry; `factory/install/AGENTS.md` says who the Author is and where its token lives.
- `finding.ts`, `findings.ts` and `threads.ts`: a finding's vocabulary, its marker, and the review threads that hold the findings.
- `conversation.ts` and `review-round.ts`: a PR's conversation, and the names of the Review rounds.
- `relay.port.ts`: the port through which the Stop hook leaves a PR's relay.
- `api-worker.ts`: what an API Worker is made of, for Dispatch, the Stop hook and the relay: its key helper, its sandbox, its settings file and log, and the command of a headless turn; `factory/dispatch/AGENTS.md` says what an API Worker is.
