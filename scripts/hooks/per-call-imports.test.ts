import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOOKS = import.meta.dir;

/** The tool-call hooks of `.claude/settings.json` that fire on one rare tool, so may load any package. */
const RARE_TOOL_HOOKS = new Set(["install-deps.ts"]);

/** The part of `.claude/settings.json` this test reads. */
interface Settings {
  readonly hooks: Readonly<
    Record<"PreToolUse" | "PostToolUse", ReadonlyArray<{ readonly hooks: ReadonlyArray<{ readonly command: string }> }>>
  >;
}

/**
 * The hooks that run on tool calls, each package they load adding start-up time to the call: every
 * PreToolUse and PostToolUse hook of `.claude/settings.json` but those of `RARE_TOOL_HOOKS`.
 */
async function perCallHooks(): Promise<readonly string[]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the repository's own settings file, whose shape Claude Code defines.
  const settings = (await Bun.file(join(HOOKS, "..", "..", ".claude", "settings.json")).json()) as Settings;
  const entries = [...settings.hooks.PreToolUse, ...settings.hooks.PostToolUse];

  return entries
    .flatMap((entry) =>
      entry.hooks.map(
        (hook) => /scripts\/hooks\/(?<file>[\w-]+\.ts)/u.exec(hook.command)?.groups?.["file"] ?? hook.command,
      ),
    )
    .filter((file) => !RARE_TOOL_HOOKS.has(file));
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** The packages `file` loads, directly or through the repository files it imports; type-only imports load nothing. */
async function packagesOf(file: string, seen = new Set<string>()): Promise<ReadonlySet<string>> {
  const packages = new Set<string>();

  if (seen.has(file)) {
    return packages;
  }

  seen.add(file);

  const source = (await Bun.file(file).text()).replace(/^#!.*/u, "");

  for (const { path } of transpiler.scanImports(source)) {
    if (path.startsWith(".")) {
      for (const name of await packagesOf(resolve(dirname(file), path), seen)) {
        packages.add(name);
      }
    } else {
      packages.add(path);
    }
  }

  return packages;
}

describe("the per-call hooks", () => {
  test("are the ones .claude/settings.json wires on tool calls", async () => {
    expect(await perCallHooks()).toEqual(["refuse-commit-on-dev.ts", "refuse-author-publish.ts", "fix-edited.ts"]);
  });

  test("load only bun and node: modules, never effect", async () => {
    for (const hook of await perCallHooks()) {
      const packages = [...(await packagesOf(join(HOOKS, hook)))];

      expect({ hook, packages: packages.filter((name) => name !== "bun" && !name.startsWith("node:")) }).toEqual({
        hook,
        packages: [],
      });
    }
  });

  test("the check follows relative imports, and skips type-only ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "per-call-imports-"));

    try {
      await writeFile(join(dir, "lib.ts"), 'import { Schema } from "effect";\nexport const s = Schema.String;\n');
      await writeFile(join(dir, "types.ts"), 'import { z } from "zod";\nexport type T = typeof z;\n');
      await writeFile(
        join(dir, "hook.ts"),
        '#!/usr/bin/env bun\nimport type { T } from "./types.ts";\nimport { s } from "./lib.ts";\nexport const x: T | typeof s = s;\n',
      );

      expect([...(await packagesOf(join(dir, "hook.ts")))]).toEqual(["effect"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
