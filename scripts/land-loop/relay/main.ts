#!/usr/bin/env bun

/**
 * The relay of one pull request, left detached by the Stop hook at a Publication, in the main checkout.
 * Every 30 s it reads the PR as the Author's machine account and delivers the Wakes it has not
 * delivered yet, as one turn in the session of the PR's latest Publication: on that session's messaging
 * socket while it runs, else by resuming it. The Owner's words reach an idle background session as its
 * user's: the relay stops it, then resumes it with them. The keys it delivered are
 * kept in `.lab/state/watch-<pr>.json`. It ends when the PR is landed or closed, and writes its start and its
 * end to `.lab/outcomes.log`.
 *
 *   bun scripts/land-loop/relay/main.ts <pr>
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { decodeJson } from "../../lib/json.ts";
import { ghEnv, requiredAuthorToken } from "../lib/author.ts";
import { deliverer, postToSocket } from "../lib/deliver.ts";
import type { Delivered } from "../lib/deliver.ts";
import { relayFilesOf } from "../lib/relay-start.ts";
import { checked, run } from "../lib/run.ts";
import type { Run, RunOptions } from "../ports/run.ts";
import {
  ownerWordsIn,
  prStateOf,
  readingOf,
  relayLineOf,
  resumeArgsOf,
  routeOf,
  SeenKeys,
  socketLineOf,
  stoppedIn,
  wakeTextOf,
  wakeThreadsQueryOf,
} from "./wakes.ts";
import type { PrState, Reading } from "./wakes.ts";

const POLL_MS = 30_000;

/** Reads the PR's state with `gh`, under `options`. */
export async function readPr(runner: Run, options: RunOptions, pr: number): Promise<PrState> {
  const view = await checked(runner, ["gh", "pr", "view", String(pr), "--json", "state,isDraft,headRefOid"], options);
  const checks = await runner(["gh", "pr", "checks", String(pr), "--json", "name,bucket,link"], options);

  const conversation = await checked(
    runner,
    [
      "gh",
      "api",
      "--paginate",
      `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`,
      "--jq",
      ".[] | {id: (.id | tostring), author: .user.login, body}",
    ],
    options,
  );

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
 * that did not go through are delivered by a later turn; the end line is tried once, and the relay ends
 * either way.
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

if (import.meta.main) {
  const pr = Number(process.argv[2]);

  if (!Number.isInteger(pr)) {
    throw new TypeError("usage: bun scripts/land-loop/relay/main.ts <pr>");
  }

  const cwd = process.cwd();
  const files = relayFilesOf(cwd, pr);
  mkdirSync(files.stateDir, { recursive: true });
  writeFileSync(files.pid, `${process.pid}\n`);
  // An on-disk name: existing state files carry it, so it stays.
  const seenFile = join(files.stateDir, `watch-${pr}.json`);

  const seen = new Set<string>(
    existsSync(seenFile) ? decodeJson(SeenKeys, seenFile, readFileSync(seenFile, "utf8")) : [],
  );

  const outcomes = (event: "started" | "ended", reason: string | null): void => {
    appendFileSync(join(cwd, ".lab", "outcomes.log"), `${relayLineOf(new Date().toISOString(), pr, event, reason)}\n`);
  };

  const gh: RunOptions = { cwd, env: ghEnv(requiredAuthorToken(process.env)) };

  const deliver = deliverer({
    run,
    post: postToSocket,
    sleep: (ms) => Bun.sleep(ms),
    env: process.env,
    uid: process.getuid?.() ?? 0,
    cwd,
  });

  const agents = (): Promise<string> => checked(run, ["claude", "agents", "--json"], { cwd });

  const io: RelayIo = {
    read: () => readPr(run, gh, pr),
    session: () => readFileSync(files.session, "utf8").trim(),
    deliver: async (session, text, ownerWords) =>
      deliver({
        route: routeOf(await agents(), session, ownerWords),
        socketLine: socketLineOf(text),
        resumeArgs: resumeArgsOf(session, text),
        stopped: async () => stoppedIn(await agents(), session),
      }),
  };

  outcomes("started", null);

  for (;;) {
    try {
      const { delivered, via, pending, ends } = await turn(pr, seen, io);

      for (const key of delivered) {
        seen.add(key);
      }

      if (delivered.length > 0) {
        writeFileSync(seenFile, JSON.stringify([...seen]));
        console.log(`${new Date().toISOString()} delivered by ${via}: ${delivered.join(" ")}`);
      } else if (pending > 0) {
        console.log(`${new Date().toISOString()} ${pending} Wake(s) did not go through: a later turn sends them again`);
      }

      if (ends) {
        outcomes("ended", "the PR landed or closed");
        rmSync(files.pid, { force: true });
        process.exit(0);
      }
    } catch (error) {
      console.error(`${new Date().toISOString()} relay: ${error instanceof Error ? error.message : String(error)}`);
    }

    await Bun.sleep(POLL_MS);
  }
}
