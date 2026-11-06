import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedOf } from "./fast-check-seed.ts";

const ROOT = join(import.meta.dir, "..", "..");

describe("seedOf", () => {
  test("no variable, no seed; an integer is the seed", () => {
    expect(seedOf()).toBeUndefined();
    expect(seedOf("42")).toBe(42);
    expect(seedOf("-7")).toBe(-7);
  });

  test("refuses a value that is not an integer", () => {
    for (const value of ["", " ", "1.5", "abc", "9007199254740993"]) {
      expect(() => seedOf(value)).toThrow("FAST_CHECK_SEED must be an integer");
    }
  });
});

describe("the preload", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fast-check-seed-"));
    // The fixture's fast-check must be the preload's own module, so it resolves through the repository's.
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    writeFileSync(
      join(dir, "seed.test.ts"),
      [
        'import { test } from "bun:test";',
        'import * as fc from "fast-check";',
        'test("seed", () => {',
        "  console.log(`seed=${String(fc.readConfigureGlobal().seed)}`);",
        "});",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The seed a `bun test` run from the repository root gives fast-check, as the fixture prints it. */
  function seedUnder(seed?: string): string {
    const env = { ...process.env };
    delete env["FAST_CHECK_SEED"];

    const ran = Bun.spawnSync([process.execPath, "test", join(dir, "seed.test.ts")], {
      cwd: ROOT,
      env: seed === undefined ? env : { ...env, FAST_CHECK_SEED: seed },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(ran.exitCode).toBe(0);

    return /seed=(\S+)/u.exec(ran.stdout.toString())?.[1] ?? "";
  }

  test("under FAST_CHECK_SEED every property runs on that seed", () => {
    expect(seedUnder("20261106")).toBe("20261106");
  });

  test("without it the seed is left to fast-check, which draws a new one each run", () => {
    expect(seedUnder()).toBe("undefined");
  });
});
