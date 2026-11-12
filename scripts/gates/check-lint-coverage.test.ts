import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { fixtureEnv } from "./fixture-env.ts";

const SCRIPT = join(import.meta.dir, "check-lint-coverage.ts");

const FIXTURE_ENV = fixtureEnv(process.env);

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

test("the gate fails on a tracked source a pattern of the lint config hides, but the vendored rules and the mods, which a .gitignore still may not hide", async () => {
  const root = mkdtempSync(join(tmpdir(), "lint-coverage-"));
  const gate = join(root, "scripts", "gates", "check-lint-coverage.ts");

  const write = (path: string, text: string): void => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  try {
    write("scripts/gates/check-lint-coverage.ts", await Bun.file(SCRIPT).text());
    write(
      "oxlint.style.config.ts",
      'export const IGNORE_PATTERNS = ["scripts/vendor/anti-slop/**", ".claude/plugins/**", "factory/land/queue/**"];\n',
    );
    write("factory/land/queue/queue.ts", "Bun.spawnSync(['true']);\n");
    write("scripts/vendor/anti-slop/index.ts", "export const a = 1;\n");
    write(".claude/plugins/land/hooks/land.tsx", "export const b = 1;\n");
    await $`git init -q && git add -A`.cwd(root).env(FIXTURE_ENV);

    const refused = await $`bun ${gate}`.cwd(root).env(FIXTURE_ENV).nothrow().quiet();

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toBe(
      "1 tracked source file(s) an ignore rule hides from the lint:\n\n  factory/land/queue/queue.ts\n\nNarrow the ignore rule that covers each, or stop tracking the file.\n",
    );

    write("oxlint.style.config.ts", 'export const IGNORE_PATTERNS = [".claude/plugins/**"];\n');
    write(".gitignore", "land.tsx\n");

    const hiddenMod = await $`bun ${gate}`.cwd(root).env(FIXTURE_ENV).nothrow().quiet();

    expect(hiddenMod.exitCode).toBe(1);
    expect(hiddenMod.stderr.toString()).toContain("  .claude/plugins/land/hooks/land.tsx\n");

    write(".gitignore", "");
    write("oxlint.style.config.ts", "export const IGNORE_PATTERNS = [];\n");

    expect((await $`bun ${gate}`.cwd(root).env(FIXTURE_ENV).nothrow().quiet()).exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
