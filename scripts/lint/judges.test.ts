import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { $ } from "bun";
import { Schema } from "effect";

import { decodeJson } from "../../factory/lib/json.ts";
import { OXLINT } from "../gates/check-exception-ratchet.ts";
import { SDK_DOORS } from "./judges.ts";

const PLUGIN = join(import.meta.dir, "index.ts");

const ROOT = join(import.meta.dir, "..", "..");

const ACTOR_IMPORT = 'import { ROUTING_JUDGE } from "./routing-judge.actor.ts";';

/** Each source, one statement per line: the line numbers below name them. */
const SOURCES = {
  "factory/land/x/judge.ts": [
    ACTOR_IMPORT,
    'import type { Options } from "@anthropic-ai/claude-agent-sdk/sdk";',
    'export const sdk = import("@anthropic-ai/claude-agent-sdk");',
    "const SLOW = { timeoutMs: 1 };",
    'const WRITERS = { tools: ["Read", "Write"] };',
    "export const a = ask({ judgeSettings: WRITERS, prompt });",
    "export const b = fast ? ask({ judgeSettings: { ...ROUTING_JUDGE, ...SLOW }, prompt }) : null;",
    'export const c = ask({ prompt: "Steps: 1) read 2) report", judgeSettings: ROUTING_JUDGE, ...SLOW });',
    'const K = "judgeSettings";',
    "export const d = ask({ [K]: WRITERS, prompt });",
    'export const e = ask({ "judgeSettings": WRITERS });',
    "export const f = ask({ judgeSettings: ROUTING_JUDGE, [key]: WRITERS });",
    "const judgeSettings = WRITERS;",
    "export const g = ask({ judgeSettings });",
    'export const h = review({ judgeSettings: ROUTING_JUDGE, model: "opus" });',
    "export const re = /a\\//u; export const i = review({ judgeSettings: ROUTING_JUDGE, model: `opus` });",
    'export const k = ["claude", "-p", "--resume", s, "--fork-session", "prompt"];',
    'export const l = ["claude", "-p", "--fork-session", "--tools", "Read,Edit"];',
    'export const m = ["claude", "-p", "--fork-session", "--tools=Read", "x"];',
    'export const n = ["claude", "-p", "--fork-session", "--tools", ROUTING_JUDGE.tools.join(","), `--permission-mode ${mode}`];',
    'export const o = ["claude", "-p", "--fork-session", "--tools", ROUTING_JUDGE.tools.join(","), "--dangerously-skip-permissions"];',
    'export const p = ["claude", "-p", "--fork-session", "--tools", ROUTING_JUDGE.tools.join(","), ...(x ? ["--allowedTools", "Edit"] : [])];',
    'export const q = ["claude", "-p", "--fork-session", "--tools", ROUTING_JUDGE.tools.join(","), ...EXTRA];',
    "export const r = SLOW; export type Q = Options;",
    'export class X implements Question { readonly judgeSettings = { model: "opus", tools: ["Write"], timeoutMs: 3_600_000 }; }',
    "export class Y { get judgeSettings() { return WRITERS; } }",
    "export class Z { constructor(readonly judgeSettings: JudgeSettings) {} }",
    "export class W { judgeSettings; constructor() { this.judgeSettings = WRITERS; } }",
    'const HEAD = ["claude", "-p"];',
    'export const s1 = [...HEAD, "--fork-session", "--tools", "Read,Write,Edit,Bash"];',
    'const FORK = ["--resume", s, "--fork-session"];',
    'export const s2 = ["claude", "-p", ...FORK, "prompt"];',
  ].join("\n"),
  "factory/land/x/clean.ts": [
    ACTOR_IMPORT,
    'export const a = ask({ ...reader, judgeSettings: ROUTING_JUDGE, prompt: "p" });',
    'export const b = ["claude", "-p", "--resume", s, "--fork-session", "--tools", ROUTING_JUDGE.tools.join(","), "--permission-mode", ROUTING_JUDGE.permissionMode, ...(m === null ? [] : ["--model", m])];',
    "export const { tools } = ROUTING_JUDGE;",
    "export const c = { ...record.triage, [step.patch]: 1 };",
    "export const d = review({ judgeSettings: ROUTING_JUDGE, model: request.model });",
    '// tools: ["Write"], "--dangerously-skip-permissions" in a comment',
    'export const e = ["claude", "stop", "x"];',
    "export const f = { answer, judge };",
    "export class Ok { readonly judgeSettings = ROUTING_JUDGE; }",
    'const HEAD = ["claude", "-p"]; export const k = [...HEAD, "--resume", s, "--fork-session", "--tools", ROUTING_JUDGE.tools.join(",")];',
    'export const g = { model: "REVIEW_MODEL", effort: "REVIEW_EFFORT" };',
    'export const h = ["claude", "-p", "prompt"];',
    'export const i = ["claude", "--permission-mode", "acceptEdits", "--allowedTools", "Edit"];',
    'export const j = { tools: ["Read", "Write"], permissionMode: "dontAsk" };',
  ].join("\n"),
  "factory/land/x/routing-judge.actor.ts":
    'export const ROUTING_JUDGE = { model: "haiku", tools: ["Read"], timeoutMs: 1, permissionMode: "dontAsk" } as const;\n',
  "factory/land/shared/ask.live.ts": [
    'import { query } from "@anthropic-ai/claude-agent-sdk";',
    'export const options = { tools: [...q.judgeSettings.tools], permissionMode: "dontAsk", query };',
  ].join("\n"),
  "factory/land/x/judge.test.ts": 'export const a = ask({ judgeSettings: { model: "opus", tools: ["Write"] } });\n',
  "scripts/x.ts": 'export const a = { tools: ["Write"], model: "opus" };\n',
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
  dir = mkdtempSync(join(tmpdir(), "local-judges-"));

  for (const [name, source] of Object.entries(SOURCES)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true });
    writeFileSync(join(dir, name), source);
  }

  writeFileSync(
    join(dir, ".oxlintrc.json"),
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [{ name: "local", specifier: PLUGIN }],
      rules: { "local/judges": "error" },
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

describe("local/judges through oxlint", () => {
  test("reports each way a Judge's settings are written outside its actor file, and the Agent SDK named outside its doors", () => {
    expect(lines("factory/land/x/judge.ts")).toEqual([
      2, 3, 6, 7, 8, 10, 11, 12, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 23, 25, 26, 27, 28, 28, 30, 31, 32,
    ]);
  });

  test("names the file and the reason", () => {
    expect(messages).toContain(
      "`factory/land/x/judge.ts` passes a Judge's settings that are not a constant imported from an actor file. A Judge's settings live in its actor file (`factory/land/AGENTS.md`).",
    );
    expect(messages).toContain(
      "`factory/land/x/judge.ts` forks a session with no `--tools`, so the Judge has every tool. A Judge's settings live in its actor file (`factory/land/AGENTS.md`).",
    );
  });

  test("leaves what is no Judge's call: a model named by a variable's name (#197), a `claude -p` launcher, and tools and flags no Judge reads; and a Judge's call done right", () => {
    expect(lines("factory/land/x/clean.ts")).toEqual([]);
  });

  test("leaves the actor file, the SDK's door, a test and a file outside the factory", () => {
    expect(lines("factory/land/x/routing-judge.actor.ts")).toEqual([]);
    expect(lines("factory/land/shared/ask.live.ts")).toEqual([]);
    expect(lines("factory/land/x/judge.test.ts")).toEqual([]);
    expect(lines("scripts/x.ts")).toEqual([]);
  });

  test("each door it names is a file of the repository", () => {
    for (const door of SDK_DOORS) {
      expect({ door, exists: existsSync(join(ROOT, door)) }).toEqual({ door, exists: true });
    }
  });
});
