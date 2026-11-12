/**
 * One turn of the relay of a pull request (`bin/relay.ts`): it reads the PR as the Author's machine
 * account and delivers the Wakes it has not delivered yet, as one turn in the session of the PR's latest
 * Publication: on that session's messaging socket while it runs, else by resuming it. The Owner's words
 * reach an idle background session as its user's: the relay stops it, then resumes it with them.
 */

import { checked } from "../../lib/run.port.ts";
import type { Run, RunOptions } from "../../lib/run.port.ts";
import { conversationArgsOf } from "../shared/conversation.ts";
import {
  ownerWordsIn,
  prStateOf,
  readingOf,
  resumeArgsOf,
  routeOf,
  socketLineOf,
  stoppedIn,
  stopWanted,
  wakeTextOf,
  wakeThreadsQueryOf,
} from "./wakes.ts";
import type { Delivered, PrState, Reading, Route } from "./wakes.ts";

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

/**
 * What a deliverer sends: the route, the line for a socket, the command for a resume, and whether the
 * listing of sessions shows the session stopped.
 */
export interface Delivery {
  readonly route: Route;
  readonly socketLine: string;
  readonly resumeArgs: readonly string[];
  readonly stopped: () => Promise<boolean>;
}

/** A stop the listing did not show in time: the relay counts these to bound its stops. */
export class NotStopped extends Error {
  override readonly name = "NotStopped";
}

/** What `relayDeliverer` needs: the listing of sessions, and the deliverer that sends a delivery. */
export interface DeliverPorts {
  /** What `claude agents --json` prints. */
  readonly agents: () => Promise<string>;
  readonly deliver: (delivery: Delivery) => Promise<Delivered | null>;
}

/**
 * The relay's delivery over `ports`: it routes each text from the listing of sessions, and counts the
 * stops in a row that throw `NotStopped`, which a delivery that goes through resets. Past the bound of
 * `stopWanted`, the Owner's words take the socket rather than another stop.
 */
export function relayDeliverer(ports: DeliverPorts): RelayIo["deliver"] {
  const stops = { failed: 0 };

  return async (session, text, ownerWords) => {
    try {
      const via = await ports.deliver({
        route: routeOf(await ports.agents(), session, stopWanted(ownerWords, stops.failed)),
        socketLine: socketLineOf(text),
        resumeArgs: resumeArgsOf(session, text),
        stopped: async () => stoppedIn(await ports.agents(), session),
      });

      if (via !== null) {
        stops.failed = 0;
      }

      return via;
    } catch (error) {
      if (error instanceof NotStopped) {
        stops.failed += 1;
      }

      throw error;
    }
  };
}
