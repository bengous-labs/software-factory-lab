import { describe, expect, test } from "bun:test";

import { failedPassVerdict, moduleVerdict, runPasses, verdictOfPasses, withFailedBase } from "./mutation.ts";
import type { Hunk, ModuleRun, ModuleVerdict, Mutant } from "./mutation.ts";

const passed = (module: string, failures: readonly string[] = []): ModuleVerdict => ({
  failures,
  summary: `mutation: ${module}: summary`,
});

/** A pass of `b.ts` that rejects as Stryker's does on a module that cannot load; the others pass. */
const failingOnB = (module: string): Promise<ModuleVerdict> =>
  module === "b.ts"
    ? Promise.reject(new Error("There were failed tests\nin the initial test run."))
    : Promise.resolve(passed(module));

describe("runPasses", () => {
  test("a module whose pass throws fails alone, named with the error, and the modules after it still run", async () => {
    const lines: string[] = [];

    expect(
      await runPasses(["a.ts", "b.ts", "c.ts"], failingOnB, (line) => {
        lines.push(line);
      }),
    ).toBe(1);
    expect(lines).toEqual([
      "mutation: a.ts: summary",
      "b.ts: not mutated, its pass failed: There were failed tests in the initial test run.",
      "mutation: b.ts: not mutated, its pass failed",
      "mutation: c.ts: summary",
    ]);
  });

  test("counts every failure of every module, each printed before its summary", async () => {
    const lines: string[] = [];

    const failed = await runPasses(
      ["a.ts", "b.ts"],
      (module) => Promise.resolve(passed(module, [`${module}:1:1 Survived`, `${module}:2:1 Survived`])),
      (line) => {
        lines.push(line);
      },
    );

    expect(failed).toBe(4);
    expect(lines).toEqual([
      "a.ts:1:1 Survived",
      "a.ts:2:1 Survived",
      "mutation: a.ts: summary",
      "b.ts:1:1 Survived",
      "b.ts:2:1 Survived",
      "mutation: b.ts: summary",
    ]);
  });

  test("a pass that throws something other than an error is named by what it threw", async () => {
    const lines: string[] = [];

    await runPasses(
      ["a.ts"],
      // oxlint-disable-next-line prefer-promise-reject-errors -- the case is a rejection that is no Error.
      () => Promise.reject("boom"),
      (line) => {
        lines.push(line);
      },
    );

    expect(lines[0]).toBe("a.ts: not mutated, its pass failed: boom");
    expect(failedPassVerdict("a.ts", "x\n  y").failures).toEqual(["a.ts: not mutated, its pass failed: x y"]);
  });
});

describe("withFailedBase", () => {
  test("a base pass that threw keeps the head's failures and summary, and adds its own failure", () => {
    expect(
      withFailedBase(passed("a.ts", ["a.ts:3:1 Survived"]), "a.ts", "There were failed tests\nat the base."),
    ).toEqual({
      failures: [
        "a.ts:3:1 Survived",
        "a.ts: its base pass failed, so no mutant the base's tests killed was checked: There were failed tests at the base.",
      ],
      summary: "mutation: a.ts: summary; its base pass failed",
    });
  });
});

describe("verdictOfPasses", () => {
  const source = ["const a = 1;", "if (a > 0) {", "  run();", "}"].join("\n");
  const changed: readonly Hunk[] = [{ file: "x/mod.ts", oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }];

  const survivor: Mutant = {
    fileName: "/repo/x/mod.ts",
    location: { start: { line: 2, column: 5 }, end: { line: 2, column: 10 } },
    mutatorName: "EqualityOperator",
    replacement: "a >= 0",
    status: "Survived",
  };

  const run = (fields: Partial<ModuleRun>): ModuleRun => ({
    module: "x/mod.ts",
    source,
    hunks: changed,
    head: () => Promise.resolve([survivor]),
    base: null,
    ...fields,
  });

  const SURVIVOR = "x/mod.ts:2:5 Survived EqualityOperator: a > 0 => a >= 0";

  test("a base pass that throws keeps the head's survivors, and adds its own failure", async () => {
    const verdict = await verdictOfPasses(run({ base: () => Promise.reject(new Error("There were failed tests")) }));

    expect(verdict.failures).toEqual([
      SURVIVOR,
      "x/mod.ts: its base pass failed, so no mutant the base's tests killed was checked: There were failed tests",
    ]);
    expect(verdict.summary).toEndWith("; its base pass failed");
  });

  test("a base pass that runs is read for the mutants its tests killed", async () => {
    const verdict = await verdictOfPasses(
      run({ hunks: [], base: () => Promise.resolve([{ ...survivor, status: "Killed" }]) }),
    );

    expect(verdict.failures).toEqual([`${SURVIVOR} (killed at the base)`]);
  });

  test("no base pass, or one with nothing to run, adds no failure to the head's verdict", async () => {
    const headAlone = moduleVerdict({ module: "x/mod.ts", source, head: [survivor], base: null, hunks: changed });

    expect(await verdictOfPasses(run({ base: null }))).toEqual(headAlone);
    expect(await verdictOfPasses(run({ base: () => Promise.resolve(null) }))).toEqual(headAlone);
  });

  test("a head pass that throws throws, and the base pass never runs", () => {
    let baseRan = false;

    const failing = run({
      head: () => Promise.reject(new Error("There were failed tests in the initial test run.")),
      base: () => {
        baseRan = true;

        return Promise.resolve([]);
      },
    });

    expect(verdictOfPasses(failing)).rejects.toThrow("There were failed tests in the initial test run.");
    expect(baseRan).toBe(false);
  });
});
