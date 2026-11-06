import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { findOffences, isCandidate } from "./check-lint-disables.ts";

const SCRIPT = join(import.meta.dir, "check-lint-disables.ts");

// Split so this file never carries a directive its own gate would refuse.
const OX = "ox";

const BARE = `// ${OX}lint-disable-next-line no-console`;

const JUSTIFIED = `${BARE} -- the reason`;

const ES = "es";

const BARE_ESLINT = `// ${ES}lint-disable no-console`;

describe("isCandidate", () => {
  test("accepts every linted extension", () => {
    for (const path of [
      "scripts/a.ts",
      "scripts/a.tsx",
      "scripts/a.mts",
      "scripts/a.cts",
      "scripts/a.js",
      "scripts/a.mjs",
      "scripts/a.cjs",
    ]) {
      expect(isCandidate(path)).toBe(true);
    }
  });

  test("rejects other extensions, node_modules and the vendored anti-slop copy", () => {
    for (const path of ["scripts/a.md", "scripts/a", "node_modules/a.js", "scripts/vendor/anti-slop/index.ts"]) {
      expect(isCandidate(path)).toBe(false);
    }
  });
});

describe("findOffences", () => {
  test("reports a directive with no reason, with its line", () => {
    expect(findOffences("a.ts", `const x = 1;\n${BARE}\n`)).toEqual([{ path: "a.ts", line: 2, text: BARE }]);
  });

  test("accepts a directive that says why", () => {
    expect(findOffences("a.ts", JUSTIFIED)).toEqual([]);
  });

  test("reports a directive whose only ` -- ` comes before it, as in a decrement", () => {
    const decrement = `let n = a -- b; ${BARE}`;

    expect(findOffences("a.ts", decrement)).toEqual([{ path: "a.ts", line: 1, text: decrement }]);
  });

  test("reports the eslint spelling too", () => {
    expect(findOffences("a.js", BARE_ESLINT)).toHaveLength(1);
  });
});

test("the gate fails on a working tree file whose suppression has no reason, and passes once it has one", async () => {
  const root = mkdtempSync(join(tmpdir(), "lint-disables-"));

  await $`git init -q`.cwd(root);
  writeFileSync(join(root, "a.ts"), `${JUSTIFIED}\nconst a = 1;\n`);
  writeFileSync(join(root, "b.ts"), `const b = 1;\n${BARE}\n`);

  const refused = await $`bun ${SCRIPT}`.cwd(root).nothrow().quiet();

  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain(`b.ts:2: ${BARE}`);
  expect(refused.stderr.toString()).not.toContain("a.ts");

  writeFileSync(join(root, "b.ts"), `const b = 1;\n${JUSTIFIED}\n`);

  expect((await $`bun ${SCRIPT}`.cwd(root).nothrow().quiet()).exitCode).toBe(0);
});
