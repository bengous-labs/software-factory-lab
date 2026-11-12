import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { fixtureEnv } from "./fixture-env.ts";

const SCRIPT = join(import.meta.dir, "check-lint-coverage.ts");

const FIXTURE_ENV = fixtureEnv(process.env);

test("the gate fails on tracked .ts and .js files a .gitignore or an .eslintignore covers, and passes once neither does", async () => {
  const root = mkdtempSync(join(tmpdir(), "lint-coverage-"));

  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "kept.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "leak.ts"), "export const b = 1;\n");
    writeFileSync(join(root, "notes.txt"), "an ignored file of another kind\n");
    writeFileSync(join(root, "src", "helper.js"), "export const c = 1;\n");
    writeFileSync(join(root, ".gitignore"), "leak.ts\nnotes.txt\n");
    writeFileSync(join(root, ".eslintignore"), "helper.js\n");
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
