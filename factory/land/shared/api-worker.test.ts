import { describe, expect, test } from "bun:test";

import {
  apiKeyHelperOf,
  apiWorkerLogOf,
  apiWorkerSettingsOf,
  firstTurnArgvOf,
  NO_SETTING_SOURCES,
  ONE_RESULT,
  resumedTurnArgvOf,
} from "./api-worker.ts";

const TURN = {
  session: "S1",
  model: "opus",
  effort: null,
  settings: "/h/api-worker-settings.json",
  checkout: "/repo",
  prompt: "the prompt",
};

/** What every turn's command ends with, after its session, its model and its effort. */
const TAIL = [
  "--settings",
  "/h/api-worker-settings.json",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--append-system-prompt-file",
  "/repo/AGENTS.md",
  "--permission-mode",
  "dontAsk",
  "--output-format",
  "json",
  "the prompt",
];

describe("the key of an API Worker", () => {
  test("its file lies under the home, and the helper prints it, quoted for the shell", () => {
    expect(apiKeyHelperOf("/home/me")).toBe("cat '/home/me/.api-agent/key'");
    expect(apiKeyHelperOf("/home/my home")).toBe("cat '/home/my home/.api-agent/key'");
  });

  test("a quote in the home cannot close the helper's quote", () => {
    expect(apiKeyHelperOf("/home/o'neil")).toBe(String.raw`cat '/home/o'\''neil/.api-agent/key'`);
  });
});

describe("the files of an API Worker", () => {
  test("its settings file lies in the config directory, and its log in the main checkout's state", () => {
    expect(apiWorkerSettingsOf("/home/me")).toBe("/home/me/.config/software-factory-lab/api-worker-settings.json");
    expect(apiWorkerLogOf("/repo", "S1")).toBe("/repo/.lab/state/api-worker-S1.log");
  });
});

describe("the turns of an API Worker", () => {
  test("a turn loads no settings source, and its settings make it print one result", () => {
    expect(NO_SETTING_SOURCES).toEqual(["--setting-sources", ""]);
    expect(ONE_RESULT).toEqual({ verbose: false });
  });

  test("the first turn is headless, names its session, loads its settings file alone and is given the main checkout's root guide", () => {
    expect(firstTurnArgvOf(TURN, "w-issue-7")).toEqual([
      "claude",
      "-p",
      "--session-id",
      "S1",
      "--name",
      "w-issue-7",
      "--model",
      "opus",
      ...TAIL,
    ]);
  });

  test("a later turn resumes the session headless with the same settings, sources, guide, mode and model, never in the background", () => {
    const argv = resumedTurnArgvOf(TURN);

    expect(argv).toEqual(["claude", "-p", "--resume", "S1", "--model", "opus", ...TAIL]);
    expect(argv).not.toContain("--bg");
  });

  test("a turn given an effort names it after the model; one given none leaves Claude Code's own", () => {
    const argv = firstTurnArgvOf({ ...TURN, effort: "high" }, "w-issue-7");

    expect(argv.slice(6, 12)).toEqual(["--model", "opus", "--effort", "high", "--settings", TURN.settings]);
    expect(firstTurnArgvOf(TURN, "w-issue-7")).not.toContain("--effort");
  });

  test("the guide a turn is given is never a file of the worktree, which the Worker can make a link to a secret", () => {
    const worktree = "/repo/.claude/worktrees/issue-7";

    for (const argv of [firstTurnArgvOf(TURN, "w-issue-7"), resumedTurnArgvOf(TURN)]) {
      expect(argv[argv.indexOf("--append-system-prompt-file") + 1]).toBe("/repo/AGENTS.md");
      expect(argv.some((word) => word.startsWith(worktree))).toBe(false);
    }
  });

  test("a turn whose model is not known names none", () => {
    expect(resumedTurnArgvOf({ ...TURN, model: null })).toEqual(["claude", "-p", "--resume", "S1", ...TAIL]);
  });
});
