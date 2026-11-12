import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { leave, run, runIsolated } from "./run.live.ts";

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

describe("leave", () => {
  test("leaves the command running with only the environment it is passed, its output appended to the log, whose directory it creates", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "leave-")), "state", "out.log");
    const options = { cwd: import.meta.dir, env: { PATH, ONLY: "1" }, log };

    const first = leave(["sh", "-c", "echo out; echo err >&2; echo only=$ONLY home=${HOME:-none}"], options);

    expect(await first.exited).toBe(0);
    expect(await leave(["sh", "-c", "echo again"], options).exited).toBe(0);
    expect(first.pid).toBeGreaterThan(0);
    expect(first.pid).not.toBe(process.pid);
    expect(readFileSync(log, "utf8").split("\n").toSorted()).toEqual(["", "again", "err", "only=1 home=none", "out"]);
  });

  test("the log it creates is its owner's alone: it holds what a session printed", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "leave-")), "out.log");

    await leave(["sh", "-c", "echo out"], { cwd: import.meta.dir, env: { PATH }, log }).exited;

    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  test("says the exit code the command ended with, and 1 when a signal ended it", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "leave-")), "out.log");
    const options = { cwd: import.meta.dir, env: { PATH }, log };

    expect(await leave(["sh", "-c", "exit 3"], options).exited).toBe(3);
    expect(await leave(["sh", "-c", "kill -9 $$"], options).exited).toBe(1);
  });

  test("throws when the command does not start", () => {
    const log = join(mkdtempSync(join(tmpdir(), "leave-")), "out.log");

    expect(() => leave(["/no/such/command"], { cwd: import.meta.dir, env: { PATH }, log })).toThrow(
      "the process did not start: /no/such/command",
    );
  });
});
