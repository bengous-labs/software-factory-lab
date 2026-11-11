import { expect, test } from "bun:test";

import { runBench } from "./bench.ts";
import type { BenchIo } from "./bench.ts";

interface Launch {
  readonly argv: readonly string[];
  readonly cwd: string;
}

function fakeIo() {
  const launches: Launch[] = [];

  const io = {
    root: "/b",
    settings: "/b/worker-settings.json",
    prepare: (run) => Promise.resolve(`/b/run-${run}`),
    claude: (argv, cwd) => {
      launches.push({ argv, cwd });
      const resumed = argv.includes("--resume");

      return Promise.resolve(
        JSON.stringify({
          type: "result",
          session_id: `s-${cwd.slice(-1)}`,
          result: resumed ? `woken in ${cwd}` : `committed in ${cwd}`,
          is_error: false,
        }),
      );
    },
    transcript: (session) =>
      Promise.resolve(
        JSON.stringify({
          type: "attachment",
          attachment: { type: "nested_memory", path: `/b/run-${session.slice(-1)}/.claude/rules/hooks.md` },
        }),
      ),
  } satisfies BenchIo;

  return { io, launches };
}

test("each run launches a session on the issue in its own clone, and the report reads its transcript", async () => {
  const { io, launches } = fakeIo();

  const report = await runBench(io, {
    issue: "i.md",
    issueText: "## Problem",
    runs: 2,
    model: "haiku",
    wakeText: undefined,
  });

  expect(launches.map((launch) => launch.cwd)).toEqual(["/b/run-1", "/b/run-2"]);
  expect(launches[0]?.argv).toContain("/b/worker-settings.json");
  expect(launches[0]?.argv.at(-1)).toEndWith("## Problem");
  expect(report).toContain("## Run 2, session s-2, in /b/run-2");
  expect(report).toContain("committed in /b/run-1");
  expect(report).toContain("Rules loaded: .claude/rules/hooks.md");
  expect(report).not.toContain("after the Wake");
});

test("a wake resumes each session once with the wake's text", async () => {
  const { io, launches } = fakeIo();

  const report = await runBench(io, {
    issue: "i.md",
    issueText: "x",
    runs: 1,
    model: undefined,
    wakeText: "Fix the check.",
  });

  expect(launches[1]?.argv).toEqual([
    "claude",
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(git *)",
    "Bash(bun *)",
    "--settings",
    "/b/worker-settings.json",
    "--resume",
    "s-1",
    "Fix the check.",
  ]);
  expect(report).toContain("Closing message after the Wake:\nwoken in /b/run-1");
});
