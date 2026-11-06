import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { FLOOR, floorErrors, totalsOf } from "./check-coverage-floor.ts";

const SCRIPT = join(import.meta.dir, "check-coverage-floor.ts");

const record = (file: string, functions: [number, number], lines: [number, number]): string =>
  [
    "TN:",
    `SF:${file}`,
    `FNF:${functions[1]}`,
    `FNH:${functions[0]}`,
    "DA:1,1",
    `LF:${lines[1]}`,
    `LH:${lines[0]}`,
    "end_of_record",
  ].join("\n");

const lcovOf = (...records: string[]): string => `${records.join("\n")}\n`;

const FLOOR_OF_HALF = { lines: 500, functions: 500 };

describe("totalsOf", () => {
  test("sums the line and function counts of every file", () => {
    expect(totalsOf(lcovOf(record("a.ts", [1, 2], [3, 10]), record("b.ts", [4, 4], [7, 10])))).toEqual({
      lines: { hit: 10, found: 20 },
      functions: { hit: 5, found: 6 },
    });
  });

  test("an empty report, or one naming no source file, throws", () => {
    expect(() => totalsOf("")).toThrow("the lcov report names no source file");
    expect(() => totalsOf("TN:\nend_of_record\n")).toThrow("the lcov report names no source file");
  });
});

describe("floorErrors", () => {
  test("totals above their floors pass", () => {
    expect(floorErrors(totalsOf(lcovOf(record("a.ts", [6, 10], [51, 100]))), FLOOR_OF_HALF)).toEqual([]);
  });

  test("totals exactly at their floors pass", () => {
    expect(floorErrors(totalsOf(lcovOf(record("a.ts", [5, 10], [50, 100]))), FLOOR_OF_HALF)).toEqual([]);
  });

  test("a line total under its floor fails, naming the measure and the floor", () => {
    expect(floorErrors(totalsOf(lcovOf(record("a.ts", [5, 10], [49, 100]))), FLOOR_OF_HALF)).toEqual([
      "lines coverage is 49.00 % (49/100), under its 50.0 % floor. Add a test for the code you left uncovered; the floor never drops.",
    ]);
  });

  test("a function total under its floor fails, naming the measure and the floor", () => {
    expect(floorErrors(totalsOf(lcovOf(record("a.ts", [4, 10], [50, 100]))), FLOOR_OF_HALF)).toEqual([
      "functions coverage is 40.00 % (4/10), under its 50.0 % floor. Add a test for the code you left uncovered; the floor never drops.",
    ]);
  });

  test("the floors hold tenths of a percent: one hit under 68.8 % of the lines fails", () => {
    const under = totalsOf(lcovOf(record("a.ts", [801, 1000], [687, 1000])));

    expect(floorErrors(under, FLOOR)).toHaveLength(1);
    expect(floorErrors(totalsOf(lcovOf(record("a.ts", [801, 1000], [688, 1000]))), FLOOR)).toEqual([]);
  });
});

/** The gate run in a directory whose `coverage/lcov.info` holds `lcov`, or has none when it is null. */
function run(lcov: string | null) {
  const root = mkdtempSync(join(tmpdir(), "coverage-floor-"));

  if (lcov !== null) {
    mkdirSync(join(root, "coverage"));
    writeFileSync(join(root, "coverage", "lcov.info"), lcov);
  }

  return $`bun ${SCRIPT}`.cwd(root).nothrow().quiet();
}

describe("the gate", () => {
  test("passes on a report over the floors", async () => {
    expect((await run(lcovOf(record("a.ts", [10, 10], [100, 100])))).exitCode).toBe(0);
  });

  test("fails on a report under a floor, naming it", async () => {
    const refused = await run(lcovOf(record("a.ts", [10, 10], [1, 100])));

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain("lines coverage is 1.00 % (1/100), under its 68.8 % floor");
  });

  test("fails with a clear error on a missing or empty report", async () => {
    const missing = await run(null);

    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain(
      "no coverage/lcov.info: run `bun test --coverage --coverage-reporter=lcov` first.",
    );

    const empty = await run("");

    expect(empty.exitCode).toBe(1);
    expect(empty.stderr.toString()).toContain("the lcov report names no source file");
  });
});
