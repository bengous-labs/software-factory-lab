/**
 * The watch of an orchestrating session. Every minute it reads the PRs of the watched issues, or the
 * repository's open PRs when it is given none, the sessions and `.lab/outcomes.log`, and prints one line
 * per event it has not printed yet. It ends when every watched issue is closed; given none, it runs until
 * it is stopped. What it printed, and since when each PR is still, stay in
 * `.lab/state/factory-watch-<issues>.json` of the main checkout, so a watch armed again goes on from
 * there; with `--standing`, the first arming of a session, its first turn tells again each standing
 * event an earlier run printed that still holds. A failed first reading ends it; a later failure to read
 * or to save is printed, once until it changes, and retried.
 *
 *   bun factory/bin/watch.ts [--standing] [<issue>...]
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { decodeJson } from "../lib/json.ts";
import { run } from "../lib/run.live.ts";
import { EMPTY_MEMORY, Memory, memoryFileOf, watchArgsOf } from "./watch-plan.ts";
import type { WatchStep } from "./watch-plan.ts";
import { mainCheckoutOf, watchTurn } from "./watcher.ts";
import type { WatchPorts } from "./watcher.ts";

const POLL_MS = 60_000;

/**
 * Writes `memory` to a file of process `pid`, then renames it over `file`: the Monitor tool kills the
 * watch when it expires, and a watch armed again can overlap the one it replaces.
 */
export function save(file: string, memory: Memory, pid: number): void {
  const written = `${file}.${pid}.tmp`;

  writeFileSync(written, JSON.stringify(memory));
  renameSync(written, file);
}

/** What the loop carries from one turn to the next. */
interface WatchState {
  memory: Memory;
  /** The failure printed last; null once a turn reads and saves. */
  failure: string | null;
  /** The next reading is the first: its failure ends the watch. */
  first: boolean;
}

/** The watch's process: reads the factory every minute and prints each event once, until every watched issue is closed. */
export async function main(): Promise<void> {
  const { issues, standing } = watchArgsOf(process.argv.slice(2));

  const ports: WatchPorts = {
    run,
    readText: (path) => (existsSync(path) ? readFile(path, "utf8") : Promise.resolve("")),
  };

  const checkout = await mainCheckoutOf(run, import.meta.dir);
  const file = memoryFileOf(checkout, issues);
  mkdirSync(dirname(file), { recursive: true });

  const state: WatchState = {
    memory: existsSync(file) ? decodeJson(Memory, file, readFileSync(file, "utf8")) : EMPTY_MEMORY,
    failure: null,
    first: true,
  };

  /** Prints `failure` unless it is the one printed last. */
  const report = (failure: string): void => {
    if (failure !== state.failure) {
      console.log(failure);
      state.failure = failure;
    }
  };

  /** One turn's step; null when a reading after the first failed. */
  const stepOrNull = async (): Promise<WatchStep | null> => {
    try {
      return await watchTurn(ports, {
        checkout,
        issues,
        memory: state.memory,
        now: new Date().toISOString(),
        retell: standing && state.first,
      });
    } catch (error) {
      if (state.first) {
        throw error;
      }

      report(
        `The watch could not read the factory, and tries again in a minute: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  };

  for (;;) {
    const step = await stepOrNull();

    if (step !== null) {
      for (const line of step.lines) {
        console.log(line);
      }

      state.memory = step.memory;

      try {
        save(file, state.memory, process.pid);
        state.failure = null;
      } catch (error) {
        report(
          `The watch could not save what it printed, and tries again in a minute: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (step.ends) {
        process.exit(0);
      }
    }

    state.first = false;
    await Bun.sleep(POLL_MS);
  }
}
