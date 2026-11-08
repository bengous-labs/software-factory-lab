import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTHOR_MARK } from "./author-mark.ts";
import { argsOf, post } from "./comment.ts";
import type { Run, RunOptions } from "./ports/run.ts";
import type { PrState } from "./pr-watch.ts";
import { wakesOf } from "./pr-watch.ts";

const OPEN: PrState = { state: "OPEN", draft: false, head: "c0ffee1", checks: [], threads: [], comments: [] };

const recording = (code: number) => {
  const calls: string[][] = [];
  const options: RunOptions[] = [];

  const run: Run = (argv, runOptions) => {
    calls.push([...argv]);
    options.push(runOptions);

    return Promise.resolve({ code, stdout: "", stderr: code === 0 ? "" : "denied" });
  };

  return { run, calls, options };
};

describe("argsOf", () => {
  test("a PR number and a comment are read; a missing, blank or non-integer one is refused", () => {
    expect(argsOf(["86", "Kept the cap: the guarantees need it"])).toEqual({
      pr: 86,
      body: "Kept the cap: the guarantees need it",
    });
    expect(argsOf(["86"])).toBeNull();
    expect(argsOf(["86", "  "])).toBeNull();
    expect(argsOf(["", "x"])).toBeNull();
    expect(argsOf(["8.6", "x"])).toBeNull();
    expect(argsOf(["pr", "x"])).toBeNull();
  });
});

describe("post", () => {
  test("posts the comment on the PR's conversation with the author's mark, as the Author", async () => {
    const { run, calls, options } = recording(0);

    await post(run, "/repo", "t0k", { pr: 86, body: "Kept the cap" });

    expect(calls).toEqual([["gh", "pr", "comment", "86", "--body", `Kept the cap\n\n${AUTHOR_MARK}`]]);
    expect(options).toEqual([{ cwd: "/repo", env: { GH_TOKEN: "t0k" } }]);
  });

  test("no Author token: the command exits non-zero with the reason before any gh call", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "author-")), "absent");

    const ran = Bun.spawnSync([process.execPath, join(import.meta.dir, "comment.ts"), "86", "x"], {
      env: { ...process.env, LAB_AUTHOR_TOKEN_FILE: missing, PATH: "/nonexistent" },
    });

    expect(ran.exitCode).not.toBe(0);
    expect(ran.stderr.toString()).toContain(
      `no Author token at ${missing}: the Owner provisions it (AGENTS.md, Identities); nothing was posted`,
    );
  });

  test("the PR watch prints nothing for the comment it posts, and still wakes on an unmarked one from the same login", async () => {
    const { run, calls } = recording(0);

    await post(run, "/repo", "t0k", { pr: 86, body: "Kept the cap" });

    const posted = calls[0]?.at(-1) ?? "";

    const comments = [
      { id: "1", author: "bengous-labs-author", body: posted },
      { id: "2", author: "bengous-labs-author", body: "Why keep the cap?" },
    ];

    expect(wakesOf(86, { ...OPEN, comments })).toEqual([
      { key: "comment:2", line: "Comment on PR #86 by bengous-labs-author: Why keep the cap?" },
    ]);
  });

  test("a failed post throws", async () => {
    const { run } = recording(1);

    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types rejects matchers as void; Bun returns the promise the test awaits.
    await expect(post(run, "/repo", "t0k", { pr: 86, body: "x" })).rejects.toThrow("denied");
  });
});
