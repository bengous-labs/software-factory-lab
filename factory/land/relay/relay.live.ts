/**
 * The relay's process (`bin/relay.ts`): every 30 s it takes one turn of `main.ts` and keeps the keys it
 * delivered in `.lab/state/watch-<pr>.json`. It ends when the PR is landed or closed, and writes its
 * start and its end to `.lab/outcomes.log`.
 *
 *   bun factory/bin/relay.ts <pr>
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OUTCOMES_LOG } from "../../contract.ts";
import { requiredOf } from "../../lib/env.ts";
import { decodeJson } from "../../lib/json.ts";
import { checked } from "../../lib/run.port.ts";
import type { Leave, Run, RunOptions } from "../../lib/run.port.ts";
import { ghEnv, requiredAuthorToken } from "../shared/author.live.ts";
import { deliverer, postToSocket } from "./deliver.live.ts";
import { readPr, relayDeliverer, turn } from "./main.ts";
import type { RelayIo } from "./main.ts";
import { relayFilesOf } from "./relay-start.live.ts";
import { relayLineOf, SeenKeys, targetOf } from "./wakes.ts";

const POLL_MS = 30_000;

/** What the relay's process takes from its door: the commands it runs, and the headless turn it leaves running. */
export interface RelayPorts {
  readonly run: Run;
  readonly leave: Leave;
}

/** The relay of the PR `process.argv[2]`, in the current directory, until the PR is landed or closed. */
export async function main({ run, leave }: RelayPorts): Promise<void> {
  const pr = Number(process.argv[2]);

  if (!Number.isInteger(pr)) {
    throw new TypeError("usage: bun factory/bin/relay.ts <pr>");
  }

  const cwd = process.cwd();
  const files = relayFilesOf(cwd, pr);

  mkdirSync(files.stateDir, { recursive: true });
  writeFileSync(files.pid, `${process.pid}\n`);

  const seen = new Set<string>(
    existsSync(files.seen) ? decodeJson(SeenKeys, files.seen, readFileSync(files.seen, "utf8")) : [],
  );

  const outcomes = (event: "started" | "ended", reason: string | null): void => {
    appendFileSync(join(cwd, OUTCOMES_LOG), `${relayLineOf(new Date().toISOString(), pr, event, reason)}\n`);
  };

  const gh: RunOptions = { cwd, env: ghEnv(requiredAuthorToken(process.env)) };

  const io: RelayIo = {
    read: () => readPr(run, gh, pr),
    session: () => targetOf(readFileSync(files.session, "utf8")),
    deliver: relayDeliverer({
      agents: () => checked(run, ["claude", "agents", "--json"], { cwd }),
      place: { checkout: cwd, home: requiredOf(process.env, "HOME") },
      now: Date.now,
      deliver: deliverer({
        run,
        leave,
        post: postToSocket,
        sleep: (ms) => Bun.sleep(ms),
        env: process.env,
        uid: process.getuid?.() ?? 0,
        cwd,
      }),
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
        writeFileSync(files.seen, JSON.stringify([...seen]));
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
