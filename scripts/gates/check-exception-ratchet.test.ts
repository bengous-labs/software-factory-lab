import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXCEPTIONS } from "../lint/exceptions.ts";
import type { Exception } from "../lint/exceptions.ts";
import { breachesOf, lintBudgets, ratchetErrors } from "./check-exception-ratchet.ts";
import type { Breach } from "./check-exception-ratchet.ts";

const WIDE: Exception = { file: "a.ts", rule: "eslint/max-params", name: "wide", measured: 5 };

const breach = (name: string | null, value = 5, line = 1): Breach => ({
  file: "a.ts",
  line,
  rule: "eslint/max-params",
  name,
  value,
});

describe("ratchetErrors", () => {
  test("passes when the listed functions are exactly the ones that break their rule, at their measure", () => {
    expect(ratchetErrors([WIDE], [breach("wide")])).toEqual([]);
  });

  test("fails on a listed function that no longer breaks its rule", () => {
    expect(ratchetErrors([WIDE], [])).toEqual([
      "a.ts: `wide` no longer breaks eslint/max-params; remove its entry from scripts/lint/exceptions.ts.",
    ]);
  });

  test("fails on a listed function that got worse, and on one that got better without its entry", () => {
    expect(ratchetErrors([WIDE], [breach("wide", 7)])).toEqual([
      "a.ts:1: `wide` measures 7 on eslint/max-params, over the 5 its exception records. Bring it back to 5 or below; the exception never grows.",
    ]);
    expect(ratchetErrors([{ ...WIDE, measured: 8 }], [breach("wide", 6)])).toEqual([
      "a.ts:1: `wide` measures 6 on eslint/max-params, under the 8 its exception records; lower `measured` to 6 in scripts/lint/exceptions.ts.",
    ]);
  });

  test("fails on a function of an excepted file that breaks the rule unlisted, named or not", () => {
    expect(ratchetErrors([WIDE], [breach("wide"), breach("wider", 5, 4), breach(null, 5, 9)])).toEqual([
      "a.ts:4: `wider` breaks eslint/max-params, which the file's exception hides from the lint. Fix the function; the list of exceptions only shrinks.",
      "a.ts:9: a function the rule cannot name breaks eslint/max-params, which the file's exception hides from the lint. Fix the function; the list of exceptions only shrinks.",
    ]);
  });

  test("lets no entry cover two functions of the same name", () => {
    expect(ratchetErrors([WIDE], [breach("wide", 5, 1), breach("wide", 5, 7)])).toHaveLength(2);
  });

  test("leaves a breach of a rule or a file no exception covers, which the lint reports itself", () => {
    expect(
      ratchetErrors(
        [WIDE],
        [breach("wide"), { ...breach("deep", 30), rule: "complexity/complexity" }, { ...breach("x"), file: "b.ts" }],
      ),
    ).toEqual([]);
  });
});

const LABELS = [{ span: { line: 3 } }];

const diagnostic = (code: string, message: string) => ({ code, message, filename: "a.ts", labels: LABELS });

describe("breachesOf", () => {
  test("reads the rule, the function and its measure of each message shape", () => {
    const report = JSON.stringify({
      diagnostics: [
        diagnostic("eslint(max-params)", "Function 'wide' has too many parameters (5). Maximum allowed is 4."),
        diagnostic("eslint(max-params)", "Function has too many parameters (6). Maximum allowed is 4."),
        diagnostic("eslint(max-params)", "Arrow function has too many parameters (7). Maximum allowed is 4."),
        diagnostic("complexity(complexity)", "Function 'deep' has Cognitive Complexity of 30. Maximum allowed is 25."),
        diagnostic(
          "complexity(complexity)",
          "Function '<arrow>' has Cognitive Complexity of 31. Maximum allowed is 25.",
        ),
      ],
    });

    expect(breachesOf(report)).toEqual([
      { file: "a.ts", line: 3, rule: "eslint/max-params", name: "wide", value: 5 },
      { file: "a.ts", line: 3, rule: "eslint/max-params", name: null, value: 6 },
      { file: "a.ts", line: 3, rule: "eslint/max-params", name: null, value: 7 },
      { file: "a.ts", line: 3, rule: "complexity/complexity", name: "deep", value: 30 },
      { file: "a.ts", line: 3, rule: "complexity/complexity", name: null, value: 31 },
    ]);
  });

  test("throws on a diagnostic it cannot read, such as a syntax error, rather than guess", () => {
    expect(() =>
      breachesOf(JSON.stringify({ diagnostics: [{ message: "Unexpected token", filename: "a.ts", labels: LABELS }] })),
    ).toThrow("a.ts:3: oxlint reported what the ratchet cannot read: Unexpected token");
    expect(() =>
      breachesOf(JSON.stringify({ diagnostics: [diagnostic("eslint(max-params)", "Something else")] })),
    ).toThrow("cannot read");
  });
});

const PARAMS = "a: number, b: number, c: number, d: number, e: number";

/** A body of cognitive complexity 35, over 20 lines: the complexity plugin reports nothing for it on one line. */
const DEEP = [
  "{",
  "  let total = 0;",
  "  for (const value of values) {",
  "    if (value > 1 && total < 100) {",
  "      for (const other of values) {",
  "        if (other > value || other < 0) {",
  "          total += other > 50 ? 2 : 1;",
  "        } else if (other === value) {",
  "          total -= 1;",
  "        }",
  "        for (const third of values) {",
  "          if (third > other && (third < 10 || third > 90)) {",
  "            total += third > 50 ? 3 : 4;",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "  return total;",
  "}",
].join("\n");

/** A function in each shape the rules name differently, one per line up to the multi-line bodies. */
const FUNCTIONS = [
  `export function plain(${PARAMS}): number { return a + b + c + d + e; }`,
  `export async function perform(${PARAMS}): Promise<number> { return a + b + c + d + e; }`,
  `export function* generated(${PARAMS}): Generator<number> { yield a + b + c + d + e; }`,
  `export const arrow = (${PARAMS}): number => a + b + c + d + e;`,
  `export const expression = function (${PARAMS}): number { return a + b + c + d + e; };`,
  `export const named = function inner(${PARAMS}): number { return a + b + c + d + e; };`,
  `export class K { method(${PARAMS}): number { return a + b + c + d + e; } }`,
  `export function deep(values: readonly number[]): number ${DEEP}`,
  `export const deepArrow = (values: readonly number[]): number => ${DEEP};`,
  `export const callbacks = [[1]].map((values) => ${DEEP});`,
  `export class L { deepMethod(values: readonly number[]): number ${DEEP} }`,
].join("\n");

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "exception-ratchet-"));
  writeFileSync(join(root, "a.ts"), FUNCTIONS);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("reads the name oxlint gives each shape of function, and none for those it does not name", async () => {
  const found = (await lintBudgets(root, ["a.ts"])).map(({ line, rule, name, value }) => ({
    line,
    rule,
    name,
    value,
  }));

  expect(found.toSorted((x, y) => x.line - y.line)).toEqual([
    { line: 1, rule: "eslint/max-params", name: "plain", value: 5 },
    { line: 2, rule: "eslint/max-params", name: "perform", value: 5 },
    { line: 3, rule: "eslint/max-params", name: "generated", value: 5 },
    { line: 4, rule: "eslint/max-params", name: null, value: 5 },
    { line: 5, rule: "eslint/max-params", name: null, value: 5 },
    { line: 6, rule: "eslint/max-params", name: "inner", value: 5 },
    { line: 7, rule: "eslint/max-params", name: null, value: 5 },
    { line: 8, rule: "complexity/complexity", name: "deep", value: 35 },
    { line: 28, rule: "complexity/complexity", name: "deepArrow", value: 35 },
    { line: 48, rule: "complexity/complexity", name: null, value: 35 },
    { line: 68, rule: "complexity/complexity", name: "deepMethod", value: 35 },
  ]);
});

test("refuses a listed file that does not exist, and lints nothing for an empty list", async () => {
  const refused = await lintBudgets(root, ["gone.ts"]).then(() => "", String);

  expect(refused).toContain("lists files that do not exist: gone.ts");
  expect(await lintBudgets(root, [])).toEqual([]);
});

test("the repository's exceptions match what the budget rules report, the async perform included", async () => {
  const repo = join(import.meta.dir, "..", "..");
  const breaches = await lintBudgets(repo, [...new Set(EXCEPTIONS.map((exception) => exception.file))]);

  expect(breaches.find((found) => found.name === "perform")).toMatchObject({ rule: "eslint/max-params", value: 7 });
  expect(ratchetErrors(EXCEPTIONS, breaches)).toEqual([]);
});
