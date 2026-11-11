#!/usr/bin/env bun

/**
 * The watch of an orchestrating session. Every minute it reads the PRs of the watched issues, or the
 * repository's open PRs when it is given none, the sessions and `.lab/outcomes.log`, and prints one line
 * per event it has not printed yet. It ends when every watched issue is closed, or, given none, when no
 * PR it watches is open. What it printed, and since when each PR is still, stay in
 * `.lab/state/factory-watch-<issues>.json` of the main checkout, so a watch armed again goes on from
 * there. A failed first reading ends it; a later one is printed, once until it changes, and retried.
 *
 *   bun scripts/factory/watch.ts [<issue>...]
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { run } from "../land-loop/lib/run.ts";
import { decodeJson } from "../lib/json.ts";
import { EMPTY_MEMORY, Memory, memoryFileOf, watchArgsOf } from "./watch-plan.ts";
import { mainCheckoutOf, watchTurn } from "./watcher.ts";
import type { WatchPorts } from "./watcher.ts";

const POLL_MS = 60_000;

const issues = watchArgsOf(process.argv.slice(2));

const ports: WatchPorts = {
  run,
  readText: (path) => (existsSync(path) ? readFile(path, "utf8") : Promise.resolve("")),
};

const checkout = await mainCheckoutOf(run, import.meta.dir);

const file = memoryFileOf(checkout, issues);

mkdirSync(dirname(file), { recursive: true });

/** What the loop carries from one reading to the next. */
interface WatchState {
  memory: Memory;
  /** The failure printed last; null once a reading succeeds. */
  failure: string | null;
  /** The next reading is the first: its failure ends the watch. */
  first: boolean;
}

const state: WatchState = {
  memory: existsSync(file) ? decodeJson(Memory, file, readFileSync(file, "utf8")) : EMPTY_MEMORY,
  failure: null,
  first: true,
};

for (;;) {
  try {
    const step = await watchTurn(ports, { checkout, issues, memory: state.memory, now: new Date().toISOString() });

    for (const line of step.lines) {
      console.log(line);
    }

    state.memory = step.memory;
    state.failure = null;
    // The Monitor tool kills the watch when it expires: a rename never leaves the memory half written.
    writeFileSync(`${file}.tmp`, JSON.stringify(state.memory));
    renameSync(`${file}.tmp`, file);

    if (step.ends) {
      process.exit(0);
    }
  } catch (error) {
    if (state.first) {
      throw error;
    }

    const failure = `The watch could not read the factory, and tries again in a minute: ${error instanceof Error ? error.message : String(error)}`;

    if (failure !== state.failure) {
      console.log(failure);
      state.failure = failure;
    }
  }

  state.first = false;
  await Bun.sleep(POLL_MS);
}
