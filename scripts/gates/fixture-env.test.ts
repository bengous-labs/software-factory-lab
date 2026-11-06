import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { fixtureEnv } from "./fixture-env.ts";

test("drops every GIT_ variable and keeps the others", () => {
  expect(
    fixtureEnv({ GIT_DIR: "/x", GIT_WORK_TREE: "/y", GIT_INDEX_FILE: "/z", PATH: "/bin", HOME: undefined }),
  ).toEqual({ PATH: "/bin" });
});

test("a fixture's git ignores an inherited GIT_DIR and stays in the fixture", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fixture-env-")));
  const decoy = join(mkdtempSync(join(tmpdir(), "fixture-env-decoy-")), "repo.git");
  const env = fixtureEnv({ ...process.env, GIT_DIR: decoy });

  await $`git init -q`.cwd(root).env(env);

  expect(existsSync(join(root, ".git"))).toBe(true);
  expect(existsSync(decoy)).toBe(false);
  expect((await $`git rev-parse --show-toplevel`.cwd(root).env(env).text()).trim()).toBe(root);
});

test("without it, the same git init writes to the GIT_DIR it inherits", async () => {
  const root = mkdtempSync(join(tmpdir(), "fixture-env-"));
  const decoy = join(mkdtempSync(join(tmpdir(), "fixture-env-decoy-")), "repo.git");

  await $`git init -q`.cwd(root).env({ ...fixtureEnv(process.env), GIT_DIR: decoy });

  expect(existsSync(decoy)).toBe(true);
  expect(existsSync(join(root, ".git"))).toBe(false);
});
