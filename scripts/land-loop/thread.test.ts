import { describe, expect, test } from "bun:test";

import { AUTHOR_MARK } from "./author-mark.ts";
import type { Run } from "./ports/run.ts";
import { answer, argsOf, REPLY, RESOLVE } from "./thread.ts";

describe("argsOf", () => {
  test("a thread id and a reply are read; a missing or blank one is refused", () => {
    expect(argsOf(["PRRT_1", "Fixed in abc"])).toEqual({ id: "PRRT_1", body: "Fixed in abc" });
    expect(argsOf(["PRRT_1"])).toBeNull();
    expect(argsOf(["PRRT_1", "  "])).toBeNull();
    expect(argsOf([" ", "x"])).toBeNull();
  });
});

describe("answer", () => {
  test("replies in the thread, then resolves that same thread", async () => {
    const calls: string[][] = [];

    const run: Run = (argv) => {
      calls.push([...argv]);

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };

    await answer(run, "/repo", "PRRT_1", "Rejected: intended");

    expect(calls).toEqual([
      [
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
      ["gh", "api", "graphql", "-f", `query=${RESOLVE}`, "-f", "id=PRRT_1"],
    ]);
  });

  test("a failed reply resolves nothing", async () => {
    const calls: string[][] = [];

    const run: Run = (argv) => {
      calls.push([...argv]);

      return Promise.resolve({ code: 1, stdout: "", stderr: "denied" });
    };

    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types rejects matchers as void; Bun returns the promise the test awaits.
    await expect(answer(run, "/repo", "PRRT_1", "x")).rejects.toThrow("denied");
    expect(calls).toHaveLength(1);
  });
});
