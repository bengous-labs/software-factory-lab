import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTHOR_MARK, REJECT_MARK } from "./author-mark.ts";
import type { Run, RunOptions } from "./ports/run.ts";
import { answer, argsOf, REPLY, RESOLVE, USAGE } from "./thread.ts";

const recording = (code: number) => {
  const calls: Array<{ argv: string[]; options: RunOptions }> = [];

  const run: Run = (argv, options) => {
    calls.push({ argv: [...argv], options });

    return Promise.resolve({ code, stdout: "{}", stderr: code === 0 ? "" : "denied" });
  };

  return { run, calls };
};

describe("argsOf", () => {
  test('a fix is read as given; a rejection becomes "Rejected: <reason>"', () => {
    expect(argsOf(["PRRT_1", "Fixed in abc1234: count the rejections apart"])).toEqual({
      id: "PRRT_1",
      body: "Fixed in abc1234: count the rejections apart",
    });
    expect(argsOf(["PRRT_1", "--reject", "the record is never written without reviewRounds"])).toEqual({
      id: "PRRT_1",
      body: "Rejected: the record is never written without reviewRounds",
    });
  });

  test("a reply that is neither a fix nor a rejection, a blank reason, or a missing or blank argument is refused", () => {
    expect(argsOf(["PRRT_1", "the record is never written without reviewRounds"])).toBeNull();
    expect(argsOf(["PRRT_1", "--reject", ""])).toBeNull();
    expect(argsOf(["PRRT_1", "--reject", "  "])).toBeNull();
    expect(argsOf(["PRRT_1", "--reject"])).toBeNull();
    expect(argsOf(["PRRT_1", "--reject", "the", "bound", "is", "inclusive"])).toBeNull();
    expect(argsOf(["PRRT_1", "Fixed in abc: x", "extra"])).toBeNull();
    expect(argsOf(["PRRT_1", "Fixed in "])).toBeNull();
    expect(argsOf(["PRRT_1"])).toBeNull();
    expect(argsOf(["PRRT_1", "  "])).toBeNull();
    expect(argsOf([" ", "Fixed in abc: x"])).toBeNull();
  });

  test("the usage line names both answers", () => {
    expect(USAGE).toBe(
      'usage: bun scripts/land-loop/thread.ts <thread-id> "Fixed in <sha>: <what changed>" | bun scripts/land-loop/thread.ts <thread-id> --reject "<reason>"',
    );
  });
});

/** The reply `answer` posts for `body`, as its `-f body=` argument. */
const postedBodyOf = async (body: string): Promise<string | undefined> => {
  const { run, calls } = recording(0);

  await answer(run, "/repo", "t0k", { id: "PRRT_1", body });

  return calls[0]?.argv.at(-1);
};

describe("answer", () => {
  test("a fix: replies in the thread with the Author's mark, then resolves that same thread, both as the Author", async () => {
    const { run, calls } = recording(0);

    await answer(run, "/repo", "t0k", { id: "PRRT_1", body: "Fixed in abc1234: count the rejections apart" });

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
          `body=Fixed in abc1234: count the rejections apart\n\n${AUTHOR_MARK}`,
        ],
        options: { cwd: "/repo", env: { GH_TOKEN: "t0k" } },
      },
      {
        argv: ["gh", "api", "graphql", "-f", `query=${RESOLVE}`, "-f", "id=PRRT_1"],
        options: { cwd: "/repo", env: { GH_TOKEN: "t0k" } },
      },
    ]);
  });

  test("a rejection carries the reject mark before the Author's mark", async () => {
    expect(REJECT_MARK).toBe("<!-- lab-author-reject -->");
    expect(await postedBodyOf("Rejected: the record is never written without reviewRounds")).toBe(
      "body=Rejected: the record is never written without reviewRounds\n\n<!-- lab-author-reject -->\n\n<!-- lab-author-reply -->",
    );
  });

  test("a placeholder in the answer is escaped for GitHub; code and the marks are not", async () => {
    expect(await postedBodyOf("Rejected: <sha> is `review-<head>.json`")).toBe(
      "body=Rejected: &lt;sha> is `review-<head>.json`\n\n<!-- lab-author-reject -->\n\n<!-- lab-author-reply -->",
    );
    expect(await postedBodyOf("Fixed in abc1234: reads <file>")).toBe(
      "body=Fixed in abc1234: reads &lt;file>\n\n<!-- lab-author-reply -->",
    );
  });

  test("a failed reply resolves nothing", async () => {
    const { run, calls } = recording(1);

    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types rejects matchers as void; Bun returns the promise the test awaits.
    await expect(answer(run, "/repo", "t0k", { id: "PRRT_1", body: "x" })).rejects.toThrow("denied");
    expect(calls).toHaveLength(1);
  });

  test("no Author token: the command exits non-zero with the reason before any gh call", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "author-")), "absent");

    const ran = Bun.spawnSync([process.execPath, join(import.meta.dir, "thread.ts"), "PRRT_1", "Fixed in abc: x"], {
      env: { ...process.env, LAB_AUTHOR_TOKEN_FILE: missing, PATH: "/nonexistent" },
    });

    expect(ran.exitCode).not.toBe(0);
    expect(ran.stderr.toString()).toContain(
      `no Author token at ${missing}: the Owner provisions it (AGENTS.md, Identities); nothing was posted`,
    );
  });

  test("a refused answer exits 1 with the usage line, and posts nothing", () => {
    for (const args of [
      ["PRRT_1", "the record is never written without reviewRounds"],
      ["PRRT_1", "--reject", ""],
    ]) {
      const ran = Bun.spawnSync([process.execPath, join(import.meta.dir, "thread.ts"), ...args], {
        env: { ...process.env, PATH: "/nonexistent" },
      });

      expect(ran.exitCode).toBe(1);
      expect(ran.stderr.toString()).toContain(USAGE);
    }
  });
});
