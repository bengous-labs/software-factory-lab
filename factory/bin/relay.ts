#!/usr/bin/env bun

/**
 * The relay of one pull request, left detached by the Stop hook at a Publication, in the main checkout
 * (`land/relay/`). Every 30 s it takes one turn: it reads the PR as the Author's machine account and
 * delivers the Wakes it has not delivered yet. The keys it delivered are kept in
 * `.lab/state/watch-<pr>.json`. It ends when the PR is landed or closed, and writes its start and its end
 * to `.lab/outcomes.log`.
 *
 *   bun factory/bin/relay.ts <pr>
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deliverer, NotStopped, postToSocket } from "../land/relay/deliver.live.ts";
import { readPr, turn } from "../land/relay/main.ts";
import type { RelayIo } from "../land/relay/main.ts";
import { relayFilesOf } from "../land/relay/relay-start.live.ts";
import {
  relayLineOf,
  resumeArgsOf,
  routeOf,
  SeenKeys,
  socketLineOf,
  stoppedIn,
  stopWanted,
} from "../land/relay/wakes.ts";
import { ghEnv, requiredAuthorToken } from "../land/shared/author.live.ts";
import { decodeJson } from "../lib/json.ts";
import { run } from "../lib/run.live.ts";
import { checked } from "../lib/run.port.ts";
import type { RunOptions } from "../lib/run.port.ts";

const POLL_MS = 30_000;

const pr = Number(process.argv[2]);

if (!Number.isInteger(pr)) {
  throw new TypeError("usage: bun factory/bin/relay.ts <pr>");
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

const stops = { failed: 0 };

const io: RelayIo = {
  read: () => readPr(run, gh, pr),
  session: () => readFileSync(files.session, "utf8").trim(),
  deliver: async (session, text, ownerWords) => {
    try {
      const via = await deliver({
        route: routeOf(await agents(), session, stopWanted(ownerWords, stops.failed)),
        socketLine: socketLineOf(text),
        resumeArgs: resumeArgsOf(session, text),
        stopped: async () => stoppedIn(await agents(), session),
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
  },
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
