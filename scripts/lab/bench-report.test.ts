import { describe, expect, test } from "bun:test";

import type { Json } from "../lib/plain-json.ts";
import {
  argsOf,
  claudeArgv,
  closingOf,
  HELP,
  readingOf,
  reportOf,
  WORKER_SETTINGS,
  workerPrompt,
} from "./bench-report.ts";

const line = (value: Json): string => JSON.stringify(value);

const attachment = (value: Json): string => line({ type: "attachment", attachment: value });

describe("argsOf", () => {
  test("reads the issue, the runs, the model and the wake", () => {
    expect(argsOf(["--issue", "i.md", "--runs", "2", "--model", "haiku", "--wake", "w.md"])).toEqual({
      kind: "run",
      args: { issue: "i.md", runs: 2, model: "haiku", wake: "w.md" },
    });
  });

  test("the model and the wake are optional", () => {
    expect(argsOf(["--issue", "i.md", "--runs", "1"])).toEqual({
      kind: "run",
      args: { issue: "i.md", runs: 1, model: undefined, wake: undefined },
    });
  });

  test("--help asks for the help", () => {
    expect(argsOf(["--issue", "i.md", "--help"])).toEqual({ kind: "help" });
  });

  test("a missing issue or runs, a runs that is no positive integer, or an unknown flag is an error", () => {
    for (const argv of [
      ["--runs", "2"],
      ["--issue", "i.md"],
      ["--issue", "i.md", "--runs", "0"],
      ["--issue", "i.md", "--runs", "1.5"],
      ["--issue", "i.md", "--runs", "two"],
      ["--issue", "i.md", "--runs", "2", "--bogus"],
    ]) {
      expect(argsOf(argv).kind).toBe("error");
    }
  });
});

test("the help says how to write a fake issue file", () => {
  expect(HELP).toContain("--issue <file>");
  expect(HELP).toContain("fake issue");
  expect(HELP).toContain("Done when");
});

test("the Worker settings hold the Worker's output style and no LAB_AUTHOR", () => {
  expect(WORKER_SETTINGS).toEqual({ outputStyle: "Proactive" });
  expect(JSON.stringify(WORKER_SETTINGS)).not.toContain("LAB_AUTHOR");
});

test("the prompt sends the Worker to AGENTS.md and holds the issue", () => {
  const prompt = workerPrompt("## Problem\n\nX.");

  expect(prompt).toContain("AGENTS.md");
  expect(prompt.endsWith("## Problem\n\nX.")).toBe(true);
});

describe("claudeArgv", () => {
  test("a launch is headless, in JSON, with the settings file and the model", () => {
    expect(claudeArgv({ settings: "/b/s.json", model: "haiku", prompt: "go", resume: undefined })).toEqual([
      "claude",
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--settings",
      "/b/s.json",
      "--model",
      "haiku",
      "go",
    ]);
  });

  test("a wake resumes the session, and no model leaves the default", () => {
    expect(claudeArgv({ settings: "/b/s.json", prompt: "wake", model: undefined, resume: "s1" })).toEqual([
      "claude",
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--settings",
      "/b/s.json",
      "--resume",
      "s1",
      "wake",
    ]);
  });
});

describe("closingOf", () => {
  test("reads the session and its closing message from claude's JSON result", () => {
    expect(closingOf(line({ type: "result", session_id: "s1", result: "Committed.", is_error: false }))).toEqual({
      session: "s1",
      message: "Committed.",
    });
  });

  test("an error result or what is not a result throws", () => {
    expect(() => closingOf(line({ session_id: "s1", result: "boom", is_error: true }))).toThrow("boom");
    expect(() => closingOf("not json")).toThrow("claude's result");
  });
});

describe("readingOf", () => {
  test("the rules are those of .claude/rules/ the session loaded, at start or on a read, once each and sorted", () => {
    const transcript = [
      attachment({
        type: "instructions",
        files: [{ path: "/h/.claude/CLAUDE.md" }, { path: "/b/run-1/.claude/rules/identities.md" }],
      }),
      attachment({ type: "nested_memory", path: "/b/run-1/.claude/rules/land-loop/relay.md" }),
      attachment({ type: "nested_memory", path: "/b/run-1/.claude/rules/land-loop/code.md" }),
      attachment({ type: "nested_memory", path: "/b/run-1/.claude/rules/land-loop/relay.md" }),
      attachment({ type: "nested_memory", path: "/b/run-1/app/AGENTS.md" }),
      line({ type: "user", message: { content: "read .claude/rules/hooks.md" } }),
    ].join("\n");

    expect(readingOf(transcript).rules).toEqual([
      ".claude/rules/identities.md",
      ".claude/rules/land-loop/code.md",
      ".claude/rules/land-loop/relay.md",
    ]);
  });

  test("an output style other than the Worker's is named, once", () => {
    const transcript = [
      attachment({ type: "output_style_instructions", style: { name: "Proactive", prompt: "…" } }),
      attachment({ type: "output_style", style: "Proactive" }),
      attachment({ type: "output_style", style: "Explanatory" }),
      attachment({ type: "output_style_instructions", style: { name: "Explanatory", prompt: "…" } }),
    ].join("\n");

    expect(readingOf(transcript).foreignStyles).toEqual(["Explanatory"]);
  });

  test("a transcript with no attachment reads no rule and no foreign style, and blank lines are skipped", () => {
    expect(readingOf(`${line({ type: "user" })}\n\n`)).toEqual({ rules: [], foreignStyles: [] });
  });
});

test("the report gives each session its closing messages, its rules and its output styles", () => {
  const report = reportOf({ issue: "i.md", runs: 2, model: "haiku", root: "/b" }, [
    {
      run: 1,
      dir: "/b/run-1",
      closings: [{ session: "s1", message: "Committed the fix." }],
      reading: { rules: [".claude/rules/land-loop/code.md"], foreignStyles: [] },
    },
    {
      run: 2,
      dir: "/b/run-2",
      closings: [
        { session: "s2", message: "Committed." },
        { session: "s2", message: "Fixed the finding." },
      ],
      reading: { rules: [], foreignStyles: ["Explanatory"] },
    },
  ]);

  expect(report).toBe(
    [
      "Bench: 2 runs of i.md on haiku, clones under /b",
      "",
      "## Run 1, session s1, in /b/run-1",
      "Rules loaded: .claude/rules/land-loop/code.md",
      "Output style: the Worker's alone",
      "Closing message:",
      "Committed the fix.",
      "",
      "## Run 2, session s2, in /b/run-2",
      "Rules loaded: none",
      "Output style: a reminder of Explanatory",
      "Closing message:",
      "Committed.",
      "Closing message after the Wake:",
      "Fixed the finding.",
      "",
    ].join("\n"),
  );
});

test("the report names the default model when none is given", () => {
  expect(reportOf({ issue: "i.md", runs: 0, model: undefined, root: "/b" }, [])).toStartWith(
    "Bench: 0 runs of i.md on the default model",
  );
});
