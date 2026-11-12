import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { $ } from "bun";
import { Schema } from "effect";

import { decodeJson } from "../../factory/lib/json.ts";
import { OXLINT } from "../gates/check-exception-ratchet.ts";
import type { Place } from "./layers.map.ts";
import { edgeRefusal, globToRegExp, placeOf, resolvedPath, zoneOf } from "./layers.ts";
import type { Edge } from "./layers.ts";

const DOMAIN: Place = { package: "factory", layer: "domain" };

const DECIDE = "factory/land/stop/decide.ts";

const OWNER = "Do not change the map or the rule: they belong to the Owner.";

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
    expect(placeOf("scripts/hooks/fix-edited.ts")).toEqual({ package: "tooling", layer: "entry" });
    expect(placeOf("scripts/gates/check-lint-disables.ts")).toEqual({ package: "tooling", layer: "tooling" });
    expect(placeOf("oxlint.config.ts")).toEqual({ package: "tooling", layer: "tooling" });
  });

  test("reads the layer of a file of the factory in its name, and the layer of a door in its directory", () => {
    expect(placeOf("factory/land/merge-bot/decide.ts")).toEqual(DOMAIN);
    expect(placeOf("factory/land/review/code-review.prompt.ts")).toEqual(DOMAIN);
    expect(placeOf("factory/land/stop/done-judge.actor.ts")).toEqual(DOMAIN);
    expect(placeOf("factory/land/shared/ask.port.ts")).toEqual({ package: "factory", layer: "ports" });
    expect(placeOf("factory/land/merge-bot/main.live.ts")).toEqual({ package: "factory", layer: "infra" });
    expect(placeOf("factory/bin/merge-bot.ts")).toEqual({ package: "factory", layer: "entry" });
    expect(placeOf("factory/hooks/role.ts")).toEqual({ package: "factory", layer: "entry" });
    expect(placeOf("factory/land/shared/ask.live.test.ts")).toEqual({ package: "factory", layer: "test" });
    expect(placeOf("factory/hooks/role.test.ts")).toEqual({ package: "factory", layer: "test" });
    expect(placeOf("factory/land/arbitraries.fixtures.ts")).toEqual({ package: "factory", layer: "test" });
  });

  test("places a file added to the factory with no entry of its own, and no file the map does not name", () => {
    expect(placeOf("factory/land/stop/new.ts")).toEqual(DOMAIN);
    expect(placeOf("factory/land/stop/new.live.ts")).toEqual({ package: "factory", layer: "infra" });
    expect(placeOf("app/src/util.ts")).toBeNull();
    expect(placeOf("scripts/new/tool.ts")).toBeNull();
  });
});

describe("zoneOf", () => {
  test("names a zone by its directory, each step of the Land loop its own, and the contract by its file", () => {
    expect(zoneOf("factory/bin/relay.ts")).toEqual({ name: "factory/bin", rank: 5 });
    expect(zoneOf("factory/watch/watch-plan.ts")).toEqual({ name: "factory/watch", rank: 4 });
    expect(zoneOf("factory/land/stop/decide.ts")).toEqual({ name: "factory/land/stop", rank: 3 });
    expect(zoneOf("factory/land/merge-bot/sub/x.ts")).toEqual({ name: "factory/land/merge-bot", rank: 3 });
    expect(zoneOf("factory/land/shared/findings.ts")).toEqual({ name: "factory/land/shared", rank: 2 });
    expect(zoneOf("factory/install/logins.ts")).toEqual({ name: "factory/install", rank: 1 });
    expect(zoneOf("factory/contract.ts")).toEqual({ name: "factory/contract.ts", rank: 1 });
    expect(zoneOf("factory/lib/json.ts")).toEqual({ name: "factory/lib", rank: 0 });
  });

  test("gives no zone to a file outside the factory, nor to one the factory holds in no zone's directory", () => {
    expect(zoneOf("scripts/gates/check-lint-disables.ts")).toBeNull();
    expect(zoneOf("factory/land/stray.ts")).toBeNull();
    expect(zoneOf("factory/stray.ts")).toBeNull();
  });
});

describe("resolvedPath", () => {
  test("resolves a relative specifier from its importer's directory", () => {
    expect(resolvedPath(DECIDE, "../../lib/run.live.ts")).toBe("factory/lib/run.live.ts");
    expect(resolvedPath(DECIDE, "./x.ts")).toBe("factory/land/stop/x.ts");
  });

  test("resolves neither a bare specifier nor one that leaves the root", () => {
    expect(resolvedPath(DECIDE, "effect")).toBeNull();
    expect(resolvedPath("a.ts", "../b.ts")).toBeNull();
  });
});

describe("edgeRefusal", () => {
  test("lets the domain import the domain, a port's value and the allowed effect modules", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, value("./done-judge.prompt.ts", "x"))).toBeNull();
    expect(edgeRefusal(DECIDE, DOMAIN, value("../../lib/run.port.ts", "checked"))).toBeNull();
    expect(edgeRefusal(DECIDE, DOMAIN, value("effect", "Schema", "Struct", "Exit", "Predicate"))).toBeNull();
  });

  test("refuses another effect module as a value in the domain, and allows it as a type", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, value("effect", "Schema", "Effect"))).toContain("effect Effect");
    expect(edgeRefusal(DECIDE, DOMAIN, value("effect/Effect"))).toContain("effect Effect");
    expect(edgeRefusal(DECIDE, DOMAIN, typeOnly("effect"))).toBeNull();
  });

  test("names both ends and the fix when the domain imports the infra", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, value("../../lib/run.live.ts", "run"))).toBe(
      `\`factory/land/stop/decide.ts\` (domain) imports \`factory/lib/run.live.ts\` (infra). Fix the import: the entry point does the I/O and passes the result; depend on the port, not the live layer; use \`import type\` when a type is enough. ${OWNER}`,
    );
  });

  test("lets a type-only import reach a pure layer, never the infra or an entry point", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, typeOnly("../shared/ask.port.ts"))).toBeNull();
    expect(edgeRefusal(DECIDE, DOMAIN, typeOnly("../shared/ask.live.ts"))).toContain("(infra)");
    expect(edgeRefusal(DECIDE, DOMAIN, typeOnly("../../bin/relay.ts"))).toContain("(entry)");
  });

  test("refuses an entry point that imports another", () => {
    const entry: Place = { package: "factory", layer: "entry" };

    expect(edgeRefusal("factory/bin/relay.ts", entry, value("./fork-guard.ts", "x"))).toContain(
      "`factory/bin/relay.ts` (entry) imports `factory/bin/fork-guard.ts` (entry)",
    );
  });

  test("refuses a step of the Land loop that imports another, by a value or by a type, and names the way out", () => {
    const refused = `\`factory/land/stop/decide.ts\` (zone \`factory/land/stop\`) imports \`factory/land/relay/wakes.ts\` (zone \`factory/land/relay\`): a zone imports only itself and the zones below it. Move what both need down to a zone both may import (\`factory/land/shared/\`, \`factory/contract.ts\`, \`factory/lib/\`), or have the door in \`factory/bin/\` pass it. ${OWNER}`;

    expect(edgeRefusal(DECIDE, DOMAIN, value("../relay/wakes.ts", "x"))).toBe(refused);
    expect(edgeRefusal(DECIDE, DOMAIN, typeOnly("../relay/wakes.ts"))).toBe(refused);
  });

  test("lets the Merge bot call the routing and the review, and neither call it back", () => {
    const mergeBot = "factory/land/merge-bot/decide.ts";

    expect(edgeRefusal(mergeBot, DOMAIN, value("../routing/routing-rules.ts", "x"))).toBeNull();
    expect(edgeRefusal(mergeBot, DOMAIN, typeOnly("../review/review-report.ts"))).toBeNull();
    expect(edgeRefusal(mergeBot, DOMAIN, value("../stop/decide.ts", "x"))).toContain("zone `factory/land/stop`");
    expect(edgeRefusal("factory/land/routing/routing-rules.ts", DOMAIN, typeOnly("../merge-bot/decide.ts"))).toContain(
      "zone `factory/land/merge-bot`",
    );
  });

  test("lets a zone import the zones below it, and none above it or beside it", () => {
    const watch = "factory/watch/watch-plan.ts";

    expect(edgeRefusal(DECIDE, DOMAIN, value("../shared/findings.ts", "x"))).toBeNull();
    expect(edgeRefusal(DECIDE, DOMAIN, value("../../contract.ts", "x"))).toBeNull();
    expect(edgeRefusal(DECIDE, DOMAIN, value("../../install/logins.ts", "x"))).toBeNull();
    expect(edgeRefusal(DECIDE, DOMAIN, value("../../lib/json.ts", "x"))).toBeNull();
    expect(edgeRefusal(watch, DOMAIN, value("../land/merge-bot/decide.ts", "x"))).toBeNull();
    expect(edgeRefusal(watch, DOMAIN, value("../dispatch/dispatch-plan.ts", "x"))).toContain("zone `factory/dispatch`");
    expect(edgeRefusal("factory/land/shared/findings.ts", DOMAIN, value("../stop/decide.ts", "x"))).toContain(
      "zone `factory/land/stop`",
    );
    expect(edgeRefusal("factory/lib/json.ts", DOMAIN, value("../contract.ts", "x"))).toContain(
      "zone `factory/contract.ts`",
    );
    expect(edgeRefusal(DECIDE, DOMAIN, typeOnly("../../watch/watch-plan.ts"))).toContain("zone `factory/watch`");
  });

  test("lets a test import any zone", () => {
    const tests: Place = { package: "factory", layer: "test" };

    expect(edgeRefusal("factory/land/stop/decide.test.ts", tests, value("../relay/wakes.ts", "x"))).toBeNull();
    expect(edgeRefusal("factory/lib/json.test.ts", tests, value("../bin/relay.ts", "x"))).toBeNull();
  });

  test("lets a file outside the factory import its lib alone, and the factory import nothing outside it", () => {
    const tooling: Place = { package: "tooling", layer: "tooling" };
    const gate = "scripts/gates/x.ts";

    expect(edgeRefusal(gate, tooling, value("../../factory/lib/json.ts", "decodeJson"))).toBeNull();
    expect(edgeRefusal(gate, tooling, value("../../factory/contract.ts", "x"))).toBe(
      `\`scripts/gates/x.ts\` imports \`factory/contract.ts\` (zone \`factory/contract.ts\`): a file outside the factory imports only \`factory/lib/\`. ${OWNER}`,
    );
    expect(edgeRefusal(gate, tooling, value("../../factory/land/merge-bot/decide.ts", "x"))).toContain(
      "a file outside the factory imports only `factory/lib/`",
    );
    expect(edgeRefusal(DECIDE, DOMAIN, value("../../../scripts/gates/fixture-env.ts", "x"))).toContain(
      "(tooling tooling)",
    );
    expect(
      edgeRefusal("app/src/task.ts", { package: "app", layer: "domain" }, value("../../factory/lib/json.ts", "x")),
    ).toContain("(factory domain)");
  });

  test("refuses an external the layer may not import", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, value("node:fs", "readFileSync"))).toContain("imports `node:fs` (node)");
  });

  test("refuses a bare specifier and a file the map does not know", () => {
    expect(edgeRefusal(DECIDE, DOMAIN, value("lodash"))).toContain("a specifier the layer map does not know");
    expect(edgeRefusal(DECIDE, DOMAIN, value("../../../app/src/util.ts"))).toContain("which no layer of the map holds");
  });
});

// oxlint's RuleTester does not run under Bun, so the rule runs through oxlint itself, from a directory
// laid out like the repository: the rule places a file outside the repository by its path from there.

const CONFIG = join(import.meta.dir, "layers.oxlint.config.ts");

const SOURCES = {
  "factory/land/stop/decide.ts": [
    'import { run } from "../../lib/run.live.ts";',
    'import { type Ran, spawned } from "../../lib/run.live.ts";',
    'import type { Ask } from "../shared/ask.port.ts";',
    'import { checked } from "../../lib/run.port.ts";',
    'export { run as r } from "../../lib/run.live.ts";',
    'export * from "../../lib/run.live.ts";',
    'export type * from "../shared/ask.port.ts";',
    'const live = await import("../shared/ask.live.ts");',
    'export type Stream = import("../shared/ask.live.ts").Stream;',
    'Bun.spawn(["ls"]);',
    'await fetch("https://example.com");',
    "const env = process.env;",
    "const bun = Bun;",
    'const glob = new Bun.Glob("*");',
    "await Bun.sleep(1);",
    "export const all = [run, spawned, checked, live, env, bun, glob];",
  ].join("\n"),
  "factory/land/queue/repost.ts": [
    'import f = require("../../lib/run.live.ts");',
    'const g = require("../../lib/run.live.ts");',
    'const h = import.meta.require("../../lib/run.live.ts");',
    'export {} from "../shared/ask.live.ts";',
    'const name = "../../lib/run.live.ts";',
    "const computed = require(name);",
    "export const all = [f, g, h, computed];",
  ].join("\n"),
  "factory/land/routing/routing-rules.ts": [
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
  "factory/land/merge-bot/decide.ts": [
    "export function shadow(process: number): number {",
    "  return process;",
    "}",
    "const fetch = (url: string): string => url;",
    'export const fetched = fetch("a");',
    'import { a } from "../routing/routing-rules.ts";',
    'import type { B } from "../review/post-plan.ts";',
    'import { c } from "../stop/decide.ts";',
    "export const all: B[] = [a, c];",
  ].join("\n"),
  "factory/land/relay/wakes.ts": [
    'import { x } from "../stop/decide.ts";',
    'import type { T } from "../stop/decide.ts";',
    'import { y } from "../shared/findings.ts";',
    'import { z } from "../../contract.ts";',
    'import { w } from "../../install/logins.ts";',
    "export const all: T[] = [x, y, z, w];",
  ].join("\n"),
  "factory/land/stop/decide.test.ts": 'import { x } from "../relay/wakes.ts";\nexport const y = x;\n',
  "factory/lib/json.ts": 'import { LAND_GATE } from "../contract.ts";\nexport const gate = LAND_GATE;\n',
  "factory/land/stray.ts": "export const z = 1;\n",
  "factory/bin/relay.ts": 'import { x } from "./fork-guard.ts";\nexport const y = x;\n',
  "factory/bin/fork-guard.ts": 'export const x = 1;\nBun.spawn(["ls"]);\nexport const env = globalThis.process.env;\n',
  "factory/lib/run.live.ts":
    'export const run = 1;\nBun.spawn(["ls"]);\nexport const env = self.globalThis.process.env;\n',
  "scripts/gates/check-x.ts": [
    'import { decodeJson } from "../../factory/lib/json.ts";',
    'import { LAND_GATE } from "../../factory/contract.ts";',
    "export const all = [decodeJson, LAND_GATE];",
  ].join("\n"),
  "factory/land/stop/loaders.live.ts": [
    'import { createRequire } from "node:module";',
    'export const wakes = createRequire(import.meta.url)("../relay/wakes.ts");',
    'import { Worker as Thread } from "node:worker_threads";',
    'export const thread = new Thread("../relay/x.live.ts");',
    'export const required = require("node:module");',
    'export const step = new Worker(new URL("../relay/x.live.ts", import.meta.url));',
    'export const own = new Worker(new URL("./decide.ts", import.meta.url));',
    'export const viaGlobal = new globalThis.Worker("../relay/x.live.ts");',
    "const load = import.meta.require;",
    "const req = require;",
    'export const builtin = process.getBuiltinModule("node:module");',
    'export const fs = process.getBuiltinModule("node:fs");',
    "export const all = [load, req];",
    "const { getBuiltinModule: builtinLoader } = process;",
    "const { require: metaRequire } = import.meta;",
    "const { Worker: Thread2 } = globalThis;",
    'export const roles = { Worker: "worker.md", require: "x" };',
    "export const role = roles.Worker + roles.require;",
    "export const more = [builtinLoader, metaRequire, Thread2];",
    "const meta = import.meta;",
    'export const chained = new globalThis.self.Worker("../relay/x.live.ts");',
    'const hidden = globalThis["self"];',
    "export function started({ Worker: W } = globalThis): unknown { return W; }",
    'const name = "fetch";',
    "export const keyed = globalThis[name];",
    "export const named = [meta, hidden, globalThis.fetch, import.meta.dir];",
  ].join("\n"),
  "factory/land/stop/started.ts": [
    'export const started = new Worker(new URL("../relay/x.live.ts", import.meta.url));',
    'export const same = new Worker(new URL("./decide.ts", import.meta.url));',
    'export const byPath = new Worker("./decide.ts");',
    "const Started = Worker;",
    "export type Thread = Worker;",
    "export const all = [Started];",
    'export const preloaded = new Worker(new URL("./decide.ts", import.meta.url), { preload: ["../relay/x.live.ts"] });',
  ].join("\n"),
  "factory/land/queue/hidden.ts": [
    "declare const process: { env: Record<string, string> };",
    "declare function fetch(url: string): Promise<string>;",
    "export const env = process.env;",
    'export const got = fetch("u");',
    "export const meta = import.meta.env;",
    'export const socket = new WebSocket("wss://example.com");',
    'export const files = new Bun.Glob("*").scanSync(".");',
    'console.log("x");',
    "setTimeout(() => 0, 1);",
    "export const now = Date.now();",
    "export const id = crypto.randomUUID();",
    "export const today = new Date();",
    'export const days = [Date.parse("2026-01-01"), Date.UTC(2026, 0, 1), new Date(0)];',
    "export type When = Date;",
    "export const url = import.meta.url;",
    'export const matched = new Bun.Glob("*").match("a");',
    'export const keyed = new Bun.Glob("*")["scan"](".");',
    "export const whole = import.meta;",
    'export const evaluated = eval("process").env;',
    'export const made = new Function("return process")();',
    "export const spread = new Date(...[]);",
    "export const zone = Intl.DateTimeFormat().format();",
    'export const answer = prompt("?");',
    'export const placed = import.meta.require("./x.ts");',
    'export const code = (() => 0).constructor("return process")();',
    "const { constructor: F } = () => 0;",
    "export const templated = (() => 0)[`constructor`];",
    "export const taken = F;",
  ].join("\n"),
  ".claude/plugins/land/hooks/land.tsx": [
    'import type { Register } from "claude-code";',
    'import { LAND_GATE } from "../../../../factory/contract.ts";',
    'import { decodeJson } from "../../../../factory/lib/json.ts";',
    "export const all: Register[] = [LAND_GATE, decodeJson];",
  ].join("\n"),
  ".claude/plugins/land/tests/land.test.tsx": [
    'import { expect } from "claude-code/testing";',
    'import { LAND_GATE } from "../../../../factory/contract.ts";',
    "expect(LAND_GATE).toBe(LAND_GATE);",
  ].join("\n"),
  "app/src/util.ts": "export const z = 1;\n",
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

  const ran = await $`${OXLINT} -c ${CONFIG} --format=json .`.cwd(dir).nothrow().quiet();
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
  test("reports each value edge to the infra, a mixed import, export from, import() and import types of the infra, and leaves a port's value", () => {
    expect(lines("factory/land/stop/decide.ts")).toEqual([1, 2, 5, 6, 8, 9, 10, 11, 12, 13, 15]);
  });

  test("reports import = require, require, import.meta.require, export {} from, and a computed require", () => {
    expect(lines("factory/land/queue/repost.ts")).toEqual([1, 2, 3, 4, 6]);
  });

  test("reports every Bun member but Glob, and globalThis, self, global and window whatever follows, never a type", () => {
    expect(lines("factory/land/routing/routing-rules.ts")).toEqual([4, 5, 6, 7, 8, 9, 10, 12, 13]);
    expect(messages).toContain(
      `\`factory/land/routing/routing-rules.ts\` (domain) uses \`globalThis\`, I/O that only infra, entry, tooling, test may do. The entry point does the I/O and passes the result, or the code goes behind a port. ${OWNER}`,
    );
  });

  test("reports Bun.spawn, Bun.sleep, fetch, process and Bun read whole in the domain, and leaves Bun.Glob", () => {
    for (const global of ["Bun.spawn", "Bun.sleep", "fetch", "process", "Bun"]) {
      expect(messages).toContain(
        `\`factory/land/stop/decide.ts\` (domain) uses \`${global}\`, I/O that only infra, entry, tooling, test may do. The entry point does the I/O and passes the result, or the code goes behind a port. ${OWNER}`,
      );
    }
  });

  test("leaves a local binding named like an I/O global, and the Merge bot's calls to the routing and the review, and reports its import of another step", () => {
    expect(lines("factory/land/merge-bot/decide.ts")).toEqual([8]);
  });

  test("reports a step that imports another step, by a value and by a type, and leaves what it takes from below and a test's imports", () => {
    expect(lines("factory/land/relay/wakes.ts")).toEqual([1, 2]);
    expect(lines("factory/land/stop/decide.test.ts")).toEqual([]);
  });

  test("reports the lib's import of a zone above it, and a tool's import of the factory past its lib", () => {
    expect(lines("factory/lib/json.ts")).toEqual([1]);
    expect(lines("scripts/gates/check-x.ts")).toEqual([2]);
  });

  test("reports an entry point that imports another, and leaves the I/O of an entry point and of the infra", () => {
    expect(lines("factory/bin/relay.ts")).toEqual([1]);
    expect(lines("factory/bin/fork-guard.ts")).toEqual([]);
    expect(lines("factory/lib/run.live.ts")).toEqual([]);
  });

  test("reports createRequire and a worker thread wherever they are imported, a loader read or destructured and not called, the global objects read whole, and places a Worker's module as an import", () => {
    expect(messages).toContain(
      `\`factory/land/stop/loaders.live.ts\` reads \`import.meta\` whole or by a key the rule cannot read: it hands out every global, the loaders among them, past the layer map. Read a member by its name, as \`globalThis.fetch\`. ${OWNER}`,
    );
    expect(lines("factory/land/stop/loaders.live.ts")).toEqual([
      1, 3, 5, 6, 8, 9, 10, 11, 14, 15, 16, 20, 21, 22, 23, 25,
    ]);
    expect(messages).toContain(
      `\`factory/land/stop/loaders.live.ts\` reads \`.require\` without calling it, so the layer map cannot place what it loads. Call it with a string literal. ${OWNER}`,
    );
    expect(messages).toContain(
      `\`factory/land/stop/loaders.live.ts\` reads \`require\` without calling it, so the layer map cannot place what it loads. Call it with a string literal. ${OWNER}`,
    );
    expect(messages).toContain(
      `\`factory/land/stop/loaders.live.ts\` (infra) imports \`node:module\` (loader). Fix the import: the entry point does the I/O and passes the result; depend on the port, not the live layer; use \`import type\` when a type is enough. ${OWNER}`,
    );
  });

  test("reports a logic file's Worker of another step, a Worker started from no URL of its own, and one with options", () => {
    expect(lines("factory/land/stop/started.ts")).toEqual([1, 3, 4, 7]);
    expect(messages).toContain(
      `\`factory/land/stop/started.ts\` (domain) imports \`factory/land/relay/x.live.ts\` (infra). Fix the import: the entry point does the I/O and passes the result; depend on the port, not the live layer; use \`import type\` when a type is enough. ${OWNER}`,
    );
    expect(messages).toContain(
      `\`factory/land/stop/started.ts\` starts a \`Worker\` the layer map cannot place. Start it as \`new Worker(new URL("./x.ts", import.meta.url))\`, with no options: a \`preload\` loads modules the map never places. ${OWNER}`,
    );
  });

  test("reports the I/O of a declared global, import.meta, the network, the terminal, timers, the clock, a Glob's scan and code run from a string in a logic file", () => {
    expect(lines("factory/land/queue/hidden.ts")).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27,
    ]);

    for (const global of [
      "process",
      "fetch",
      "import.meta.env",
      "WebSocket",
      ".scanSync",
      "console",
      "setTimeout",
      "Date.now",
      "crypto",
      "Date",
      ".scan",
      "import.meta",
      "eval",
      "Function",
      "Intl",
      "prompt",
      ".constructor",
    ]) {
      expect(messages).toContain(
        `\`factory/land/queue/hidden.ts\` (domain) uses \`${global}\`, I/O that only infra, entry, tooling, test may do. The entry point does the I/O and passes the result, or the code goes behind a port. ${OWNER}`,
      );
    }
  });

  test("reports a mod's import of the factory past its lib, and leaves its tests'", () => {
    expect(lines(".claude/plugins/land/hooks/land.tsx")).toEqual([2]);
    expect(lines(".claude/plugins/land/tests/land.test.tsx")).toEqual([]);
  });

  test("places a file of the repository from its root, when oxlint runs from a subdirectory", async () => {
    const app = join(import.meta.dir, "..", "..", "app");
    const ran = await $`${OXLINT} -c ${CONFIG} --format=json src/task.ts`.cwd(app).nothrow().quiet();

    expect(decodeJson(OxlintReport, "the oxlint report", ran.stdout.toString()).diagnostics).toEqual([]);
  });

  test("reports a file the map does not place, and a file of the factory that lies in no zone", () => {
    expect(lines("app/src/util.ts")).toEqual([1]);
    expect(messages).toContain(
      `\`app/src/util.ts\` is in no layer of \`scripts/lint/layers.map.ts\`. Put the file in a directory the map classifies. ${OWNER}`,
    );
    expect(lines("factory/land/stray.ts")).toEqual([1]);
    expect(messages).toContain(
      `\`factory/land/stray.ts\` is in no zone of \`scripts/lint/layers.map.ts\`. Put the file in a directory of \`factory/\` the map names: a step of \`factory/land/\`, \`factory/land/shared/\`, \`factory/lib/\`. ${OWNER}`,
    );
  });
});
