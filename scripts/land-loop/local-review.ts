#!/usr/bin/env bun

/**
 * The Author's rejection of an Important the Stop hook's local review found on the current head: it
 * stores the reason in `.lab/state/review-<head>-answers.json`, which the next stop reads. A fix needs
 * no command: the Author commits, and the next stop reviews the new head.
 *
 *   bun scripts/land-loop/local-review.ts reject <n> "<reason>"
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checked, run } from "./lib/run.ts";
import type { Run } from "./ports/run.ts";
import { answersOf, answersRecordName, localReviewOf, rejectArgsOf, reviewRecordName } from "./stop/decide.ts";
import type { LocalReviewRecord } from "./stop/decide.ts";

export const USAGE = `usage: bun scripts/land-loop/local-review.ts reject <n> "<reason>"  (n: the finding's number in the Stop hook's block text)`;

/** The head's review, or null when its record is missing or does not read: either way there is nothing to reject. */
function reviewAt(file: string): LocalReviewRecord | null {
  if (!existsSync(file)) {
    return null;
  }

  try {
    return localReviewOf(file, readFileSync(file, "utf8"));
  } catch {
    // An unreadable record answers as a missing one: the usage line, exit 1.
    return null;
  }
}

export async function reject(
  argv: readonly string[],
  runner: Run,
  cwd: string,
): Promise<{ readonly code: 0 | 1; readonly output: string }> {
  const root = (await checked(runner, ["git", "rev-parse", "--show-toplevel"], { cwd })).trim();
  const head = (await checked(runner, ["git", "rev-parse", "HEAD"], { cwd })).trim();
  const stateDir = join(root, ".lab", "state");
  const review = reviewAt(join(stateDir, reviewRecordName(head)));
  const args = review === null ? null : rejectArgsOf(argv, review);

  if (args === null) {
    return { code: 1, output: USAGE };
  }

  const file = join(stateDir, answersRecordName(head));
  const answers = existsSync(file) ? answersOf(file, readFileSync(file, "utf8")) : {};
  writeFileSync(file, `${JSON.stringify({ ...answers, [String(args.n)]: `Rejected: ${args.reason}` }, null, 2)}\n`);

  return { code: 0, output: `rejected finding ${args.n} of ${head.slice(0, 7)}` };
}

if (import.meta.main) {
  const { code, output } = await reject(process.argv.slice(2), run, process.cwd());

  if (code === 0) {
    console.log(output);
  } else {
    console.error(output);
    process.exitCode = code;
  }
}
