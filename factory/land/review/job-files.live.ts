/**
 * The files the review job's processes share at its root checkout: the earlier findings the thread step
 * writes and the runner reads, and the result the runner writes and the workflow uploads. The doors of
 * `factory/bin/` read and write them through these functions, so none spells a file's name.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { decodeJson } from "../../lib/json.ts";
import { EarlierThreads } from "../shared/findings.ts";
import type { EarlierThread } from "../shared/findings.ts";
import { REVIEW_RESULT_FILE, REVIEW_THREADS_FILE } from "./review-report.ts";
import type { ReviewResult } from "./review-report.ts";

/** Writes the earlier findings `threads` to the threads file of `workspace`. */
export function writeEarlierThreads(workspace: string, threads: readonly EarlierThread[]): void {
  writeFileSync(join(workspace, REVIEW_THREADS_FILE), `${JSON.stringify(threads, null, 2)}\n`);
}

/** The earlier findings in the threads file of `workspace`; throws, naming the file, when it does not read. */
export function readEarlierThreads(workspace: string): readonly EarlierThread[] {
  const file = join(workspace, REVIEW_THREADS_FILE);

  return decodeJson(EarlierThreads, file, readFileSync(file, "utf8"));
}

/** Writes the job's `result` to the result file of `workspace`, which the workflow uploads. */
export function writeResult(workspace: string, result: ReviewResult): void {
  writeFileSync(join(workspace, REVIEW_RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
}
