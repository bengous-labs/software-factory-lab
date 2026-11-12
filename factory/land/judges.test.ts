/**
 * A Judge reads, and writes nothing. Its settings live in an actor file beside it, and the test beside
 * that file pins them: read-only tools alone, never none, and a deadline. Each of its tool calls goes
 * through a guard whose own failure denies the call (`shared/ask.live.test.ts`,
 * `review/review-session.live.test.ts`, `stop/fork-guard.test.ts`).
 *
 * This test holds the settings to the actor files: a Judge reaches Claude Code through one of the two
 * doors to the Agent SDK, which pass a call's settings through, or as a `claude -p` fork. It reads the
 * sources as text, since no parser is a dependency the layers allow a test, and so it fails closed:
 * outside the actor files and the doors, each word that names a Judge's tools or permissions, in code or
 * in a string, sits on a line of one of the few forms that read an actor file's constant, or the test
 * fails. A file that sets a Judge's tools reads every deadline from an actor's constant and spreads only
 * what the test lists, no source spreads an actor's constant whole, and none writes a model as a literal.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FACTORY = join(import.meta.dir, "..");

/** The doors to the Agent SDK: each passes the settings of the call it is handed. */
const SDK_DOORS = ["land/review/review-session.live.ts", "land/shared/ask.live.ts"];

/** The factory's sources, from `factory/`: no test, no fixture. */
const SOURCES = [...new Bun.Glob("**/*.ts").scanSync({ cwd: FACTORY })]
  .filter((path) => !/\.(?:test|fixtures)\.ts$/u.test(path))
  .toSorted();

const read = (path: string): string => readFileSync(join(FACTORY, path), "utf8");

/** The sources a Judge's settings may not be written in: all but the actor files and the SDK's doors. */
const OUTSIDE = SOURCES.filter((path) => !path.endsWith(".actor.ts") && !SDK_DOORS.includes(path));

/** The names a source imports from an actor file, under the name it gives them. */
function actorNamesOf(source: string): ReadonlySet<string> {
  const names = new Set<string>();

  for (const [, list = ""] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*\.actor\.ts"/gu)) {
    for (const name of list.split(",")) {
      const local = name
        .trim()
        .split(/\s+as\s+/u)
        .at(-1);

      if (local !== undefined && local !== "") {
        names.add(local);
      }
    }
  }

  return names;
}

/** A word that names a Judge's tools or permissions, as a key, an identifier, a string or a flag. */
const SETTING_WORD =
  /(?<![\w$-])(?:--)?(?:tools|allowedTools|disallowedTools|allowed-tools|disallowed-tools|permissionMode|permission-mode|dangerously-skip-permissions|allow-dangerously-skip-permissions)(?![\w$-])/u;

/** Whether a trimmed line is a comment's alone: a `//` line, or a line of a block comment with no code after it. */
const commentLine = (line: string): boolean =>
  line.startsWith("//") || (/^(?:\/\*|\*)/u.test(line) && !/\*\/\s*\S/u.test(line));

/** Whether `pattern` captures, in `line`, the name of a constant imported from an actor file. */
const readsActor = (pattern: RegExp, line: string, actors: ReadonlySet<string>): boolean =>
  actors.has(pattern.exec(line)?.[1] ?? "");

const TOOLS_JOINED = /^([\w$]+)\.tools\.join\(","\),?$/u;

const PERMISSION_MODE = /^([\w$]+)\.permissionMode,?$/u;

/**
 * The forms a trimmed line that names a Judge's tools or permissions may take: a key or a fork's flag
 * that reads an actor file's constant, and the field of a port's type. `next` is the line after it.
 */
function allowedLine(path: string, line: string, next: string, actors: ReadonlySet<string>): boolean {
  return (
    readsActor(/^tools: ([\w$]+)\.tools,?$/u, line, actors) ||
    readsActor(TOOLS_JOINED, line, actors) ||
    readsActor(PERMISSION_MODE, line, actors) ||
    (line === '"--tools",' && readsActor(TOOLS_JOINED, next, actors)) ||
    (line === '"--permission-mode",' && readsActor(PERMISSION_MODE, next, actors)) ||
    (path.endsWith(".port.ts") && line === "readonly tools: readonly string[];")
  );
}

/** Whether `source` sets a Judge's tools: a line of it hands them on from an actor file's constant. */
const judgeFile = (path: string, source: string): boolean =>
  !path.endsWith(".port.ts") && /^\s*(?:tools: [\w$]+\.tools|"--tools",)/mu.test(source);

/** Whether `line` sets a fault: a setting word in no allowed form, a deadline not an actor's in a Judge's file, a model literal, an actor's constant spread whole. */
function faultyLine(
  line: string,
  next: string,
  at: { path: string; judge: boolean; actors: ReadonlySet<string> },
): boolean {
  const { path, judge, actors } = at;

  if (SETTING_WORD.test(line)) {
    return !allowedLine(path, line, next, actors);
  }

  if (judge && /(?<![\w$])timeoutMs(?![\w$])/u.test(line)) {
    return !readsActor(/^timeoutMs: ([\w$]+)\.timeoutMs,?$/u, line, actors);
  }

  return (
    /(?<![\w$.])["']?model["']?\s*:\s*["'`]/u.test(line) ||
    [...line.matchAll(/\.\.\.([\w$]+)(?![\w$.[])/gu)].some(([, name = ""]) => actors.has(name))
  );
}

/** What in `source`, at `path`, sets a Judge's settings outside an actor file: one entry per line. */
function settingsFaultsOf(path: string, source: string): readonly string[] {
  const at = { path, judge: judgeFile(path, source), actors: actorNamesOf(source) };
  const lines = source.split("\n").map((line) => line.trim());

  return lines.flatMap((line, index) =>
    !commentLine(line) && faultyLine(line, lines[index + 1] ?? "", at) ? [`${path}:${index + 1}: ${line}`] : [],
  );
}

/** The trimmed lines of a source that spread something. */
const spreadsOf = (source: string): readonly string[] =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("..."));

describe("the Judges' settings", () => {
  test("the factory holds three, each in an actor file beside its Judge, with a test beside it", () => {
    const actors = SOURCES.filter((path) => path.endsWith(".actor.ts"));

    expect(actors).toEqual([
      "land/review/code-review.actor.ts",
      "land/routing/routing-judge.actor.ts",
      "land/stop/done-judge.actor.ts",
    ]);

    for (const actor of actors) {
      const tested = actor.replace(/\.ts$/u, ".test.ts");

      expect({ tested, exists: existsSync(join(FACTORY, tested)) }).toEqual({ tested, exists: true });
    }
  });

  test("the Agent SDK is named by its two doors alone, in any import of it", () => {
    expect(SOURCES.filter((path) => read(path).includes("@anthropic-ai/claude-agent-sdk"))).toEqual(SDK_DOORS);
  });

  test("outside the actor files and the SDK's doors, no source sets a Judge's tools, permissions, deadline or model", () => {
    expect(OUTSIDE.flatMap((path) => settingsFaultsOf(path, read(path)))).toEqual([]);
  });

  test("the files that set a Judge's tools are seen, and what they spread is listed: a spread can override a setting", () => {
    const judges = OUTSIDE.filter((path) => judgeFile(path, read(path)));

    expect(judges.map((path) => [path, spreadsOf(read(path))])).toEqual([
      ["bin/code-review.ts", []],
      ["land/routing/routing-judge.ts", ["...reader,"]],
      [
        "land/stop/fork.ts",
        [
          String.raw`const [first = "", ...rest] = text.trim().split("\n");`,
          '...(ask.schema === null ? [] : ["--json-schema", JSON.stringify(ask.schema)]),',
          '...(ask.model === null ? [] : ["--model", ask.model]),',
        ],
      ],
    ]);
  });

  test("a Judge whose settings are written inline is refused, in whatever form or place", () => {
    const sources = [
      'export const judged = ask({ model: "opus", tools: ["Read", "Edit", "Write"], prompt: "p", timeoutMs: 3_600_000 });',
      'const tools = ["Read", "Write"];',
      'ask({ "tools": ["Read", "Write"], prompt });',
      'const K = "tools";',
      'const judged = fast ? ask({ tools: ["Read", "Write"], timeoutMs: 1, prompt }) : other;',
      'ask({ prompt: "Steps: 1) read 2) report", tools: ["Edit"], timeoutMs: 1 });',
      String.raw`const re = /a\//u; ask({ tools: ["Write"], timeoutMs: 1 });`,
      String.raw`const glob = /src\/*.ts/u; ask({ tools: ["Edit"] }); /* end */`,
      "/* a */ ask({ allowedTools: WRITERS });",
    ];

    expect(sources.flatMap((source) => settingsFaultsOf("land/x/judge.ts", source))).toEqual(
      sources.map((source) => `land/x/judge.ts:1: ${source}`),
    );
  });

  test("in a file that sets a Judge's tools, a deadline that is not an actor file's is refused", () => {
    const halfway = [
      'import { ROUTING_JUDGE } from "../routing/routing-judge.actor.ts";',
      "ask({",
      "  tools: ROUTING_JUDGE.tools,",
      "  timeoutMs: 3_600_000,",
      "});",
      "run(argv, { timeoutMs: SLOW });",
    ].join("\n");

    expect(settingsFaultsOf("land/x/judge.ts", halfway)).toEqual([
      "land/x/judge.ts:4: timeoutMs: 3_600_000,",
      "land/x/judge.ts:6: run(argv, { timeoutMs: SLOW });",
    ]);
  });

  test("an actor file's constant spread whole is refused: what is spread after it overrides it", () => {
    const over = [
      'import { ROUTING_JUDGE } from "../routing/routing-judge.actor.ts";',
      "ask({ ...ROUTING_JUDGE, ...SLOW, prompt });",
      "ask({ ...ROUTING_JUDGE.depths[depth], prompt });",
    ].join("\n");

    expect(settingsFaultsOf("land/x/judge.ts", over)).toEqual([
      "land/x/judge.ts:2: ask({ ...ROUTING_JUDGE, ...SLOW, prompt });",
    ]);
  });

  test("a fork whose tools or permissions are not an actor file's is refused", () => {
    const fork = [
      'import { DONE_JUDGE } from "./done-judge.actor.ts";',
      '"--tools",',
      '"Read,Edit",',
      '"--tools=Read,Edit",',
      '"--allowedTools",',
      '"--permission-mode",',
      "MODE,",
      '"--dangerously-skip-permissions",',
      '"--tools",',
      'DONE_JUDGE.tools.join(","),',
    ].join("\n");

    expect(settingsFaultsOf("land/x/fork.ts", fork)).toEqual([
      'land/x/fork.ts:2: "--tools",',
      'land/x/fork.ts:4: "--tools=Read,Edit",',
      'land/x/fork.ts:5: "--allowedTools",',
      'land/x/fork.ts:6: "--permission-mode",',
      'land/x/fork.ts:8: "--dangerously-skip-permissions",',
    ]);
  });

  test("a comment's words, and the field of a port's type, are no Judge's setting", () => {
    const prose = [
      "/** The tools of the session, read-only ones: `guard` decides each call. */",
      "readonly tools: readonly string[];",
      "// read-only tools, with permissionMode dontAsk",
      " * the deadline: timeoutMs",
    ].join("\n");

    expect(settingsFaultsOf("land/shared/x.port.ts", prose)).toEqual([]);
  });
});
