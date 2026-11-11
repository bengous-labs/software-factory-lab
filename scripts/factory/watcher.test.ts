import { describe, expect, test } from "bun:test";

import type { Ran, RunOptions } from "../land-loop/ports/run.ts";
import { EMPTY_MEMORY } from "./watch-plan.ts";
import { mainCheckoutOf, watchTurn } from "./watcher.ts";
import type { WatchPorts } from "./watcher.ts";

const NOW = "2026-11-11T16:00:00.000Z";

const PR = {
  number: 9,
  url: "https://github.com/o/r/pull/9",
  state: "MERGED",
  isDraft: false,
  isCrossRepository: false,
  headRefName: "issue/7-add-a-flag",
  headRefOid: "h1",
  mergeable: "UNKNOWN",
  closingIssuesReferences: { nodes: [{ number: 7 }] },
  labels: { nodes: [] },
  comments: { nodes: [] },
  reviewThreads: { nodes: [] },
};

const ANSWER = JSON.stringify({
  data: { repository: { i7: { number: 7, state: "CLOSED", closedByPullRequestsReferences: { nodes: [PR] } }, p9: PR } },
});

const OPEN_ANSWER = JSON.stringify({
  data: { repository: { open: { nodes: [{ ...PR, number: 10, state: "OPEN", headRefOid: "h2" }] } } },
});

const HELD = "Held for the Owner: a path. Waiting for the Owner's Land approval (label land-ok).";

const CHECKS = JSON.stringify({
  check_runs: [
    {
      name: "land-gate",
      status: "in_progress",
      conclusion: null,
      id: 1,
      output: { title: HELD },
      app: { slug: "bengous-labs-agents" },
    },
  ],
});

const CHECKS_PATH = "repos/{owner}/{repo}/commits/h2/check-runs?filter=latest&per_page=100";

const AGENTS = JSON.stringify([{ sessionId: "s-worker", pid: 1, status: "idle" }]);

const LOG =
  '{"at":"t1","session":"s-worker","worktree":"/w","branch":"issue/7-add-a-flag","head":"h1","outcome":"published","pr":9}\n';

interface Call {
  readonly argv: readonly string[];
  readonly options: RunOptions;
}

function world(answers: Partial<Record<string, Ran>> = {}) {
  const calls: Call[] = [];
  const reads: string[] = [];

  const defaults = new Map<string, Ran>([
    ["gh api graphql", { code: 0, stdout: ANSWER, stderr: "" }],
    [`gh api ${CHECKS_PATH}`, { code: 0, stdout: CHECKS, stderr: "" }],
    ["claude agents --json", { code: 0, stdout: AGENTS, stderr: "" }],
    ["git rev-parse --path-format=absolute", { code: 0, stdout: "/repo/.git\n", stderr: "" }],
  ]);

  const ports: WatchPorts = {
    run: (argv, options) => {
      calls.push({ argv, options });
      const command = argv.slice(0, 3).join(" ");
      const ran = answers[command] ?? defaults.get(command);

      return ran === undefined ? Promise.reject(new Error(`unexpected command: ${command}`)) : Promise.resolve(ran);
    },
    readText: (path) => {
      reads.push(path);

      return Promise.resolve(LOG);
    },
  };

  return { ports, calls, reads };
}

describe("watchTurn", () => {
  test("reads GitHub, the sessions and the outcomes log of the main checkout, then prints what changed", async () => {
    const { ports, calls, reads } = world();
    const memory = { printed: [], still: { "9": { mark: "earlier", since: NOW } } };

    const step = await watchTurn(ports, { checkout: "/repo", issues: [7], memory, now: NOW });

    expect(step).toEqual({
      lines: ["PR #9 (issue #7) landed: https://github.com/o/r/pull/9", "Issue #7 is closed."],
      memory: { printed: ["end:9", "closed:7"], still: {} },
      ends: true,
    });
    expect(reads).toEqual(["/repo/.lab/outcomes.log"]);
    expect(calls.map((call) => call.options.cwd)).toEqual(["/repo", "/repo"]);
    expect(calls[0]?.argv.slice(0, 4)).toEqual(["gh", "api", "graphql", "-f"]);
    expect(calls[0]?.argv[4]).toContain("i7:issue(number:7)");
    expect(calls[0]?.argv[4]).toContain("p9:pullRequest(number:9)");
    expect(calls[0]?.argv.slice(5)).toEqual(["-F", "owner={owner}", "-F", "name={repo}"]);
  });

  test("reads the checks of each open PR's head, apart from the PR", async () => {
    const { ports, calls } = world({ "gh api graphql": { code: 0, stdout: OPEN_ANSWER, stderr: "" } });

    const step = await watchTurn(ports, { checkout: "/repo", issues: [], memory: EMPTY_MEMORY, now: NOW });

    expect(step.lines).toEqual([`PR #10 (issue #7), its Land gate: ${HELD} https://github.com/o/r/pull/9`]);
    expect(calls.map((call) => call.argv.slice(0, 3).join(" "))).toEqual([
      "gh api graphql",
      `gh api ${CHECKS_PATH}`,
      "claude agents --json",
    ]);
  });

  test("a command that fails throws, with what it printed", async () => {
    const { ports } = world({ "gh api graphql": { code: 1, stdout: "", stderr: "HTTP 502\n" } });

    expect(await failureOf(watchTurn(ports, { checkout: "/repo", issues: [], memory: EMPTY_MEMORY, now: NOW }))).toBe(
      "gh api graphql exited 1: HTTP 502",
    );
  });
});

/** The message a turn rejects with; it fails the test when the turn resolves. */
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("expected a rejection");
}

describe("mainCheckoutOf", () => {
  test("is the parent of the git common directory, from a worktree as from the main checkout", async () => {
    const { ports, calls } = world();

    expect(await mainCheckoutOf(ports.run, "/repo/.claude/worktrees/issue-7")).toBe("/repo");
    expect(calls[0]?.options.cwd).toBe("/repo/.claude/worktrees/issue-7");
  });
});
