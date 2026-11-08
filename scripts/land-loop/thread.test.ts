import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTHOR_MARK } from "./author-mark.ts";
import type { Run, RunOptions } from "./ports/run.ts";
import { answer, argsOf, REPLY, RESOLVE } from "./thread.ts";

const recording = (code: number) => {
  const calls: Array<{ argv: string[]; options: RunOptions }> = [];

  const run: Run = (argv, options) => {
    calls.push({ argv: [...argv], options });

    return Promise.resolve({ code, stdout: "{}", stderr: code === 0 ? "" : "denied" });
  };

  return { run, calls };
};

describe("argsOf", () => {
  test("a thread id and a reply are read; a missing or blank one is refused", () => {
    expect(argsOf(["PRRT_1", "Fixed in abc"])).toEqual({ id: "PRRT_1", body: "Fixed in abc" });
    expect(argsOf(["PRRT_1"])).toBeNull();
    expect(argsOf(["PRRT_1", "  "])).toBeNull();
    expect(argsOf([" ", "x"])).toBeNull();
  });
});

describe("answer", () => {
  test("replies in the thread, then resolves that same thread, both as the Author", async () => {
    const { run, calls } = recording(0);

    await answer(run, "/repo", "t0k", { id: "PRRT_1", body: "Rejected: intended" });

    expect(calls).toEqual([
      {
        argv: [
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${REPLY}`,
          "-f",
          "id=PRRT_1",
          "-f",
          `body=Rejected: intended\n\n${AUTHOR_MARK}`,
        ],
        options: { cwd: "/repo", env: { GH_TOKEN: "t0k" } },
      },
      {
        argv: ["gh", "api", "graphql", "-f", `query=${RESOLVE}`, "-f", "id=PRRT_1"],
        options: { cwd: "/repo", env: { GH_TOKEN: "t0k" } },
      },
    ]);
  });

  test("a failed reply resolves nothing", async () => {
    const { run, calls } = recording(1);

    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types rejects matchers as void; Bun returns the promise the test awaits.
    await expect(answer(run, "/repo", "t0k", { id: "PRRT_1", body: "x" })).rejects.toThrow("denied");
    expect(calls).toHaveLength(1);
  });

  test("no Author token: the command exits non-zero with the reason before any gh call", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "author-")), "absent");

    const ran = Bun.spawnSync([process.execPath, join(import.meta.dir, "thread.ts"), "PRRT_1", "x"], {
      env: { ...process.env, LAB_AUTHOR_TOKEN_FILE: missing, PATH: "/nonexistent" },
    });

    expect(ran.exitCode).not.toBe(0);
    expect(ran.stderr.toString()).toContain(
      `no Author token at ${missing}: the Owner provisions it (AGENTS.md, Identities); nothing was posted`,
    );
  });
});
