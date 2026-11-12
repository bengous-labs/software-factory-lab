# The relay

The relay (`factory/land/relay/`, started as `factory/bin/relay.ts`) is one detached process per PR, which the Stop hook leaves at a Publication or at a question to the Owner, in the main checkout, and which outlives the session; a later Publication of the PR starts none while it runs.
Every 30 s it reads the PR and delivers each Wake once, as a turn in the session of the PR's latest Publication: a failing check on the PR's head, a conflict with `dev`, with the fetch and the rebase to run, an open Important or Nit finding, an Important a later round reports again, a comment of the Owner, the PR back in draft.
A draft that holds the Author's question with no comment of the Owner after it makes no draft Wake: the Owner's answer in the conversation is the Wake that reaches the session, the draft line with it.
A failing check another Wake already tells makes none: `agent-review`, red on an open Important its finding carries, and the `land-gate` of a conflicting PR; any other red `land-gate`, an ejection from the merge queue among them, makes one.
How the Author answers closes the Wakes: findings ask for its rejections alone, a failing check or a conflict for the fix, and the Owner's words or a draft line get nothing added.
The lab is public and a Wake starts a turn in a session that holds the Author's token: no other login's comment is delivered.
It writes the Wake's lines on the session's messaging socket while the session runs, and resumes it with `claude --bg --resume <session-id> "<the lines>"` and no other flag when it no longer does.
Claude Code hands a socket message to the session as another session's, never as its user's word, so a Wake that holds the Owner's words reaches a background session whose `claude agents --json` status reads `idle` by `claude stop <id>`, then the resume once the listing shows it stopped, since a resume before that starts a copy.
It waits while the status reads `busy`; a turn that starts between that listing and the stop is cut, since Claude Code offers no stop that holds off a busy session.
A session still listed running 30 s after the stop gets nothing: the Wakes stay pending, and the next poll resumes it once it shows stopped, or, while it is still listed idle, runs `claude stop` on it again; after three such stops in a row, the Owner's words go on the socket.
A session with any other status or none, and an interactive one, which Claude Code cannot stop, get the lines on the socket.
An API Worker's session (`factory/dispatch/AGENTS.md`) has no socket, and a background resume would not bill its key: the Stop hook names it in `relay-<pr>.session`, on a second line that holds its model and its worktree.
The relay waits while `claude agents --json` lists that session, which it does for as long as a headless turn runs, since a second resume would start a copy of the conversation; once it is no longer listed, the relay leaves the headless resume of `factory/land/shared/api-worker.ts` running detached in that worktree: `claude -p --resume <session-id>` with the session's model, the API Worker settings file as its only settings, the worktree's root guide and the `dontAsk` mode, then the lines.
Every Wake reaches such a session as a turn of its user, the Owner's words included, so nothing is stopped first.
The turn takes from the relay's environment what a session needs to start and to reach the API, no credential, and its key, its identity and its rules from the settings file; its output goes to the session's log.
The relay looks at that turn for a minute: one that ends with an error in that time, its key refused or its credits spent, delivered nothing, and the session is resumed with the same Wakes after a wait that doubles from one minute to half an hour, for as long as the PR is open.
A turn that still runs after that minute is delivered, whatever its end: one that fails late is not given the same Wakes twice, and one that hangs does not hold the relay, which goes back to its PR.
A background session the relay resumes takes the lines as its prompt too: a Wake of the App reaches a stopped Worker of either kind as a turn of its user.
It ends when the PR lands or closes, which starts no turn, and writes its start and its end to `.lab/outcomes.log`.
A relay that dies is not restarted: the log shows a start with no end.
