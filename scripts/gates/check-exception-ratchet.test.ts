import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Exception } from "../lint/exceptions.ts";
import { breachesOf, lintBudgets, ratchetErrors } from "./check-exception-ratchet.ts";
import type { Breach } from "./check-exception-ratchet.ts";

const WIDE: Exception = { file: "a.ts", rule: "eslint/max-params", name: "wide" };

const breach = (name: string, file = "a.ts", rule = "eslint/max-params"): Breach => ({ file, rule, name });

describe("ratchetErrors", () => {
  test("passes when the listed functions are exactly the ones that break their rule", () => {
    expect(ratchetErrors([WIDE], [breach("wide")])).toEqual([]);
  });

  test("fails on a listed function that no longer breaks its rule", () => {
    expect(ratchetErrors([WIDE], [])).toEqual([
      "a.ts: `wide` no longer breaks eslint/max-params; remove its entry from scripts/lint/exceptions.ts.",
    ]);
  });

  test("fails on a function of an excepted file that breaks the rule unlisted", () => {
    expect(ratchetErrors([WIDE], [breach("wide"), breach("wider")])).toEqual([
      "a.ts: `wider` breaks eslint/max-params, which the file's exception hides from the lint. Fix the function; the list of exceptions only shrinks.",
    ]);
  });

  test("leaves a breach of a rule or a file no exception covers, which the lint reports itself", () => {
    expect(
      ratchetErrors([WIDE], [breach("wide"), breach("deep", "a.ts", "complexity/complexity"), breach("x", "b.ts")]),
    ).toEqual([]);
  });
});

describe("breachesOf", () => {
  test("reads the file, the rule in the config's spelling and the function of each diagnostic", () => {
    const report = JSON.stringify({
      diagnostics: [
        {
          code: "eslint(max-params)",
          message: "Function 'wide' has too many parameters (5). Maximum allowed is 4.",
          filename: "a.ts",
        },
        {
          code: "complexity(complexity)",
          message: "Function 'deep' has Cognitive Complexity of 30.",
          filename: "b.ts",
        },
      ],
    });

    expect(breachesOf(report)).toEqual([breach("wide"), breach("deep", "b.ts", "complexity/complexity")]);
  });
});

const NESTED_IFS = Array.from({ length: 9 }, (_, depth) => `${"  ".repeat(depth + 1)}if (n > ${depth}) {`).join("\n");

const FIXTURE = [
  "export function wide(a: number, b: number, c: number, d: number, e: number): number {",
  "  return a + b + c + d + e;",
  "}",
  "export function narrow(a: number, b: number, c: number, d: number): number {",
  "  return a + b + c + d;",
  "}",
  "export function deep(n: number): number {",
  NESTED_IFS,
  "    return n;",
  "  }".repeat(9),
  "  return 0;",
  "}",
].join("\n");

test("lints a fixture with the budget rules and reads each function that breaks one", async () => {
  const root = mkdtempSync(join(tmpdir(), "exception-ratchet-"));

  writeFileSync(join(root, "a.ts"), FIXTURE);

  const breaches = await lintBudgets(root, ["a.ts"]);

  expect(breaches.map((found) => `${found.rule} ${found.name}`).toSorted()).toEqual([
    "complexity/complexity deep",
    "eslint/max-params wide",
  ]);
  expect(ratchetErrors([WIDE], breaches)).toEqual([]);
  expect(ratchetErrors([WIDE, { file: "a.ts", rule: "eslint/max-params", name: "narrow" }], breaches)).toEqual([
    "a.ts: `narrow` no longer breaks eslint/max-params; remove its entry from scripts/lint/exceptions.ts.",
  ]);
});
