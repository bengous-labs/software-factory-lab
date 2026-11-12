import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readEarlierThreads, readResult, writeEarlierThreads, writeResult } from "./job-files.live.ts";
import { resultOfJson } from "./review-report.ts";
import type { ReviewResult } from "./review-report.ts";

const workspace = () => mkdtempSync(join(tmpdir(), "review-job-"));

const EARLIER = [{ thread: "T1", where: "a.ts:3", finding: "a blank title is saved", reply: "" }];

const FAILED: ReviewResult = {
  kind: "failed",
  cause: "the session stopped",
  request: {
    pr: 7,
    head: "a".repeat(40),
    base: "b".repeat(40),
    patch: "p1",
    round: 2,
    model: "sonnet",
    effort: "medium",
    security: false,
  },
  model: null,
  claudeCodeVersion: null,
  tokens: null,
  runUrl: "https://github.com/o/r/actions/runs/1",
};

describe("the review job's files", () => {
  test("the thread step's earlier findings land in review-threads.json, where the runner reads them back", () => {
    const dir = workspace();

    writeEarlierThreads(dir, EARLIER);

    expect(JSON.parse(readFileSync(join(dir, "review-threads.json"), "utf8"))).toEqual(EARLIER);
    expect(readEarlierThreads(dir)).toEqual(EARLIER);
  });

  test("a threads file outside its schema is refused, naming the file", () => {
    const dir = workspace();

    writeFileSync(join(dir, "review-threads.json"), JSON.stringify([{ where: "a.ts:3" }]));

    expect(() => readEarlierThreads(dir)).toThrow(join(dir, "review-threads.json"));
  });

  test("the runner's result lands in review-result.json, the file the workflow uploads and the Merge bot reads back", () => {
    const dir = workspace();

    writeResult(dir, FAILED);

    expect(resultOfJson(readFileSync(join(dir, "review-result.json"), "utf8"))).toEqual(FAILED);
    expect(readResult(dir)).toEqual(FAILED);
  });

  test("an artifact with no result file, or one that does not read, gives no result", () => {
    const dir = workspace();

    expect(readResult(dir)).toBeNull();

    writeFileSync(join(dir, "review-result.json"), "{}");

    expect(readResult(dir)).toBeNull();
  });

  test("a result path that exists and cannot be read throws, rather than read as no result", () => {
    const dir = workspace();

    mkdirSync(join(dir, "review-result.json"));

    expect(() => readResult(dir)).toThrow("EISDIR");
  });
});
