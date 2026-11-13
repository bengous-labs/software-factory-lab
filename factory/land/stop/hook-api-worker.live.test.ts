import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { stop } from "./hook.live.ts";
import { API_WORKER_ENV, HEAD, input, stopIn, UNFINISHED, world, writes } from "./stop.fixtures.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..");

const API_FORK_SETTINGS = JSON.stringify({
  verbose: false,
  apiKeyHelper: "cat '/home/me/.api-agent/key'",
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    credentials: {
      files: [
        { path: "/home/me/.api-agent", mode: "deny" },
        { path: "/home/me/.config/software-factory-lab", mode: "deny" },
        { path: REPO, mode: "deny" },
      ],
    },
    network: { allowedDomains: ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org"] },
  },
  hooks: {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: `cd "${REPO}" && bun "${REPO}/factory/bin/fork-guard.ts"`, timeout: 30 }],
      },
    ],
  },
});

describe("the stop of an API Worker", () => {
  test("blocks once, leaving the Stop checks to it, and runs none of its code", async () => {
    const found = world({ env: API_WORKER_ENV });

    expect(await stopIn(found)).toEqual({
      kind: "block",
      reason:
        "The Stop hook runs no Stop checks on an API Worker's head: your code runs in your sandbox alone, so they are yours to run. Run `bun check` in your clone now, fix what it reports and commit, then stop.",
    });
    expect(found.calls.some((call) => call.argv[0] === "bun" || call.argv[0] === "claude")).toBe(false);
    expect(writes(found.calls)).toEqual([]);
    expect(found.outcomes[0]?.line).toMatchObject({
      api: true,
      outcome: "not-published",
      reason: `the Stop checks on ${HEAD} are left to the API Worker`,
    });
  });

  test("its next stop publishes: its forks bill the key in its sandbox and load no other settings, its relay gets what a headless resume needs, and still no Stop checks run", async () => {
    const found = world({ env: API_WORKER_ENV });

    await stopIn(found);
    const before = found.calls.length;

    expect(await stopIn(found, true)).toEqual({ kind: "allow" });

    const calls = found.calls.slice(before);
    const forks = calls.filter((call) => call.argv[0] === "claude");

    expect(calls.some((call) => call.argv[0] === "bun")).toBe(false);
    expect(forks.map((call) => call.argv.slice(9, 13))).toEqual([
      ["--settings", API_FORK_SETTINGS, "--setting-sources", ""],
      ["--settings", API_FORK_SETTINGS, "--setting-sources", ""],
    ]);
    expect(found.relays).toEqual([
      {
        pr: 12,
        session: "S1",
        headless: { model: "claude-haiku-5-5", worktree: found.root },
        checkout: found.checkout,
      },
    ]);
    expect(found.outcomes.at(-1)?.line).toMatchObject({ api: true, outcome: "published", pr: 12 });
    expect(found.records).toContainEqual({ step: "stop-checks", checks: "left", next: "ask-done-judge" });
  });

  test("a later stop of an API Worker on a head it was asked about is not asked again", async () => {
    const found = world({ env: API_WORKER_ENV, done: [UNFINISHED] });

    await stopIn(found);
    await stopIn(found, true);

    const again = world({ env: API_WORKER_ENV, done: [UNFINISHED], checkout: found.checkout });

    expect(await stopIn(again)).toEqual({ kind: "allow" });
    expect(again.calls.some((call) => call.argv[0] === "claude")).toBe(true);
    expect(again.calls.some((call) => call.argv[0] === "bun")).toBe(false);

    const moved = world({ env: API_WORKER_ENV, checkout: found.checkout, head: "e".repeat(40) });

    expect(await stopIn(moved)).toMatchObject({ kind: "block" });
  });

  test("the hook lets git find nothing from the clone: git runs in the main checkout, handed the clone through its environment, and gh runs there too", async () => {
    const found = world({ env: API_WORKER_ENV });

    await stopIn(found);
    await stopIn(found, true);

    const pinned = {
      GIT_DIR: join(found.root, ".git"),
      GIT_COMMON_DIR: join(found.root, ".git"),
      GIT_WORK_TREE: found.root,
    };

    expect(found.root).toBe("/home/me/.local/share/software-factory-lab/api-workers/x");

    const gits = found.calls.filter((call) => call.argv[0] === "git");
    const ghs = found.calls.filter((call) => call.argv[0] === "gh");

    expect(gits.length).toBeGreaterThan(5);
    expect(ghs.length).toBeGreaterThan(2);

    for (const call of gits) {
      expect({ argv: call.argv.slice(0, 2), cwd: call.options.cwd, env: call.options.env }).toMatchObject({
        cwd: found.checkout,
        env: pinned,
      });
    }

    for (const call of ghs) {
      expect(call.options.cwd).toBe(found.checkout);
    }

    expect(gits.some((call) => call.argv.includes("--show-toplevel") || call.argv.includes("--git-common-dir"))).toBe(
      false,
    );
  });

  test("its push keeps the pinned environment beside the Author's token, and its status and its fetch enter no submodule", async () => {
    const found = world({ env: API_WORKER_ENV });

    await stopIn(found);
    await stopIn(found, true);

    const push = found.calls.find((call) => call.argv.includes("push"));

    expect(push?.options.cwd).toBe(found.checkout);
    expect(push?.options.env).toEqual({
      GIT_DIR: join(found.root, ".git"),
      GIT_COMMON_DIR: join(found.root, ".git"),
      GIT_WORK_TREE: found.root,
      LAB_AUTHOR_TOKEN: "t0k",
    });
    expect(found.calls.map((call) => call.argv.join(" "))).toContain("git status --porcelain --ignore-submodules=all");
    expect(found.calls.map((call) => call.argv.join(" "))).toContain(
      "git fetch --quiet --no-recurse-submodules origin dev",
    );
  });

  test("it writes nothing in the clone, where a file can be a link to any file of the Owner's: its state lies in the main checkout", async () => {
    const found = world({ env: API_WORKER_ENV });

    await stopIn(found);
    await stopIn(found, true);

    expect(existsSync(join(found.root, ".lab"))).toBe(false);
    expect(existsSync(join(found.checkout, ".lab", "state", `gates-${HEAD}`))).toBe(true);
  });

  test("its forks still run in the clone, as sessions the sandbox holds", async () => {
    const found = world({ env: API_WORKER_ENV });

    await stopIn(found);
    await stopIn(found, true);

    const forks = found.calls.filter((call) => call.argv[0] === "claude");

    expect(forks.map((call) => call.options.cwd)).toEqual([found.root, found.root]);
  });

  test("a stop in a subdirectory of the clone is the clone's", async () => {
    const found = world({ env: API_WORKER_ENV });

    expect(await stop(input(join(found.root, "factory", "land")), found.deps, found.log)).toMatchObject({
      kind: "block",
    });
    expect(found.outcomes[0]?.line).toMatchObject({ worktree: found.root, branch: "agent/x" });
  });

  test("a stop outside the clones, the main checkout among them, runs no git, publishes nothing and says why", async () => {
    const found = world({ env: API_WORKER_ENV, mainCheckout: true });

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(found.calls).toEqual([]);
    expect(found.outcomes[0]?.line).toMatchObject({
      api: true,
      outcome: "not-published",
      reason: `the stop of an API Worker comes from ${found.root}, which lies in no clone of /home/me/.local/share/software-factory-lab/api-workers`,
    });
  });

  test("another Author's stop runs git and gh in its own directory, with no pinned environment", async () => {
    const found = world();

    await stopIn(found);

    const gits = found.calls.filter((call) => call.argv[0] === "git" && !call.argv.includes("push"));

    expect(gits.length).toBeGreaterThan(5);
    expect(gits.every((call) => call.options.cwd === found.root && call.options.env === undefined)).toBe(true);
    expect(existsSync(join(found.root, ".lab", "state"))).toBe(true);
  });
});
