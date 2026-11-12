import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { $ } from "bun";
import { Schema } from "effect";

import { decodeJson } from "../../factory/lib/json.ts";
import { guardGlobsOf, ruleGlobsOf, scriptsNamedIn, silentBreaks } from "./check-silent-breaks.ts";
import type { Tree } from "./check-silent-breaks.ts";
import { fixtureEnv } from "./fixture-env.ts";

const ROOT = join(import.meta.dir, "..", "..");

const SCRIPT = join(import.meta.dir, "check-silent-breaks.ts");

const configOf = (ownerPaths: readonly string[], deepReviewPaths: readonly string[]): string =>
  JSON.stringify({ land: { routing: { ownerPaths, factoryPaths: ["src/**"], deepReviewPaths, lineCap: 400 } } });

/** A tree every name of which names a file. */
const SOUND: Tree = {
  files: ["src/a.ts", "src/a.test.ts", "tools/hook.ts", "docs/guide.md"],
  rules: { ".claude/rules/a.md": '---\npaths:\n  - "src/**"\n  - "tools/hook.ts"\n---\n\n# A rule\n' },
  naming: { ".claude/settings.json": 'bun "$CLAUDE_PROJECT_DIR"/tools/hook.ts' },
  mutated: { "src/a.ts": ["src/a.test.ts"] },
  logic: [],
  config: configOf(["docs/**"], ["src/a.ts"]),
};

describe("ruleGlobsOf", () => {
  test("reads the paths of a rule's header, and none from a rule that loads everywhere", () => {
    expect(ruleGlobsOf('---\npaths:\n  - "scripts/hooks/**"\n  - ".claude/settings.json"\n---\n\n# Hooks\n')).toEqual([
      "scripts/hooks/**",
      ".claude/settings.json",
    ]);
    expect(ruleGlobsOf("# A rule with no header\n\n---\n\nA line between two rules.\n")).toEqual([]);
    expect(ruleGlobsOf("---\ndescription: no paths\n---\n")).toEqual([]);
  });

  test("refuses a header whose paths are no list of strings", () => {
    expect(() => ruleGlobsOf("---\npaths: scripts/**\n---\n")).toThrow();
  });
});

describe("scriptsNamedIn", () => {
  test("finds the script of a hook's command, of a workflow's step and of a skill's permission, each once", () => {
    expect(scriptsNamedIn(String.raw`"command": "bun \"$CLAUDE_PROJECT_DIR\"/factory/hooks/role.ts"`)).toEqual([
      "factory/hooks/role.ts",
    ]);
    expect(
      scriptsNamedIn("run: bun scripts/ci/mutation.ts github-output\nrun: bun ./scripts/ci/mutation.ts run"),
    ).toEqual(["scripts/ci/mutation.ts"]);
    expect(scriptsNamedIn("allowed-tools: Bash(bun factory/bin/dispatch.ts:*)")).toEqual(["factory/bin/dispatch.ts"]);
    expect(scriptsNamedIn("# Runs the Merge bot (`.claude/plugins/land/hooks/land.tsx`)")).toEqual([
      ".claude/plugins/land/hooks/land.tsx",
    ]);
  });

  test("a command with no path, a file that is no TypeScript and a bare file name are no script", () => {
    expect(scriptsNamedIn("run: bun install --frozen-lockfile\nrun: bun check")).toEqual([]);
    expect(scriptsNamedIn("path: review-result.json\npaths: .github/workflows/ci.yml")).toEqual([]);
    expect(scriptsNamedIn("see decide.ts and main.ts")).toEqual([]);
  });
});

describe("guardGlobsOf", () => {
  test("reads the globs that send a change to the Owner or to a deep review, not the factory's own", () => {
    expect(guardGlobsOf(configOf([".github/**", "REVIEW.md"], ["app/src/store/**"]))).toEqual([
      ".github/**",
      "REVIEW.md",
      "app/src/store/**",
    ]);
  });

  test("refuses a config that does not read, naming the file", () => {
    expect(() => guardGlobsOf(JSON.stringify({ land: {} }))).toThrow(".github/software-factory.json");
  });
});

describe("silentBreaks", () => {
  test("a tree whose every name names a file has none", () => {
    expect(silentBreaks(SOUND)).toEqual([]);
  });

  test("a rule glob that matches no file is one, and names the rule and the glob", () => {
    const moved = { ...SOUND, files: SOUND.files.filter((file) => file !== "tools/hook.ts"), naming: {} };

    expect(silentBreaks(moved)).toEqual([
      ".claude/rules/a.md: the `paths` glob `tools/hook.ts` matches no file, so the rule loads for none.",
    ]);
  });

  test("a mutated module that does not exist is one, and so is its test file", () => {
    expect(silentBreaks({ ...SOUND, mutated: { "src/gone.ts": ["src/a.test.ts"] } })).toEqual([
      "stryker.config.ts: `src/gone.ts` does not exist, so its mutation pass would run nothing.",
    ]);
    expect(silentBreaks({ ...SOUND, mutated: { "src/a.ts": ["src/gone.test.ts"] } })).toEqual([
      "stryker.config.ts: `src/gone.test.ts` does not exist, so its mutation pass would run nothing.",
    ]);
  });

  test("a logic file the mutation job passes over is one", () => {
    expect(silentBreaks({ ...SOUND, logic: ["src/a.ts", "src/b.ts"] })).toEqual([
      "stryker.config.ts: `src/b.ts` has no `x.test.ts` in its directory, so the mutation job passes over it.",
    ]);
  });

  test("a test file two missing modules share is told once", () => {
    const mutated = { "src/a.ts": ["src/gone.test.ts"], "tools/hook.ts": ["src/gone.test.ts"] };

    expect(silentBreaks({ ...SOUND, mutated })).toHaveLength(1);
  });

  test("a script a hook, a workflow or a skill names that does not exist is one, and names where", () => {
    const naming = {
      ".claude/settings.json": 'bun "$CLAUDE_PROJECT_DIR"/tools/moved.ts',
      ".github/workflows/ci.yml": "run: bun tools/hook.ts",
    };

    expect(silentBreaks({ ...SOUND, naming })).toEqual([
      ".claude/settings.json: names `tools/moved.ts`, which does not exist.",
    ]);
  });

  test("an ownerPaths or deepReviewPaths glob that matches no file is one", () => {
    expect(silentBreaks({ ...SOUND, config: configOf(["docs/**", "old/**/*-prompt.ts"], ["src/store/**"]) })).toEqual([
      ".github/software-factory.json: the glob `old/**/*-prompt.ts` matches no file, so it guards nothing.",
      ".github/software-factory.json: the glob `src/store/**` matches no file, so it guards nothing.",
    ]);
  });
});

const Settings = Schema.Struct({
  hooks: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ hooks: Schema.Array(Schema.Struct({ command: Schema.String })) })),
  ),
});

test("every hook command of this repository's settings names one script, which the gate finds in the file's text", async () => {
  const text = await Bun.file(join(ROOT, ".claude", "settings.json")).text();

  const commands = Object.values(decodeJson(Settings, ".claude/settings.json", text).hooks).flatMap((entries) =>
    entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
  );

  expect(commands.length).toBeGreaterThan(0);

  for (const command of commands) {
    expect({ command, scripts: scriptsNamedIn(command).length }).toEqual({ command, scripts: 1 });
  }

  expect(new Set(scriptsNamedIn(text))).toEqual(new Set(commands.flatMap((command) => scriptsNamedIn(command))));
});

test("the gate passes on this repository", async () => {
  const ran = await $`bun ${SCRIPT}`.cwd(ROOT).env(fixtureEnv(process.env)).nothrow().quiet();

  expect({ exitCode: ran.exitCode, stderr: ran.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
});
