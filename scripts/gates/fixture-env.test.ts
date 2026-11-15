import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { fixtureEnv } from "./fixture-env.ts";

const created: string[] = [];

/** A new empty directory, removed once the tests end. */
function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));

  created.push(dir);

  return dir;
}

afterAll(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drops every GIT_ variable it is given, keeps the others, and tells git to sign no commit: a signing key can be out of reach, as in a Worker's sandbox", () => {
  expect(
    fixtureEnv({
      GIT_DIR: "/x",
      GIT_WORK_TREE: "/y",
      GIT_INDEX_FILE: "/z",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "tag.gpgsign",
      PATH: "/bin",
      HOME: undefined,
    }),
  ).toEqual({
    PATH: "/bin",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
  });
});

test("a fixture's git ignores an inherited GIT_DIR and stays in the fixture", async () => {
  const root = scratch("fixture-env-");
  const decoy = join(scratch("fixture-env-decoy-"), "repo.git");
  const env = fixtureEnv({ ...process.env, GIT_DIR: decoy });

  await $`git init -q`.cwd(root).env(env);

  expect(existsSync(join(root, ".git"))).toBe(true);
  expect(existsSync(decoy)).toBe(false);
  expect((await $`git rev-parse --show-toplevel`.cwd(root).env(env).text()).trim()).toBe(root);
});

test("without it, the same git init writes to the GIT_DIR it inherits", async () => {
  const root = scratch("fixture-env-");
  const decoy = join(scratch("fixture-env-decoy-"), "repo.git");

  await $`git init -q`.cwd(root).env({ ...fixtureEnv(process.env), GIT_DIR: decoy });

  expect(existsSync(decoy)).toBe(true);
  expect(existsSync(join(root, ".git"))).toBe(false);
});
