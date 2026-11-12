/**
 * A Judge reads, and writes nothing. Its settings live in an actor file beside it, and the test beside
 * that file pins them: read-only tools alone, never none, and a deadline. Each of its tool calls goes
 * through a guard whose own failure denies the call (`shared/ask.live.test.ts`,
 * `review/review-session.live.test.ts`, `stop/fork-guard.test.ts`).
 *
 * This test holds the settings to the actor files: a Judge reaches Claude Code through one of the two
 * doors to the Agent SDK, which pass a call's settings through, or as a `claude -p` fork. Everywhere
 * else, an object that names a Judge's tools, written out or as a shorthand, or that spreads an actor
 * file's constant, reads its tools and its deadline from such a constant and writes no model; a fork's
 * tool and permission flags read one too, and none lifts the permissions. It reads the sources as text:
 * no parser is a dependency the layers allow a test, so a value it cannot follow, such as a function's
 * result spread into a call, stays out of its sight.
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

/** An object literal of a source: where its `{` sits, and its text up to its `}`. */
interface ObjectText {
  readonly at: number;
  readonly text: string;
}

/** The object literal that holds the character at `index`. */
function objectAround(source: string, index: number): ObjectText {
  let start = index;

  for (let depth = 0; start > 0; start -= 1) {
    const char = source[start - 1];

    if (char === "}") {
      depth += 1;
    } else if (char === "{") {
      if (depth === 0) {
        break;
      }

      depth -= 1;
    }
  }

  let end = index;

  for (let depth = 0; end < source.length; end += 1) {
    const char = source[end];

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      if (depth === 0) {
        break;
      }

      depth -= 1;
    }
  }

  return { at: start, text: source.slice(start, end) };
}

/** The keys that name a Judge's tools. */
const TOOL_KEYS = ["tools", "allowedTools", "disallowedTools"];

/** A key of `TOOL_KEYS` in an object, written out or as a shorthand; not the field of a type. */
const TOOL_KEY =
  /(?<=[{,]\s*)(?:tools|allowedTools|disallowedTools)\s*(?=[,}])|(?<![\w$.]|readonly\s)(?:tools|allowedTools|disallowedTools)\s*:/gu;

/**
 * The text of `key`'s value in the object literal `object`, up to its comma: the key itself for a
 * shorthand; null when it has none.
 */
function valueOf(object: string, key: string): string | null {
  const found = new RegExp(`(?:^|[\\s,{])${key}\\s*(?::\\s*([^,\\n}]+)|(?=[,}\\n]))`, "u").exec(object);

  return found === null ? null : (found[1]?.trim() ?? key);
}

/** Whether `value` reads a member of a constant imported from an actor file. */
const readsActor = (value: string | null, actors: ReadonlySet<string>): boolean => {
  const name = value === null ? undefined : /^([A-Za-z_$][\w$]*)\./u.exec(value)?.[1];

  return name !== undefined && actors.has(name);
};

/** The flags of a `claude` command that set a fork's tools or its permissions. */
const FORK_FLAG =
  /["'`](--(?:tools|allowedTools|allowed-tools|disallowedTools|disallowed-tools|permission-mode))(=[^"'`]*)?["'`]/gu;

/** The flags that lift every permission: no Judge runs with them. */
const UNGUARDED = /--(?:allow-)?dangerously-skip-permissions/gu;

/**
 * What in `source`, at `path`, sets a Judge's settings outside an actor file: an object that names its
 * tools, or spreads an actor's constant, reads its tools and its deadline from an actor's constant and
 * writes no model; a fork's flags read one too, and none lifts the permissions.
 */
function settingsFaultsOf(path: string, source: string): readonly string[] {
  const actors = actorNamesOf(source);
  const faults: string[] = [];
  const objects = new Map<number, string>();

  for (const found of [...source.matchAll(TOOL_KEY), ...source.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/gu)]) {
    if (found[1] === undefined || actors.has(found[1])) {
      const object = objectAround(source, found.index);

      objects.set(object.at, object.text);
    }
  }

  for (const text of objects.values()) {
    const spreadsActor = [...text.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/gu)].some(([, name = ""]) => actors.has(name));

    for (const key of [...TOOL_KEYS, "timeoutMs"]) {
      const value = valueOf(text, key);

      if ((value !== null || (key === "timeoutMs" && !spreadsActor)) && !readsActor(value, actors)) {
        faults.push(`${path}: ${key} ${value}`);
      }
    }

    const model = valueOf(text, "model");

    if (model !== null && /^["'`]/u.test(model)) {
      faults.push(`${path}: model ${model}`);
    }
  }

  for (const found of source.matchAll(FORK_FLAG)) {
    const [whole, flag = "", inline] = found;
    const value = inline ?? /^,\s*([^,\n]+)/u.exec(source.slice(found.index + whole.length))?.[1]?.trim() ?? null;

    if (inline !== undefined || !readsActor(value, actors)) {
      faults.push(`${path}: ${flag} ${value}`);
    }
  }

  for (const [flag] of source.matchAll(UNGUARDED)) {
    faults.push(`${path}: ${flag}`);
  }

  return faults;
}

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

  test("outside the actor files and the SDK's doors, no source sets a Judge's tools, deadline or model", () => {
    const outside = SOURCES.filter((path) => !path.endsWith(".actor.ts") && !SDK_DOORS.includes(path));

    expect(outside.flatMap((path) => settingsFaultsOf(path, read(path)))).toEqual([]);
  });

  test("the calls that do set them are seen: each Judge's call reads its actor file", () => {
    const calls = SOURCES.filter(
      (path) => new RegExp(TOOL_KEY.source, "u").test(read(path)) || read(path).includes('"--tools"'),
    );

    expect(calls.filter((path) => !path.endsWith(".actor.ts") && !SDK_DOORS.includes(path))).toEqual([
      "bin/code-review.ts",
      "land/routing/routing-judge.ts",
      "land/stop/fork.ts",
    ]);
  });

  test("a Judge whose settings are written inline is refused", () => {
    const inline = [
      'import { ask } from "../shared/ask.live.ts";',
      'export const judged = ask({ model: "opus", tools: ["Read", "Edit", "Write"], prompt: "p", timeoutMs: 3_600_000 });',
    ].join("\n");

    expect(settingsFaultsOf("land/x/judge.ts", inline)).toEqual([
      'land/x/judge.ts: tools ["Read"',
      "land/x/judge.ts: timeoutMs 3_600_000",
      'land/x/judge.ts: model "opus"',
    ]);
  });

  test("a deadline, or a constant, that is not an actor file's is refused", () => {
    const halfway = [
      'import { ROUTING_JUDGE } from "../routing/routing-judge.actor.ts";',
      'import { WRITERS } from "./writers.ts";',
      "ask({ model: ROUTING_JUDGE.model, tools: ROUTING_JUDGE.tools, timeoutMs: 3_600_000 });",
      "ask({ model: ROUTING_JUDGE.model, tools: WRITERS.tools, timeoutMs: ROUTING_JUDGE.timeoutMs });",
    ].join("\n");

    expect(settingsFaultsOf("land/x/judge.ts", halfway)).toEqual([
      "land/x/judge.ts: timeoutMs 3_600_000",
      "land/x/judge.ts: tools WRITERS.tools",
    ]);
  });

  test("a fork whose tools or permission mode are written inline is refused", () => {
    const fork = '["claude", "-p", "--tools", "Read,Edit", "--permission-mode", "bypassPermissions", "prompt"]';

    expect(settingsFaultsOf("land/x/fork.ts", fork)).toEqual([
      'land/x/fork.ts: --tools "Read',
      'land/x/fork.ts: --permission-mode "bypassPermissions"',
    ]);
  });
  test("a Judge's tools in a shorthand or a spread, or under another key, are refused", () => {
    const hidden = [
      'import { ROUTING_JUDGE } from "../routing/routing-judge.actor.ts";',
      'const tools = ["Read", "Write"];',
      "ask({ ...ROUTING_JUDGE, tools, prompt });",
      "ask({ ...ROUTING_JUDGE, timeoutMs: 1, prompt });",
      'const WRITERS = { allowedTools: ["Edit"], timeoutMs: ROUTING_JUDGE.timeoutMs };',
    ].join("\n");

    expect(settingsFaultsOf("land/x/judge.ts", hidden)).toEqual([
      "land/x/judge.ts: tools tools",
      'land/x/judge.ts: allowedTools ["Edit"]',
      "land/x/judge.ts: timeoutMs 1",
    ]);
  });

  test("a fork's flags written with `=`, under another name, or lifting the permissions are refused", () => {
    const fork = '["claude", "-p", "--tools=Read,Edit", "--allowedTools", "Edit", "--dangerously-skip-permissions"]';

    expect(settingsFaultsOf("land/x/fork.ts", fork)).toEqual([
      "land/x/fork.ts: --tools =Read,Edit",
      'land/x/fork.ts: --allowedTools "Edit"',
      "land/x/fork.ts: --dangerously-skip-permissions",
    ]);
  });
});
