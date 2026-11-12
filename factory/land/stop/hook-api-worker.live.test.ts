import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { API_WORKER_ENV, HEAD, stopIn, UNFINISHED, world, writes } from "./stop.fixtures.ts";

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
      ],
    },
    network: { allowedDomains: ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org"] },
  },
  hooks: {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: `bun "${REPO}/factory/bin/fork-guard.ts"`, timeout: 30 }],
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
        "The Stop hook runs no Stop checks on an API Worker's head: your code runs in your sandbox alone, so they are yours to run. Run `bun check` in your worktree now, fix what it reports and commit, then stop.",
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
});
