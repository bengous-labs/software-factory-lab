/**
 * The guards of a session are wired, and fail closed: a guard that cannot start, throws or times out
 * blocks the call it guards, instead of letting it through.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";

import { decodeJson } from "../lib/json.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** The guards: each refuses what an agent must not do, so each must run before every Bash call. */
const GUARDS = ["factory/hooks/refuse-commit-on-dev.ts", "factory/hooks/refuse-author-publish.ts"];

const Hook = Schema.Struct({
  type: Schema.String,
  command: Schema.String,
  timeout: Schema.optionalKey(Schema.Number),
  onFailure: Schema.optionalKey(Schema.String),
  async: Schema.optionalKey(Schema.Boolean),
});

/** `.claude/settings.json`, as far as this test reads it. */
const Settings = Schema.Struct({
  disableAllHooks: Schema.optionalKey(Schema.Boolean),
  hooks: Schema.Struct({
    PreToolUse: Schema.Array(Schema.Struct({ matcher: Schema.String, hooks: Schema.Array(Hook) })),
  }),
});

async function settings(): Promise<typeof Settings.Type> {
  return decodeJson(Settings, ".claude/settings.json", await Bun.file(join(ROOT, ".claude", "settings.json")).text());
}

async function bashHooks(): Promise<ReadonlyArray<typeof Hook.Type>> {
  return (await settings()).hooks.PreToolUse.flatMap((entry) => (entry.matcher === "Bash" ? entry.hooks : []));
}

describe("the guards of a session", () => {
  test("each guard is wired before every Bash call, from the checkout the session started in", async () => {
    const commands = (await bashHooks()).map((hook) => hook.command);

    expect(commands).toEqual(GUARDS.map((guard) => `bun "$CLAUDE_PROJECT_DIR"/${guard}`));
  });

  test("each guard blocks the call when it fails itself", async () => {
    for (const hook of await bashHooks()) {
      expect({ command: hook.command, type: hook.type, onFailure: hook.onFailure }).toEqual({
        command: hook.command,
        type: "command",
        onFailure: "block",
      });
    }
  });

  test("no guard runs in the background, where it could block nothing, and no setting switches the hooks off", async () => {
    expect((await settings()).disableAllHooks ?? false).toBe(false);

    for (const hook of await bashHooks()) {
      expect({ command: hook.command, async: hook.async ?? false }).toEqual({ command: hook.command, async: false });
    }
  });

  test("each guard's file exists, and so does the guard the Stop hook gives its forks", () => {
    for (const file of [...GUARDS, "factory/bin/fork-guard.ts"]) {
      expect({ file, exists: existsSync(join(ROOT, file)) }).toEqual({ file, exists: true });
    }
  });
});
