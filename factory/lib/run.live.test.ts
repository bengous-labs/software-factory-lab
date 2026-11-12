import { describe, expect, test } from "bun:test";

import { run, runIsolated } from "./run.live.ts";

const PATH = process.env["PATH"] ?? "";

describe("runIsolated", () => {
  test("gives the child only the environment it is passed", async () => {
    const ran = await runIsolated(["env"], { cwd: import.meta.dir, env: { PATH, ONLY: "1" } });

    expect(ran.code).toBe(0);
    expect(
      ran.stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=")[0])
        .toSorted((a = "", b = "") => a.localeCompare(b)),
    ).toEqual(["ONLY", "PATH"]);
  });
});

describe("run", () => {
  test("adds the variables it is passed to this process's environment", async () => {
    const ran = await run(["env"], { cwd: import.meta.dir, env: { ADDED: "1" } });

    expect(ran.stdout).toContain("ADDED=1\n");
    expect(ran.stdout).toContain(`PATH=${PATH}\n`);
  });
});
