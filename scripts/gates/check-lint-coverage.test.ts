import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { fixtureEnv } from "./fixture-env.ts";

const SCRIPT = join(import.meta.dir, "check-lint-coverage.ts");

const FIXTURE_ENV = fixtureEnv(process.env);

/** A lint config that ignores `patterns`. */
function ignoring(patterns: readonly string[]): string {
  return `export default { ignorePatterns: ${JSON.stringify(patterns)} };\n`;
}

test("the gate fails on tracked .ts and .js files a .gitignore or an .eslintignore covers, a negation of the other notwithstanding, and passes once neither does", async () => {
  const root = mkdtempSync(join(tmpdir(), "lint-coverage-"));

  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "kept.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "leak.ts"), "export const b = 1;\n");
    writeFileSync(join(root, "notes.txt"), "an ignored file of another kind\n");
    writeFileSync(join(root, "src", "helper.js"), "export const c = 1;\n");
    writeFileSync(join(root, ".gitignore"), "leak.ts\nnotes.txt\n");
    writeFileSync(join(root, ".eslintignore"), "helper.js\n!src/leak.ts\n");
    await $`git init -q && git add -A && git add -f src/leak.ts notes.txt`.cwd(root).env(FIXTURE_ENV);

    const refused = await $`bun ${SCRIPT}`.cwd(root).env(FIXTURE_ENV).nothrow().quiet();

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toBe(
      "2 tracked source file(s) an ignore rule hides from the lint:\n\n  src/helper.js\n  src/leak.ts\n\nNarrow the ignore rule that covers each, or stop tracking the file.\n",
    );

    writeFileSync(join(root, ".gitignore"), "notes.txt\n");
    writeFileSync(join(root, ".eslintignore"), "");

    expect((await $`bun ${SCRIPT}`.cwd(root).env(FIXTURE_ENV).nothrow().quiet()).exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** What the gate prints of the tracked sources `paths` it refuses. */
function refusal(paths: readonly string[]): string {
  return `${paths.length} tracked source file(s) an ignore rule hides from the lint:\n\n${paths.map((path) => `  ${path}\n`).join("")}\nNarrow the ignore rule that covers each, or stop tracking the file.\n`;
}

test("the gate fails on a tracked source a pattern of the main lint config hides, but the vendored rules and the mods, which no other rule may hide, and on any pattern of the layers config", async () => {
  const root = mkdtempSync(join(tmpdir(), "lint-coverage-"));
  const gate = join(root, "scripts", "gates", "check-lint-coverage.ts");

  const write = (path: string, text: string): void => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  const run = async (): Promise<{ exitCode: number; stderr: string }> => {
    const result = await $`bun ${gate}`.cwd(root).env(FIXTURE_ENV).nothrow().quiet();

    return { exitCode: result.exitCode, stderr: result.stderr.toString() };
  };

  const LEFT_OUT = ["scripts/vendor/anti-slop/**", ".claude/plugins/**"];

  try {
    write("scripts/gates/check-lint-coverage.ts", await Bun.file(SCRIPT).text());
    write("scripts/lint/layers.oxlint.config.ts", "export default {};\n");
    write("oxlint.config.ts", ignoring([...LEFT_OUT, "factory/land/queue/**", "**/*.tsx"]));
    write("factory/land/queue/queue.ts", "Bun.spawnSync(['true']);\n");
    write("scripts/vendor/anti-slop/index.ts", "export const a = 1;\n");
    write(".claude/plugins/land/hooks/land.tsx", "export const b = 1;\n");
    await $`git init -q && git add -A`.cwd(root).env(FIXTURE_ENV);

    expect(await run()).toEqual({ exitCode: 1, stderr: refusal(["factory/land/queue/queue.ts"]) });

    write("oxlint.config.ts", ignoring(LEFT_OUT));
    write(".gitignore", "land.tsx\nindex.ts\n");

    expect(await run()).toEqual({
      exitCode: 1,
      stderr: refusal([".claude/plugins/land/hooks/land.tsx", "scripts/vendor/anti-slop/index.ts"]),
    });

    write(".gitignore", "");
    write("oxlint.config.ts", ignoring([...LEFT_OUT, "factory/land/queue/**"]));
    write("scripts/lint/layers.oxlint.config.ts", ignoring(["land.tsx"]));

    expect(await run()).toEqual({
      exitCode: 1,
      stderr: `scripts/lint/layers.oxlint.config.ts ignores land.tsx: it lints every mod.\n\n${refusal(["factory/land/queue/queue.ts"])}`,
    });

    write("oxlint.config.ts", ignoring(LEFT_OUT));
    write("scripts/lint/layers.oxlint.config.ts", "export default {};\n");

    expect((await run()).exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
