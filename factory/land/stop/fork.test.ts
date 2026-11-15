import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sandboxedOf } from "../shared/worker-sandbox.ts";
import { FORK_MARKER } from "./decide.ts";
import { doneQuestionOf } from "./done-judge.prompt.ts";
import {
  apiForkOf,
  forkArgvOf,
  forkResultOf,
  forkSettingsOf,
  hasForkMarker,
  modelOf,
  prTextOf,
  transcriptLinesOf,
} from "./fork.ts";
import { linesOf, stop } from "./hook.live.ts";
import { FINISHED, UNFINISHED, world } from "./stop.fixtures.ts";

describe("transcript", () => {
  test("a user turn opening with the marker makes the session a fork; the marker elsewhere does not", () => {
    expect(hasForkMarker([{ type: "user", message: { content: `${FORK_MARKER} are you done?` } }])).toBe(true);
    expect(hasForkMarker([{ type: "user", message: { content: [{ text: ` ${FORK_MARKER} q` }] } }])).toBe(true);
    expect(hasForkMarker([{ type: "user", message: { content: `the spec names ${FORK_MARKER}` } }])).toBe(false);
    expect(hasForkMarker([{ type: "assistant", message: { content: `${FORK_MARKER} q` } }])).toBe(false);
  });

  test("one marked user turn among others is enough; a user turn with no message is not one", () => {
    expect(
      hasForkMarker([
        { type: "user" },
        { type: "user", message: {} },
        { type: "user", message: { content: `${FORK_MARKER} q` } },
      ]),
    ).toBe(true);
    expect(hasForkMarker([{ type: "user" }, { type: "user", message: {} }])).toBe(false);
  });

  test("a session whose transcript opens a turn with the marker is a fork, resumed: nothing runs", async () => {
    const found = world();
    const transcript = join(mkdtempSync(join(tmpdir(), "transcript-")), "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: doneQuestionOf([]) } }));

    expect(
      await stop({ session_id: "S1", transcript_path: transcript, cwd: found.root }, found.deps, found.log),
    ).toEqual({ kind: "allow" });
    expect(found.calls).toEqual([]);
    expect(found.records).toEqual([{ step: "admit", kind: "none", reason: "this session is a fork, resumed" }]);
  });

  test("the model is the last assistant message's, synthetic ones skipped", () => {
    expect(
      modelOf([
        { type: "assistant", message: { model: "claude-opus-5-5" } },
        { type: "assistant", message: { model: "claude-haiku-5-5" } },
        { type: "assistant", message: { model: "<synthetic>" } },
      ]),
    ).toBe("claude-haiku-5-5");
    expect(modelOf([])).toBeNull();
  });

  test("only an assistant message that names its model counts, down to the transcript's first line", () => {
    expect(modelOf([{ type: "assistant", message: { model: "claude-opus-5-5" } }])).toBe("claude-opus-5-5");
    expect(
      modelOf([
        { type: "assistant", message: { model: "claude-opus-5-5" } },
        { type: "user", message: { model: "claude-haiku-5-5" } },
        { type: "assistant", message: {} },
        { type: "system" },
      ]),
    ).toBe("claude-opus-5-5");
    expect(modelOf([{ type: "user", message: { model: "claude-haiku-5-5" } }, { type: "assistant" }])).toBeNull();
  });

  test("blank and whitespace-only lines are skipped, and a line's number still counts them", () => {
    const user = JSON.stringify({ type: "user" });

    expect(transcriptLinesOf(`${user}\n   \n\n${user}\n`, "t.jsonl")).toEqual([{ type: "user" }, { type: "user" }]);
    expect(() => transcriptLinesOf(`${user}\n  \n{`, "t.jsonl")).toThrow("t.jsonl line 3: ");
  });

  test("each line reads as far as the hook needs it: block text, model, the keys it does not name dropped", () => {
    const path = join(mkdtempSync(join(tmpdir(), "transcript-")), "t.jsonl");

    writeFileSync(
      path,
      [
        JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "image" }, { type: "text", text: "q" }] },
        }),
        "",
        JSON.stringify({
          type: "assistant",
          message: { model: "claude-opus-5-5", content: [{ type: "tool_use", input: {} }] },
        }),
      ].join("\n"),
    );

    expect(linesOf(path)).toEqual([
      { type: "file-history-snapshot" },
      { type: "user", message: { content: [{}, { text: "q" }] } },
      { type: "assistant", message: { model: "claude-opus-5-5", content: [{}] } },
    ]);
  });

  test("a line that does not read throws, naming the transcript and the line", () => {
    const path = join(mkdtempSync(join(tmpdir(), "transcript-")), "t.jsonl");

    writeFileSync(
      path,
      `${JSON.stringify({ type: "user" })}\n${JSON.stringify({ type: "user", message: { content: 7 } })}\n`,
    );

    expect(() => linesOf(path)).toThrow(`${path} line 2: Expected string | array\n  at ["message"]["content"]`);
  });

  test("the PR text is the fork's first line as title, the rest as body", () => {
    expect(prTextOf("# feat: x\n\nwhy\nhow")).toEqual({ title: "feat: x", body: "why\nhow" });
    expect(prTextOf("  ")).toBeNull();
  });

  test("the title drops the leading heading marks and the spaces around it, and nothing else", () => {
    expect(prTextOf("\n\n## feat: x  \nwhy")).toEqual({ title: "feat: x", body: "why" });
    expect(prTextOf("#feat: x")).toEqual({ title: "feat: x", body: "" });
    expect(prTextOf("fix: the # in C#")).toEqual({ title: "fix: the # in C#", body: "" });
  });
});

const usage = (scale: number) => ({
  inputTokens: scale,
  outputTokens: 2 * scale,
  cacheReadInputTokens: 5 * scale,
  cacheCreationInputTokens: 3 * scale,
});

describe("forkResultOf", () => {
  test("reads the answer, the structured output and the tokens of every model `claude -p --output-format json` prints", () => {
    expect(
      forkResultOf(
        JSON.stringify({
          result: "text",
          structured_output: FINISHED,
          modelUsage: { "claude-haiku-5-5": usage(1), "claude-opus-5-5": usage(10) },
        }),
        0,
        9,
      ),
    ).toEqual({
      text: "text",
      structured: FINISHED,
      ms: 9,
      tokens: { input: 11, output: 22, cacheRead: 55, cacheCreation: 33 },
      code: 0,
      unreadable: null,
    });
    expect(forkResultOf(JSON.stringify({ result: "YES" }), 0, 9)).toEqual({
      text: "YES",
      structured: undefined,
      ms: 9,
      tokens: null,
      code: 0,
      unreadable: null,
    });
  });

  test("a modelUsage that does not read loses the tokens, never the answer", () => {
    const partial = { "claude-haiku-5-5": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: null } };

    for (const modelUsage of [partial, "none"]) {
      expect(forkResultOf(JSON.stringify({ result: "YES", structured_output: UNFINISHED, modelUsage }), 0, 9)).toEqual({
        text: "YES",
        structured: UNFINISHED,
        ms: 9,
        tokens: null,
        code: 0,
        unreadable: null,
      });
    }
  });

  test("output that does not read is no answer, and says why", () => {
    expect(forkResultOf("", 124, 9)).toEqual({
      text: "",
      structured: undefined,
      ms: 9,
      tokens: null,
      code: 124,
      unreadable: "Expected a valid JSON string",
    });
    expect(forkResultOf(JSON.stringify({ result: 7 }), 0, 9).unreadable).toBe('Expected string\n  at ["result"]');
  });
});

const API_FORK = { apiKeyHelper: "cat '/home/me/.api-agent/key'" };

describe("apiForkOf", () => {
  test("the forks of an API Worker's session bill the key: their settings name the helper that prints its file", () => {
    expect(apiForkOf({ LAB_API_WORKER: "1", LAB_AUTHOR: "1", HOME: "/home/me" })).toEqual(API_FORK);
  });

  test("the forks of any other session take its login: nothing is added", () => {
    expect(apiForkOf({ LAB_AUTHOR: "1", HOME: "/home/me" })).toBeNull();
    expect(apiForkOf({ LAB_API_WORKER: "0", HOME: "/home/me" })).toBeNull();
    expect(apiForkOf({})).toBeNull();
  });

  test("an API Worker's session with no home throws: its fork would bill another credential", () => {
    expect(() => apiForkOf({ LAB_API_WORKER: "1" })).toThrow("HOME is unset");
  });
});

describe("forkSettingsOf", () => {
  const guard = {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: 'cd "/repo" && bun "/repo/factory/bin/fork-guard.ts"', timeout: 30 }],
      },
    ],
  };

  const place = { home: "/home/me", checkout: "/main" };
  const { sandbox, permissions } = sandboxedOf({ env: {} }, place);
  const rules = { blockReadsOutsideWorkingDirectories: true, deny: permissions.deny };

  test("a fork's settings put every tool call under the fork guard, started in the checkout that holds it and never in the fork's own directory; the fork of a session in no clone adds nothing else", () => {
    expect(forkSettingsOf("/repo", null, null)).toBe(JSON.stringify({ hooks: guard }));
  });

  test("the fork of a Worker in a clone prints one result, runs its commands in that Worker's sandbox, which hides the main checkout, and reads no credential with its file tools", () => {
    expect(forkSettingsOf("/repo", place, null)).toBe(
      JSON.stringify({ verbose: false, sandbox, permissions: rules, hooks: guard }),
    );
    expect(sandbox.filesystem.denyRead).toEqual(["/home/me"]);
    expect(sandbox.credentials.files).toContainEqual({ path: "/main", mode: "deny" });
    expect(sandbox.filesystem.allowRead).not.toContain("/main");
    expect(rules.deny).toContain("Read(//home/me/.ssh/**)");
  });

  test("a fork takes no allow rule and no variable of a Worker's settings: it is held to reading", () => {
    const settings: unknown = JSON.parse(forkSettingsOf("/repo", place, null));

    expect(settings).not.toHaveProperty("permissions.allow");
    expect(settings).not.toHaveProperty("env");
  });

  test("the settings of an API Worker's fork add the key helper, which names the key's file and never the key", () => {
    expect(forkSettingsOf("/repo", place, API_FORK)).toBe(
      JSON.stringify({ verbose: false, sandbox, permissions: rules, ...API_FORK, hooks: guard }),
    );
  });
});

describe("forkArgvOf", () => {
  const ask = { model: "claude-opus-5-5", prompt: "are you done?", schema: { type: "object" } };

  test("asks a resumed fork with the Done judge's tools under the guard, on the session's model, against the schema", () => {
    expect(forkArgvOf("S1", ask, "/guard.json", false)).toEqual([
      "claude",
      "-p",
      "--resume",
      "S1",
      "--fork-session",
      "--tools",
      "Read,Grep,Glob,Bash",
      "--permission-mode",
      "dontAsk",
      "--settings",
      "/guard.json",
      "--strict-mcp-config",
      "--json-schema",
      '{"type":"object"}',
      "--output-format",
      "json",
      "--model",
      "claude-opus-5-5",
      "are you done?",
    ]);
  });

  test("with no schema and no model, the fork answers in free text on the default model", () => {
    const argv = forkArgvOf("S1", { ...ask, model: null, schema: null }, "/guard.json", false);

    expect(argv.slice(11)).toEqual(["--strict-mcp-config", "--output-format", "json", "are you done?"]);
  });

  test("the fork of a Worker in a clone loads no settings but its own: no hook of the clone runs in it, and no rule of the Owner's own settings widens its sandbox", () => {
    const argv = forkArgvOf("S1", { ...ask, model: null, schema: null }, "/guard.json", true);

    expect(argv.slice(9)).toEqual([
      "--settings",
      "/guard.json",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--output-format",
      "json",
      "are you done?",
    ]);
    expect(forkArgvOf("S1", ask, "/guard.json", false)).not.toContain("--setting-sources");
  });
});
