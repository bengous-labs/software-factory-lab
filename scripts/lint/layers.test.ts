import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { $ } from "bun";
import { Schema } from "effect";

import { OXLINT } from "../gates/check-exception-ratchet.ts";
import { decodeJson } from "../lib/json.ts";
import type { Place } from "./layers.map.ts";
import { edgeRefusal, globToRegExp, placeOf, resolvedPath } from "./layers.ts";
import type { Edge } from "./layers.ts";

const DOMAIN: Place = { package: "land-loop", layer: "domain" };

const DECIDE = "scripts/land-loop/stop/decide.ts";

const value = (specifier: string, ...names: string[]): Edge => ({
  specifier,
  kind: "value",
  valueNames: names.length === 0 ? ["*"] : names,
});

const typeOnly = (specifier: string): Edge => ({ specifier, kind: "type", valueNames: [] });

describe("globToRegExp", () => {
  test("keeps a single star inside one segment, and lets a double star span none or many", () => {
    expect(globToRegExp("a/*.ts").test("a/b.ts")).toBe(true);
    expect(globToRegExp("a/*.ts").test("a/b/c.ts")).toBe(false);
    expect(globToRegExp("a/**/*.ts").test("a/b.ts")).toBe(true);
    expect(globToRegExp("a/**/*.ts").test("a/b/c/d.ts")).toBe(true);
    expect(globToRegExp("a.ts").test("abts")).toBe(false);
  });
});

describe("placeOf", () => {
  test("places each kind of file of the repository", () => {
    expect(placeOf("app/src/task.ts")).toEqual({ package: "app", layer: "domain" });
    expect(placeOf("app/src/store/store.ts")).toEqual({ package: "app", layer: "infra" });
    expect(placeOf("app/test/store.test.ts")).toEqual({ package: "app", layer: "test" });
    expect(placeOf("scripts/land-loop/merge-bot/decide.ts")).toEqual(DOMAIN);
    expect(placeOf("scripts/land-loop/merge-bot/main.ts")).toEqual({ package: "land-loop", layer: "entry" });
    expect(placeOf("scripts/land-loop/ports/ask.ts")).toEqual({ package: "land-loop", layer: "ports" });
    expect(placeOf("scripts/land-loop/review/post-plan.ts")).toEqual({ package: "land-loop", layer: "application" });
    expect(placeOf("scripts/land-loop/lib/run.ts")).toEqual({ package: "land-loop", layer: "infra" });
    expect(placeOf("scripts/land-loop/lib/ask.test.ts")).toEqual({ package: "land-loop", layer: "test" });
    expect(placeOf("scripts/land-loop/arbitraries.ts")).toEqual({ package: "land-loop", layer: "test" });
    expect(placeOf("scripts/lib/json.ts")).toEqual({ package: "shared", layer: "domain" });
    expect(placeOf("scripts/hooks/fix-edited.ts")).toEqual({ package: "tooling", layer: "entry" });
    expect(placeOf("scripts/gates/check-lint-disables.ts")).toEqual({ package: "tooling", layer: "tooling" });
    expect(placeOf("oxlint.config.ts")).toEqual({ package: "tooling", layer: "tooling" });
  });

  test("places no file the map does not name", () => {
    expect(placeOf("scripts/land-loop/new.ts")).toBeNull();
    expect(placeOf("app/src/util.ts")).toBeNull();
  });
});

describe("resolvedPath", () => {
  test("resolves a relative specifier from its importer's directory", () => {
    expect(resolvedPath(DECIDE, "../lib/run.ts")).toBe("scripts/land-loop/lib/run.ts");
    expect(resolvedPath(DECIDE, "./x.ts")).toBe("scripts/land-loop/stop/x.ts");
  });

  test("resolves neither a bare specifier nor one that leaves the root", () => {
    expect(resolvedPath(DECIDE, "effect")).toBeNull();
    expect(resolvedPath("a.ts", "../b.ts")).toBeNull();
  });
});

describe("edgeRefusal", () => {
  test("lets the domain import the domain and the allowed effect modules", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, value("../merge-bot/decide.ts", "x"))).toBeNull();
    expect(edgeRefusal(DECIDE, DOMAIN, value("effect", "Schema", "Struct"))).toBeNull();
  });

  test("refuses another effect module as a value in the domain, and allows it as a type", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, value("effect", "Schema", "Effect"))).toContain("effect Effect");
    expect(edgeRefusal(DECIDE, DOMAIN, value("effect/Effect"))).toContain("effect Effect");
    expect(edgeRefusal(DECIDE, DOMAIN, typeOnly("effect"))).toBeNull();
  });

  test("names both ends and the fix when the domain imports the infra", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, value("../lib/run.ts", "run"))).toBe(
      "`scripts/land-loop/stop/decide.ts` (domain) imports `scripts/land-loop/lib/run.ts` (infra). Fix the import: the entry point does the I/O and passes the result; depend on the port, not the live layer; use `import type` when a type is enough. Do not change the map or the rule: they belong to the Owner.",
    );
  });

  test("lets a type-only import reach a pure layer, never the infra or an entry point", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, typeOnly("../review/post-plan.ts"))).toBeNull();
    expect(edgeRefusal(DECIDE, DOMAIN, value("../review/post-plan.ts", "x"))).toContain("(application)");
    expect(edgeRefusal(DECIDE, DOMAIN, typeOnly("../lib/ask.ts"))).toContain("(infra)");
    expect(edgeRefusal(DECIDE, DOMAIN, typeOnly("../pr-watch.ts"))).toContain("(entry)");
  });

  test("refuses an entry point that imports another", () => {
    const entry: Place = { package: "land-loop", layer: "entry" };

    expect(edgeRefusal("scripts/land-loop/pr-watch.ts", entry, value("./thread.ts", "x"))).toContain(
      "`scripts/land-loop/pr-watch.ts` (entry) imports `scripts/land-loop/thread.ts` (entry)",
    );
  });

  test("refuses the tooling an import of the Land loop, and lets it import the shared helpers", () => {
    const tooling: Place = { package: "tooling", layer: "tooling" };
    const gate = "scripts/gates/x.ts";

    expect(edgeRefusal(gate, tooling, value("../land-loop/merge-bot/decide.ts", "x"))).toContain("(land-loop domain)");
    expect(edgeRefusal(gate, tooling, value("../lib/json.ts", "decodeJson"))).toBeNull();
  });

  test("refuses an external the layer may not import", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, value("node:fs", "readFileSync"))).toContain("imports `node:fs` (node)");
  });

  test("refuses a bare specifier and a file the map does not know", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, value("lodash"))).toContain("a specifier the layer map does not know");
    expect(edgeRefusal(DECIDE, DOMAIN, value("./util.ts"))).toContain("which no layer of the map holds");
  });
});

// oxlint's RuleTester does not run under Bun, so the rule runs through oxlint itself, from a directory
// laid out like the repository: the rule places a file outside the repository by its path from there.

const PLUGIN = join(import.meta.dir, "index.ts");

const SOURCES = {
  "scripts/land-loop/stop/decide.ts": [
    'import { run } from "../lib/run.ts";',
    'import { type Ran, checked } from "../lib/run.ts";',
    'import type { Ask } from "../ports/ask.ts";',
    'import type { DiffLines } from "../review/post-plan.ts";',
    'export { run as r } from "../lib/run.ts";',
    'export * from "../lib/run.ts";',
    'export type * from "../review/post-plan.ts";',
    'const live = await import("../lib/ask.ts");',
    'export type Stream = import("../lib/ask.ts").Stream;',
    'Bun.spawn(["ls"]);',
    'await fetch("https://example.com");',
    "const env = process.env;",
    "const bun = Bun;",
    'const glob = new Bun.Glob("*");',
    "await Bun.sleep(1);",
    "export const all = [run, checked, live, env, bun, glob];",
  ].join("\n"),
  "scripts/land-loop/queue/decide.ts": [
    'import f = require("../lib/run.ts");',
    'const g = require("../lib/run.ts");',
    'const h = import.meta.require("../lib/run.ts");',
    'export {} from "../review/post-plan.ts";',
    'const name = "../lib/run.ts";',
    "const computed = require(name);",
    "export const all = [f, g, h, computed];",
  ].join("\n"),
  "scripts/land-loop/routing/routing-rules.ts": [
    'export const matches = (glob: Bun.Glob): boolean => glob.match("x");',
    "export type Env = typeof process.env;",
    "export type Fetch = typeof fetch;",
    "export const token = Bun.env.TOKEN;",
    "export const env = globalThis.process.env;",
    "export const viaSelf = self.fetch;",
    "export const whole = globalThis;",
    "export const clone = globalThis.structuredClone;",
    "export const deep = globalThis.globalThis.process.env;",
    'export const chained = self.globalThis.fetch("u");',
    "export type Global = typeof globalThis;",
    "export const viaGlobal = global.process;",
    "export const viaWindow = window.fetch;",
  ].join("\n"),
  "scripts/land-loop/merge-bot/decide.ts": [
    "export function shadow(process: number): number {",
    "  return process;",
    "}",
    "const fetch = (url: string): string => url;",
    'export const fetched = fetch("a");',
  ].join("\n"),
  "scripts/land-loop/pr-watch.ts": 'import { x } from "./thread.ts";\nexport const y = x;\n',
  "scripts/land-loop/thread.ts":
    'export const x = 1;\nBun.spawn(["ls"]);\nexport const env = globalThis.process.env;\n',
  "scripts/land-loop/new.ts": "export const z = 1;\n",
  "scripts/land-loop/lib/run.ts":
    'export const run = 1;\nBun.spawn(["ls"]);\nexport const env = self.globalThis.process.env;\n',
} as const;

type SourceName = keyof typeof SOURCES;

const OxlintReport = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
      message: Schema.String,
      labels: Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.Number }) })),
    }),
  ),
});

const reported = new Map<string, number[]>();

const messages = new Set<string>();

let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "local-layers-"));

  for (const [name, source] of Object.entries(SOURCES)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true });
    writeFileSync(join(dir, name), source);
  }

  writeFileSync(
    join(dir, ".oxlintrc.json"),
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [{ name: "local", specifier: PLUGIN }],
      rules: { "local/layers": "error" },
    }),
  );

  const ran = await $`${OXLINT} -c .oxlintrc.json --format=json .`.cwd(dir).nothrow().quiet();
  const report = decodeJson(OxlintReport, "the oxlint report", ran.stdout.toString());

  for (const diagnostic of report.diagnostics) {
    reported.set(diagnostic.filename, [
      ...(reported.get(diagnostic.filename) ?? []),
      diagnostic.labels[0]?.span.line ?? 0,
    ]);
    messages.add(diagnostic.message);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lines = (name: SourceName): number[] => (reported.get(name) ?? []).toSorted((a, b) => a - b);

describe("local/layers through oxlint", () => {
  test("reports each value edge to the infra, a mixed import, export from, import() and import types of the infra", () => {
    expect(lines("scripts/land-loop/stop/decide.ts")).toEqual([1, 2, 5, 6, 8, 9, 10, 11, 12, 13, 15]);
  });

  test("reports import = require, require, import.meta.require, export {} from, and a computed require", () => {
    expect(lines("scripts/land-loop/queue/decide.ts")).toEqual([1, 2, 3, 4, 6]);
  });

  test("reports every Bun member but Glob, and globalThis, self, global and window whatever follows, never a type", () => {
    expect(lines("scripts/land-loop/routing/routing-rules.ts")).toEqual([4, 5, 6, 7, 8, 9, 10, 12, 13]);
    expect(messages).toContain(
      "`scripts/land-loop/routing/routing-rules.ts` (domain) uses `globalThis`, I/O that only infra, entry, tooling, test may do. The entry point does the I/O and passes the result, or the code goes behind a port. Do not change the map or the rule: they belong to the Owner.",
    );
  });

  test("reports Bun.spawn, Bun.sleep, fetch, process and Bun read whole in the domain, and leaves Bun.Glob", () => {
    for (const global of ["Bun.spawn", "Bun.sleep", "fetch", "process", "Bun"]) {
      expect(messages).toContain(
        `\`scripts/land-loop/stop/decide.ts\` (domain) uses \`${global}\`, I/O that only infra, entry, tooling, test may do. The entry point does the I/O and passes the result, or the code goes behind a port. Do not change the map or the rule: they belong to the Owner.`,
      );
    }
  });

  test("leaves a local binding named like an I/O global", () => {
    expect(lines("scripts/land-loop/merge-bot/decide.ts")).toEqual([]);
  });

  test("reports an entry point that imports another, and leaves the I/O of an entry point and of the infra", () => {
    expect(lines("scripts/land-loop/pr-watch.ts")).toEqual([1]);
    expect(lines("scripts/land-loop/thread.ts")).toEqual([]);
    expect(lines("scripts/land-loop/lib/run.ts")).toEqual([]);
  });

  test("places a file of the repository from its root, when oxlint runs from a subdirectory", async () => {
    const config = join(dir, ".oxlintrc.json");
    const app = join(import.meta.dir, "..", "..", "app");
    const ran = await $`${OXLINT} -c ${config} --format=json src/task.ts`.cwd(app).nothrow().quiet();

    expect(decodeJson(OxlintReport, "the oxlint report", ran.stdout.toString()).diagnostics).toEqual([]);
  });

  test("reports a file the map does not place", () => {
    expect(lines("scripts/land-loop/new.ts")).toEqual([1]);
    expect(messages).toContain(
      "`scripts/land-loop/new.ts` is in no layer of `scripts/lint/layers.map.ts`. Put the file in a directory the map classifies. Do not change the map or the rule: they belong to the Owner.",
    );
  });
});
