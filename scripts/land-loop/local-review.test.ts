import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reject, USAGE } from "./local-review.ts";
import type { Run } from "./ports/run.ts";
import { answersOf } from "./stop/decide.ts";
import type { LocalReviewAnswers } from "./stop/decide.ts";

const HEAD = "ac95210".padEnd(40, "0");

const REVIEW = {
  findings: [
    { file: "a.ts", line: 1, severity: "important", summary: "A.", failureScenario: "x" },
    { file: "b.ts", line: 2, severity: "nit", summary: "B.", failureScenario: "y" },
    { file: "c.ts", line: null, severity: "important", summary: "C.", failureScenario: "z" },
  ],
  model: null,
  tokens: null,
};

interface Checkout {
  readonly root: string;
  readonly run: Run;
}

/** A checkout at HEAD whose `.lab/state/` holds `files`, and a fake git that answers for it. */
function checkout(files: Readonly<Record<string, string>>): Checkout {
  const root = mkdtempSync(join(tmpdir(), "local-review-"));
  mkdirSync(join(root, ".lab", "state"), { recursive: true });

  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(root, ".lab", "state", name), text);
  }

  const run: Run = (argv) => {
    const line = argv.join(" ");

    const stdout =
      line === "git rev-parse --show-toplevel" ? `${root}\n` : line === "git rev-parse HEAD" ? `${HEAD}\n` : "";

    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };

  return { root, run };
}

const answersIn = (root: string): LocalReviewAnswers => {
  const file = join(root, ".lab", "state", `review-${HEAD}-answers.json`);

  return answersOf(file, readFileSync(file, "utf8"));
};

describe("local-review reject", () => {
  test("writes the rejection merged with the answers already there, and prints its line", async () => {
    const { root, run } = checkout({
      [`review-${HEAD}.json`]: JSON.stringify(REVIEW),
      [`review-${HEAD}-answers.json`]: JSON.stringify({ "1": "Rejected: first" }),
    });

    expect(await reject(["reject", "2", "the bound is inclusive"], run, root)).toEqual({
      code: 0,
      output: "rejected finding 2 of ac95210",
    });
    expect(answersIn(root)).toEqual({ "1": "Rejected: first", "2": "Rejected: the bound is inclusive" });
  });

  test("a first rejection creates the answers file", async () => {
    const { root, run } = checkout({ [`review-${HEAD}.json`]: JSON.stringify(REVIEW) });

    expect((await reject(["reject", "1", "kept"], run, root)).code).toBe(0);
    expect(answersIn(root)).toEqual({ "1": "Rejected: kept" });
  });

  test("a missing or unreadable review, a number with no Important, or an empty reason exits 1 with the usage line", async () => {
    const usage = { code: 1, output: USAGE } as const;
    const missing = checkout({});
    const unreadable = checkout({ [`review-${HEAD}.json`]: "{" });
    const readable = checkout({ [`review-${HEAD}.json`]: JSON.stringify(REVIEW) });

    expect(await reject(["reject", "1", "r"], missing.run, missing.root)).toEqual(usage);
    expect(await reject(["reject", "1", "r"], unreadable.run, unreadable.root)).toEqual(usage);
    expect(await reject(["reject", "3", "r"], readable.run, readable.root)).toEqual(usage);
    expect(await reject(["reject", "1", ""], readable.run, readable.root)).toEqual(usage);
    expect(USAGE).toBe(
      `usage: bun scripts/land-loop/local-review.ts reject <n> "<reason>"  (n: the finding's number in the Stop hook's block text)`,
    );
  });
});
