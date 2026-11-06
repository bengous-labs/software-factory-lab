import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { filesOf, uncovered } from "./check-typecheck-coverage.ts";

const SCRIPT = join(import.meta.dir, "check-typecheck-coverage.ts");

describe("uncovered", () => {
  test("a tracked file the config's files leave out is uncovered, a ./ prefix notwithstanding", () => {
    const tracked = ["scripts/a.ts", ".claude/hooks/b.ts", ".github/c.ts"];

    expect(uncovered("/repo", tracked, ["scripts/a.ts", "./.claude/hooks/b.ts"])).toEqual([".github/c.ts"]);
  });

  test("the vendored anti-slop copy is left out on purpose", () => {
    expect(uncovered("/repo", ["scripts/vendor/anti-slop/index.ts", "scripts/vendor/x.ts"], [])).toEqual([
      "scripts/vendor/x.ts",
    ]);
  });
});

describe("filesOf", () => {
  test("reads the files list, and refuses an answer without one", () => {
    expect(filesOf(JSON.stringify({ compilerOptions: {}, files: ["./a.ts"] }))).toEqual(["./a.ts"]);
    expect(() => filesOf(JSON.stringify({ compilerOptions: {} }))).toThrow(
      'tsgo --showConfig: Missing key\n  at ["files"]',
    );
    expect(() => filesOf(JSON.stringify({ files: ["./a.ts", 7] }))).toThrow(
      'Expected string, got 7\n  at ["files"][1]',
    );
  });
});

test("the gate fails on tracked .ts and .mts files outside tsconfig.json's include, and passes once include names them", async () => {
  const root = mkdtempSync(join(tmpdir(), "typecheck-coverage-"));

  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "tools", "b.ts"), "export const b = 1;\n");
  writeFileSync(join(root, "tools", "c.mts"), "export const c = 1;\n");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
  await $`git init -q && git add -A`.cwd(root);

  const refused = await $`bun ${SCRIPT}`.cwd(root).nothrow().quiet();

  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain("2 tracked TypeScript file(s) outside the typecheck");
  expect(refused.stderr.toString()).toContain("tools/b.ts");
  expect(refused.stderr.toString()).toContain("tools/c.mts");

  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ include: ["src/**/*.ts", "tools/**/*.ts", "tools/**/*.mts"] }),
  );

  expect((await $`bun ${SCRIPT}`.cwd(root).nothrow().quiet()).exitCode).toBe(0);
});
