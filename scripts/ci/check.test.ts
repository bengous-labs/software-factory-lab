import { describe, expect, test } from "bun:test";

import { runStages, spawnStage, STAGES, testsLabel } from "./check.ts";
import type { Stage } from "./check.ts";

const sh = (name: string, script: string): Stage => ({ name, command: ["sh", "-c", script] });

describe("runStages", () => {
  test("passing stages print nothing but one line naming each stage", async () => {
    const verdict = await runStages([sh("one", "echo noise"), sh("two", "echo more noise >&2")], spawnStage);

    expect(verdict).toEqual({ kind: "green", line: "ok: one, two" });
  });

  test("a passing stage's label replaces its name on the line", async () => {
    const verdict = await runStages(
      [{ ...sh("tests", "echo 'Ran 7 tests across 2 files.'"), label: testsLabel }],
      spawnStage,
    );

    expect(verdict).toEqual({ kind: "green", line: "ok: 7 tests" });
  });

  test("a failing stage prints its output and names itself on the last line, with its exit code", async () => {
    const verdict = await runStages(
      [sh("quiet", "echo hidden"), sh("broken", "echo out; echo err >&2; exit 3"), sh("never", "touch never")],
      spawnStage,
    );

    expect(verdict).toEqual({ kind: "red", exitCode: 3, report: "out\nerr\nfailed: broken" });
  });

  test("the stages after a failing one do not run", async () => {
    const ran: string[] = [];

    const verdict = await runStages([sh("a", ""), sh("b", ""), sh("c", "")], (command) => {
      ran.push(command.join(" "));

      return Promise.resolve({ exitCode: ran.length === 2 ? 1 : 0, output: "" });
    });

    expect(ran).toEqual(["sh -c ", "sh -c "]);
    expect(verdict).toEqual({ kind: "red", exitCode: 1, report: "failed: b" });
  });
});

describe("testsLabel", () => {
  test("counts the tests from bun test's summary, one test included", () => {
    expect(testsLabel(" 3 pass\n 0 fail\nRan 928 tests across 80 files. [9.00s]\n")).toBe("928 tests");
    expect(testsLabel("Ran 1 test across 1 file. [26.00ms]")).toBe("1 test");
  });

  test("an output without the summary throws", () => {
    expect(() => testsLabel("no summary")).toThrow("bun test printed no `Ran N tests` summary");
  });
});

test("the stages are the ones the check has always chained, tests and the coverage floor last", () => {
  expect(STAGES.map((stage) => stage.name)).toEqual([
    "typecheck",
    "lint",
    "format",
    "gates",
    "knip",
    "mods",
    "tests",
    "coverage floor",
  ]);
});
