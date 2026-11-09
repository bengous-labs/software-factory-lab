import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOOKS = import.meta.dir;

/** The hooks that run on every tool call, where each package loaded adds start-up time to the call. */
const PER_CALL_HOOKS = ["refuse-commit-on-dev.ts", "fix-edited.ts"];

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
  test.each(PER_CALL_HOOKS)("%s loads only bun and node: modules, never effect", async (hook) => {
    const packages = [...(await packagesOf(join(HOOKS, hook)))];

    expect(packages.filter((name) => name !== "bun" && !name.startsWith("node:"))).toEqual([]);
  });

  test("the check follows relative imports, and skips type-only ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "per-call-imports-"));

    await writeFile(join(dir, "lib.ts"), 'import { Schema } from "effect";\nexport const s = Schema.String;\n');
    await writeFile(join(dir, "types.ts"), 'import { z } from "zod";\nexport type T = typeof z;\n');
    await writeFile(
      join(dir, "hook.ts"),
      '#!/usr/bin/env bun\nimport type { T } from "./types.ts";\nimport { s } from "./lib.ts";\nexport const x: T | typeof s = s;\n',
    );

    expect([...(await packagesOf(join(dir, "hook.ts")))]).toEqual(["effect"]);

    await rm(dir, { recursive: true });
  });
});
