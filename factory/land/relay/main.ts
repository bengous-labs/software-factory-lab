/**
 * One turn of the relay of a pull request (`bin/relay.ts`): it reads the PR as the Author's machine
 * account and delivers the Wakes it has not delivered yet, as one turn in the session of the PR's latest
 * Publication: on that session's messaging socket while it runs, else by resuming it. The Owner's words
 * reach an idle background session as its user's: the relay stops it, then resumes it with them.
 */

import { checked } from "../../lib/run.port.ts";
import type { Run, RunOptions } from "../../lib/run.port.ts";
import { conversationArgsOf } from "../shared/conversation.ts";
import { ownerWordsIn, prStateOf, readingOf, wakeTextOf, wakeThreadsQueryOf } from "./wakes.ts";
import type { Delivered, PrState, Reading } from "./wakes.ts";

/** Reads the PR's state with `gh`, under `options`. */
export async function readPr(runner: Run, options: RunOptions, pr: number): Promise<PrState> {
  const view = await checked(
    runner,
    ["gh", "pr", "view", String(pr), "--json", "state,isDraft,headRefOid,mergeable"],
    options,
  );

  const checks = await runner(["gh", "pr", "checks", String(pr), "--json", "name,bucket,link"], options);

  const conversation = await checked(runner, conversationArgsOf(pr), options);

  const threads = await checked(
    runner,
    ["gh", "api", "graphql", "-f", `query=${wakeThreadsQueryOf(pr)}`, "-F", "owner={owner}", "-F", "name={repo}"],
    options,
  );

  return prStateOf(view, checks.stdout, conversation, threads);
}

/** What one turn of the relay needs from outside: the PR's state, the session its Wakes go to, and their delivery. */
export interface RelayIo {
  readonly read: () => Promise<PrState>;
  /** The session of the PR's latest Publication. */
  readonly session: () => string;
  /** Delivers `text` to `session`, as the Owner's words when `ownerWords`; null when it did not go through. */
  readonly deliver: (session: string, text: string, ownerWords: boolean) => Promise<Delivered | null>;
}

/** What one turn of the relay did: the keys it delivered, and whether the relay ends. */
export interface Turn {
  /** The keys of the Wakes this turn delivered. */
  readonly delivered: readonly string[];
  /** How they went: on the session's socket or by a resume; null when nothing went through. */
  readonly via: Delivered | null;
  /** The Wakes the turn had to deliver. */
  readonly pending: number;
  readonly ends: boolean;
}

/**
 * One turn of the relay for PR `pr`: reads it, and delivers the Wakes `seen` lacks as one text. Wakes
 * that did not go through are delivered by a later turn; a landed or closed PR has none, and ends the relay.
 */
export async function turn(pr: number, seen: ReadonlySet<string>, io: RelayIo): Promise<Turn> {
  const reading: Reading = readingOf(pr, await io.read(), seen);

  if (reading.wakes.length === 0) {
    return { delivered: [], via: null, pending: 0, ends: reading.ends };
  }

  const keys = reading.wakes.map((wake) => wake.key);
  const via = await io.deliver(io.session(), wakeTextOf(pr, reading), ownerWordsIn(reading));

  return { delivered: via === null ? [] : keys, via, pending: keys.length, ends: reading.ends };
}
