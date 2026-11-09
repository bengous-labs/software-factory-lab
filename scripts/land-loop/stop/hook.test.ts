import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { decodeJson } from "../../lib/json.ts";
import { pushArgs } from "../lib/author.ts";
import type { ReviewCall, ReviewSession, SessionAnswer } from "../ports/review.ts";
import type { Ran, Run, RunOptions } from "../ports/run.ts";
import { promptOf } from "../review/review-prompt.ts";
import { OUTPUT_SCHEMA } from "../review/review-report.ts";
import type { StructuredReport } from "../review/review-report.ts";
import { FORK_MARKER, localReviewOf, localReviewReason } from "./decide.ts";
import type { LocalReviewRecord } from "./decide.ts";
import {
  BODY_REQUEST,
  DONE_QUESTION,
  doneJudgeFailure,
  FORK_FLAG,
  forkResultOf,
  hasForkMarker,
  linesOf,
  ListedPrs,
  modelOf,
  prTextOf,
  stop,
  StopInput,
} from "./hook.ts";
import type { StopLogRecord } from "./hook.ts";

const HEAD = "d".repeat(40);

const TOKEN = "t0k";

function tokenFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "author-")), "author-token");
  writeFileSync(path, `${TOKEN}\n`);

  return path;
}

const TOKEN_ENV = { LAB_AUTHOR_TOKEN_FILE: tokenFile() };

interface Call {
  readonly argv: readonly string[];
  readonly options: RunOptions;
}

const ok = (stdout: string): Promise<Ran> => Promise.resolve({ code: 0, stdout, stderr: "" });

interface World {
  readonly run: Run;
  readonly calls: readonly Call[];
  readonly root: string;
}

const NO_SESSION: ReviewSession = () => {
  throw new Error("no local review session in this test");
};

const FACTORY_CONFIG = readFileSync(
  resolve(import.meta.dir, "..", "..", "..", ".github", "software-factory.json"),
  "utf8",
);

const BASE = "b".repeat(40);

/** The fake's say on the session and the branch: the Done judge's answer, the PRs listed, the diff's paths, the commits, the PR's body. */
interface Fake {
  readonly doneJudgeAnswer: string;
  readonly listed: string;
  readonly branch: string;
  readonly forkBody: string;
  readonly paths: readonly string[];
  readonly heads: readonly string[];
  readonly prBody: string;
}

/** A fake of git, gh, bun and claude for the Author's session on `branch`, one commit ahead, with the PRs `listed`. */
function world(doneJudgeAnswer: string, listed = "[]", branch = "agent/x", forkBody = "Body text."): World {
  return worldOf({ doneJudgeAnswer, listed, branch, forkBody });
}

function worldOf(fake: Partial<Fake>): World {
  const {
    doneJudgeAnswer = "YES",
    listed = "[]",
    branch = "agent/x",
    forkBody = "Body text.",
    paths = [],
    heads = [HEAD],
    prBody = "Intro.\n\nCloses #66",
  } = fake;

  const root = mkdtempSync(join(tmpdir(), "stop-"));
  const calls: Call[] = [];

  const exact = new Map([
    ["git rev-parse --show-toplevel", `${root}\n`],
    ["git symbolic-ref --short -q HEAD", `${branch}\n`],
    ["git rev-parse HEAD", `${HEAD}\n`],
    ["git status --porcelain", ""],
    ["git diff --name-only --no-renames origin/dev...HEAD", `${paths.join("\n")}\n`],
    ["git show origin/dev:.github/software-factory.json", FACTORY_CONFIG],
    ["git show origin/dev:REVIEW.md", "# Review guide\n"],
    ["git show origin/dev:AGENTS.md", "# Project\n"],
    ["git merge-base origin/dev HEAD", `${BASE}\n`],
    ["git rev-list --reverse origin/dev..HEAD", `${heads.join("\n")}\n`],
    ["gh pr view 12 --json body", JSON.stringify({ body: prBody })],
  ]);

  const run: Run = (argv, options) => {
    calls.push({ argv, options });
    const line = argv.join(" ");
    const known = exact.get(line);

    if (known !== undefined) {
      return ok(known);
    }

    if (line.startsWith("git rev-list --count")) {
      return ok("1\n");
    }

    if (line.startsWith("git log -1")) {
      return ok("feat: x\n");
    }

    if (line.startsWith("gh pr list")) {
      return ok(listed);
    }

    if (line.startsWith("gh pr create")) {
      return ok("https://github.com/o/r/pull/12\n");
    }

    if (argv[0] === "claude") {
      const prompt = argv.at(-1) ?? "";
      const result = prompt === DONE_QUESTION ? doneJudgeAnswer : `feat: x\n\n${forkBody}`;

      return ok(
        JSON.stringify({
          result,
          modelUsage: {
            "claude-haiku-5-5": {
              inputTokens: 2,
              outputTokens: 4,
              cacheReadInputTokens: 9000,
              cacheCreationInputTokens: 700,
            },
          },
        }),
      );
    }

    return ok("");
  };

  return { run, calls, root };
}

function input(root: string): StopInput {
  const transcript = join(root, "t.jsonl");
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { content: "add a clear command" } }),
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n"),
  );

  return { session_id: "S1", transcript_path: transcript, cwd: root };
}

/** The body `gh pr create` reads on stdin when the hook opens the PR from `branch` with the fork's `forkBody`. */
async function bodyOf(branch: string, forkBody: string): Promise<string | undefined> {
  const { run, calls, root } = world("YES", "[]", branch, forkBody);
  await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, () => {});

  return calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.options.stdin;
}

/** The publishing calls in their order, from the push on, as argv lines with their env and stdin. */
function publishing(calls: readonly Call[]): Array<[string, RunOptions["env"], string | undefined]> {
  return calls.flatMap((call): Array<[string, RunOptions["env"], string | undefined]> => {
    if (call.argv.includes("push")) {
      return [["push", call.options.env, undefined]];
    }

    if (!/^gh pr (create|edit|comment|ready)/u.test(call.argv.join(" "))) {
      return [];
    }

    return [
      [
        call.argv.slice(0, 4).join(" "),
        call.options.env,
        call.argv.includes("create") ? undefined : call.options.stdin,
      ],
    ];
  });
}

const REPO = resolve(import.meta.dir, "..", "..", "..");

const FORK_SETTINGS = `{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"bun \\"${REPO}/scripts/land-loop/stop/fork-guard.ts\\"","timeout":30}]}]}}`;

/** The command line of the Target for a fork asked `prompt` on the session's model. */
const forkArgv = (prompt: string): readonly string[] => [
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
  FORK_SETTINGS,
  "--strict-mcp-config",
  "--output-format",
  "json",
  "--model",
  "claude-haiku-5-5",
  prompt,
];

describe("stop", () => {
  test("each fork reads with Read, Grep, Glob and Bash under the fork guard, never Monitor", async () => {
    const { run, calls, root } = world("YES");
    await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, () => {});

    const forks = calls.filter((call) => call.argv[0] === "claude").map((call) => call.argv);

    expect(forks).toEqual([forkArgv(DONE_QUESTION), forkArgv(BODY_REQUEST)]);
    expect(forks.every((argv) => !(argv[argv.indexOf("--tools") + 1] ?? "").includes("Monitor"))).toBe(true);
  });

  test("the done-judge and body-fork lines log the tokens of each fork", async () => {
    const records: StopLogRecord[] = [];
    const { run, root } = world("YES");
    await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, (record) => {
      records.push(record);
    });

    for (const step of ["done-judge", "body-fork"]) {
      expect(records.find((record) => record.step === step)).toMatchObject({
        tokens: { input: 2, output: 4, cacheRead: 9000, cacheCreation: 700 },
      });
      expect(Object.keys(records.find((record) => record.step === step) ?? {})).not.toContain("costUsd");
    }
  });

  test("a finished task: the Done judge's fork runs on the session's model with the flag, then the branch is pushed and the PR opened", async () => {
    const { run, calls, root } = world("YES, done and tested.");
    const outcome = await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, () => {});

    const doneJudge = calls.find((call) => call.argv[0] === "claude" && call.argv.at(-1) === DONE_QUESTION);

    expect(doneJudge?.argv).toEqual(forkArgv(DONE_QUESTION));
    expect(doneJudge?.options.env?.[FORK_FLAG]).toBe("1");
    expect(doneJudge?.options.cwd).toBe(root);
    expect(calls.some((call) => call.argv.join(" ") === pushArgs("agent/x").join(" "))).toBe(true);

    const create = calls.find((call) => call.argv.join(" ").startsWith("gh pr create"));

    // oxlint-disable-next-line typescript/no-unsafe-argument -- bun-types types every asymmetric matcher as any.
    expect(create?.argv).toEqual(expect.arrayContaining(["--base", "dev", "--title", "feat: x"]));
    expect(create?.options.stdin).toBe("Body text.");
    expect(outcome.kind).toBe("block");
    expect(outcome.kind === "block" && outcome.reason).toContain("PR #12 is ready");
    expect(outcome.kind === "block" && outcome.reason).toContain(`bun ${root}/scripts/land-loop/pr-watch.ts 12`);
    expect(outcome.kind === "block" && outcome.reason).toContain(
      `\`bun ${root}/scripts/land-loop/thread.ts <thread-id> `,
    );
    expect(outcome.kind === "block" && outcome.reason).toContain(`\`bun ${root}/scripts/land-loop/comment.ts 12 "`);
  });

  test("a branch made for an issue opens a PR whose body ends with its closing line, once", async () => {
    expect(await bodyOf("fix/89-patch-delta-judge", "Body text.")).toBe("Body text.\n\nCloses #89");
    expect(await bodyOf("fix/89-patch-delta-judge", "Body text.\n\nfixes #89")).toBe("Body text.\n\nfixes #89");
    expect(await bodyOf("fix/89-patch-delta-judge", "")).toBe("Closes #89");
    expect(await bodyOf("chore/tidy-docs", "Body text.")).toBe("Body text.");
    expect(await bodyOf("chore/tidy-docs", "")).toBe("(no body)");
  });

  test("the push and every gh call carry the Author's credential; git fetch and the forks do not", async () => {
    const { run, calls, root } = world(
      "YES",
      JSON.stringify([{ number: 12, isDraft: true, headRefOid: "e".repeat(40), labels: [] }]),
    );

    await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, () => {});

    const envOf = (prefix: string): RunOptions["env"] =>
      calls.find((call) => call.argv.join(" ").startsWith(prefix))?.options.env;

    expect(calls.find((call) => call.argv.includes("push"))?.argv).toEqual(pushArgs("agent/x"));
    expect(envOf("git -c")).toEqual({ LAB_AUTHOR_TOKEN: TOKEN });
    expect(envOf("gh pr list")).toEqual({ GH_TOKEN: TOKEN });
    expect(envOf("gh pr ready 12")).toEqual({ GH_TOKEN: TOKEN });
    expect(envOf("git fetch")).toBeUndefined();
    expect(calls.filter((call) => call.argv[0] === "claude").map((call) => call.options.env)).toEqual([
      { [FORK_FLAG]: "1" },
    ]);

    const opened = world("YES");
    await stop(
      input(opened.root),
      { run: opened.run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION },
      () => {},
    );

    expect(opened.calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.options.env).toEqual({
      GH_TOKEN: TOKEN,
    });
    expect(opened.calls.filter((call) => call.argv[0] === "claude").map((call) => call.options.env)).toEqual([
      { [FORK_FLAG]: "1" },
      { [FORK_FLAG]: "1" },
    ]);
  });

  test("no Author token: the hook blocks once with the reason, then lets the session end, and runs no Stop check, fork or push", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "author-")), "absent");
    const records: StopLogRecord[] = [];
    const first = world("YES");

    const blocked = await stop(
      input(first.root),
      { run: first.run, env: { LAB_AUTHOR_TOKEN_FILE: missing }, now: () => 0, reviewSession: NO_SESSION },
      (record) => {
        records.push(record);
      },
    );

    expect(blocked).toEqual({
      kind: "block",
      reason: `The Stop hook found no Author token at ${missing}, so nothing was published. The Owner provisions it (AGENTS.md, Identities). Stop, and ask no question.`,
    });
    expect(records).toContainEqual({ step: "author-token", found: false, path: missing });

    const second = world("YES");

    const ended = await stop(
      { ...input(second.root), stop_hook_active: true },
      { run: second.run, env: { LAB_AUTHOR_TOKEN_FILE: missing }, now: () => 0, reviewSession: NO_SESSION },
      () => {},
    );

    expect(ended).toEqual({ kind: "allow" });

    for (const { calls } of [first, second]) {
      expect(
        calls.some((call) => call.argv[0] === "claude" || call.argv[0] === "bun" || call.argv.includes("push")),
      ).toBe(false);
    }
  });

  test("a token found is logged with its path", async () => {
    const records: StopLogRecord[] = [];
    const { run, root } = world("YES");
    await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, (record) => {
      records.push(record);
    });

    expect(records).toContainEqual({ step: "author-token", found: true, path: TOKEN_ENV.LAB_AUTHOR_TOKEN_FILE });
  });

  test("a PR ready at HEAD and not armed yet: the hook asks to arm its PR watch, naming the PR in its commands, and pushes nothing", async () => {
    const { run, calls, root } = world(
      "YES",
      JSON.stringify([{ number: 12, isDraft: false, headRefOid: HEAD, labels: [] }]),
    );

    const outcome = await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, () => {});

    expect(outcome.kind === "block" && outcome.reason).toContain(`bun ${root}/scripts/land-loop/pr-watch.ts 12`);
    expect(outcome.kind === "block" && outcome.reason).toContain(
      `\`bun ${root}/scripts/land-loop/thread.ts <thread-id> `,
    );
    expect(outcome.kind === "block" && outcome.reason).toContain(
      `\`bun ${root}/scripts/land-loop/thread.ts <thread-id> --reject "<your reason>"\``,
    );
    expect(outcome.kind === "block" && outcome.reason).toContain(
      '- A finding you fix in part: it is a fix; start with "Fixed in <sha>: " and name what stays as is.',
    );
    expect(outcome.kind === "block" && outcome.reason).toContain(`\`bun ${root}/scripts/land-loop/comment.ts 12 "`);
    expect(calls.some((call) => call.argv[1] === "push")).toBe(false);
  });

  test("a stop that asks the Owner a question: the Done judge says NO and nothing is pushed", async () => {
    const { run, calls, root } = world("NO, I asked the Owner which command to add.");
    const outcome = await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, () => {});

    expect(outcome).toEqual({ kind: "allow" });
    expect(calls.some((call) => call.argv[1] === "push")).toBe(false);
  });

  test("the Done judge's question asks for YES, NO, or YES, HOLD: with a reason", () => {
    expect(DONE_QUESTION).toBe(
      `${FORK_MARKER} Stop hook question, not the Owner's: is your current change finished and committed, with no question pending for the Owner? Watching the pull request is the Land loop's job, not part of this answer. Answer YES or NO, then a reason. When it is finished but a human should read it before it lands, answer YES, HOLD: and the reason instead: for example a change to a name or a format stored outside the code, or to a setting the Owner must change on GitHub.`,
    );
  });

  const REASON = "renames the agent-review check, which the dev ruleset requires";

  const COMMENT = `Held for the Owner by the Author: ${REASON}\n\n<!-- lab-author-reply -->`;

  test("a hold on the open path: the PR opens as a draft, gets the label and the comment with the Author's credential, then is readied", async () => {
    const records: StopLogRecord[] = [];
    const { run, calls, root } = world(`YES, HOLD: ${REASON}`);

    const outcome = await stop(
      input(root),
      { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION },
      (record) => {
        records.push(record);
      },
    );

    expect(publishing(calls)).toEqual([
      ["push", { LAB_AUTHOR_TOKEN: TOKEN }, undefined],
      ["gh pr create --base", { GH_TOKEN: TOKEN }, undefined],
      ["gh pr edit 12", { GH_TOKEN: TOKEN }, undefined],
      ["gh pr comment 12", { GH_TOKEN: TOKEN }, COMMENT],
      ["gh pr ready 12", { GH_TOKEN: TOKEN }, undefined],
    ]);
    expect(calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.argv.at(-1)).toBe("--draft");
    expect(calls.find((call) => call.argv.join(" ").startsWith("gh pr edit"))?.argv).toEqual([
      "gh",
      "pr",
      "edit",
      "12",
      "--add-label",
      "land:human",
    ]);
    expect(calls.find((call) => call.argv.join(" ").startsWith("gh pr comment"))?.argv).toEqual([
      "gh",
      "pr",
      "comment",
      "12",
      "--body-file",
      "-",
    ]);
    expect(records).toContainEqual({ step: "hold", pr: 12, reason: REASON, added: true });
    expect(outcome.kind === "block" && outcome.reason.split("\n")[1]).toBe(
      `The Done judge held this PR for the Owner's read: ${REASON}. Do not remove land:human.`,
    );
  });

  test("a label that fails on a held PR just opened leaves it a draft, and the next stop asks the Done judge again", async () => {
    const { run, calls, root } = world(`YES, HOLD: ${REASON}`);

    const labelFails: Run = (argv, options) =>
      argv.join(" ").startsWith("gh pr edit")
        ? Promise.resolve({ code: 1, stdout: "", stderr: "HTTP 502" })
        : run(argv, options);

    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types rejects matchers as void; Bun returns the promise the test awaits.
    await expect(
      stop(input(root), { run: labelFails, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, () => {}),
    ).rejects.toThrow("HTTP 502");
    expect(calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.argv.at(-1)).toBe("--draft");
    expect(calls.some((call) => /^gh pr (comment|ready)/u.test(call.argv.join(" ")))).toBe(false);

    const next = world(
      `YES, HOLD: ${REASON}`,
      JSON.stringify([{ number: 12, isDraft: true, headRefOid: HEAD, labels: [] }]),
    );

    await stop(input(next.root), { run: next.run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, () => {});

    expect(next.calls.some((call) => call.argv[0] === "claude" && call.argv.at(-1) === DONE_QUESTION)).toBe(true);
    expect(publishing(next.calls).map(([line]) => line)).toEqual([
      "gh pr edit 12",
      "gh pr comment 12",
      "push",
      "gh pr ready 12",
    ]);
  });

  test("a hold on the push path: the label, then the comment, go out before the push and gh pr ready", async () => {
    const records: StopLogRecord[] = [];

    const { run, calls, root } = world(
      "YES, HOLD:",
      JSON.stringify([{ number: 12, isDraft: true, headRefOid: "e".repeat(40), labels: [{ name: "enhancement" }] }]),
    );

    await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, (record) => {
      records.push(record);
    });

    expect(publishing(calls)).toEqual([
      ["gh pr edit 12", { GH_TOKEN: TOKEN }, undefined],
      [
        "gh pr comment 12",
        { GH_TOKEN: TOKEN },
        "Held for the Owner by the Author: (no reason given)\n\n<!-- lab-author-reply -->",
      ],
      ["push", { LAB_AUTHOR_TOKEN: TOKEN }, undefined],
      ["gh pr ready 12", { GH_TOKEN: TOKEN }, undefined],
    ]);
    expect(calls.find((call) => call.argv.join(" ").startsWith("gh pr edit"))?.argv).toEqual([
      "gh",
      "pr",
      "edit",
      "12",
      "--add-label",
      "land:human",
    ]);
    expect(records).toContainEqual({ step: "hold", pr: 12, reason: "(no reason given)", added: true });
  });

  test("a hold on a PR that carries land:human already publishes as YES and adds nothing", async () => {
    const records: StopLogRecord[] = [];

    const { run, calls, root } = world(
      `YES, HOLD: ${REASON}`,
      JSON.stringify([{ number: 12, isDraft: true, headRefOid: "e".repeat(40), labels: [{ name: "land:human" }] }]),
    );

    await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, (record) => {
      records.push(record);
    });

    expect(publishing(calls).map(([line]) => line)).toEqual(["push", "gh pr ready 12"]);
    expect(records).toContainEqual({ step: "hold", pr: 12, reason: REASON, added: false });
  });

  test("a plain YES adds no label and posts no comment", async () => {
    const records: StopLogRecord[] = [];
    const { run, calls, root } = world("YES, done.");

    const outcome = await stop(
      input(root),
      { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION },
      (record) => {
        records.push(record);
      },
    );

    expect(publishing(calls).map(([line]) => line)).toEqual(["push", "gh pr create --base"]);
    expect(calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.argv).not.toContain("--draft");
    expect(records.some((record) => record.step === "hold")).toBe(false);
    expect(outcome.kind === "block" && outcome.reason).not.toContain("held this PR");
  });

  test("a NO with a hold's words publishes nothing", async () => {
    const { run, calls, root } = world("NO, HOLD: not finished");
    const outcome = await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, () => {});

    expect(outcome).toEqual({ kind: "allow" });
    expect(publishing(calls)).toEqual([]);
  });

  test("inside a fork the hook launched, nothing runs past reading HEAD", async () => {
    const { run, calls, root } = world("YES");

    const outcome = await stop(
      input(root),
      { run, env: { [FORK_FLAG]: "1" }, now: () => 0, reviewSession: NO_SESSION },
      () => {},
    );

    expect(outcome).toEqual({ kind: "allow" });
    expect(calls.some((call) => call.argv[0] === "claude" || call.argv[1] === "fetch")).toBe(false);
  });
});

const RISKY = ["scripts/land-loop/stop/hook.ts", "docs/usage.md"];

const RISKY_ENV = { ...TOKEN_ENV, PATH: "/usr/bin", HOME: "/home/author" };

type Reported = (typeof StructuredReport.Type)["findings"][number];

const reported = (severity: Reported["severity"], line: number, summary: string): Reported => ({
  file: "scripts/land-loop/stop/hook.ts",
  line,
  severity,
  summary,
  failure_scenario: `When ${summary}`,
  breaks: null,
});

const TWO_AND_A_NIT = [
  reported("important", 10, "A breaks."),
  reported("nit", 11, "A name."),
  reported("important", 20, "B breaks."),
];

const answered = (findings: readonly Reported[]): SessionAnswer => ({
  kind: "answered",
  structured: { findings },
  model: "claude-opus-5-5",
  claudeCodeVersion: "9.9.9",
  tokens: { input: 5, output: 7, cacheRead: 0, cacheCreation: 0 },
});

interface FakeSession {
  readonly session: ReviewSession;
  readonly calls: ReviewCall[];
  /** How many `run` calls each session call came after. */
  readonly after: number[];
}

function fakeSession(answer: SessionAnswer, runCalls: readonly Call[]): FakeSession {
  const calls: ReviewCall[] = [];
  const after: number[] = [];

  return {
    session: (call) => {
      calls.push(call);
      after.push(runCalls.length);

      return Promise.resolve(answer);
    },
    calls,
    after,
  };
}

const stateOf = (root: string): string => join(root, ".lab", "state");

const recordOf = (root: string): LocalReviewRecord => {
  const file = join(stateOf(root), `review-${HEAD}.json`);

  return localReviewOf(file, readFileSync(file, "utf8"));
};

const DRAFT_PR = JSON.stringify([{ number: 12, isDraft: true, headRefOid: "e".repeat(40), labels: [] }]);

describe("the local review", () => {
  test("a risky stop with a Done judge YES runs one deep review session with the call of the Target, before any push", async () => {
    const { run, calls, root } = worldOf({ branch: "feat/66-x", paths: RISKY });
    const fake = fakeSession(answered([]), calls);
    await stop(input(root), { run, env: RISKY_ENV, now: () => 0, reviewSession: fake.session }, () => {});

    const [call] = fake.calls;
    const real = realpathSync(root);

    expect(fake.calls).toHaveLength(1);
    expect(call).toMatchObject({
      prompt: promptOf(
        { pr: 0, head: HEAD, base: BASE, patch: "local", round: 1, model: "opus", effort: "high", security: false },
        { review: "# Review guide\n", project: "# Project\n" },
        [],
      ),
      cwd: real,
      model: "opus",
      effort: "high",
      outputSchema: OUTPUT_SCHEMA,
      timeoutMs: 600_000,
      env: { PATH: "/usr/bin", HOME: "/home/author", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    });
    expect(call?.guard("Write", { file_path: join(real, "a.ts") }).kind).toBe("deny");
    expect(call?.guard("Glob", { pattern: "*.ts" }).kind).toBe("allow");
    expect(calls.slice(0, fake.after[0]).some((ran) => ran.argv.includes("push"))).toBe(false);
    expect(calls.some((ran) => ran.argv.includes("push"))).toBe(true);
  });

  test("the session gets the Author's Claude Code credential from the environment when one is set", async () => {
    const { run, calls, root } = worldOf({ paths: RISKY });
    const fake = fakeSession(answered([]), calls);
    const env = { ...RISKY_ENV, CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "key", OTHER: "x" };
    await stop(input(root), { run, env, now: () => 0, reviewSession: fake.session }, () => {});

    expect(fake.calls[0]?.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/author",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      ANTHROPIC_API_KEY: "key",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
  });

  test("a new head's review gets the earlier heads' answered Importants, so a rejection carries forward", async () => {
    const old = "a".repeat(40);
    const { run, calls, root } = worldOf({ paths: RISKY, heads: [old, HEAD] });
    mkdirSync(stateOf(root), { recursive: true });
    writeFileSync(
      join(stateOf(root), `review-${old}.json`),
      JSON.stringify({
        findings: [
          { file: "a.ts", line: 1, severity: "important", summary: "Off by one.", failureScenario: "x" },
          { file: "b.ts", line: null, severity: "important", summary: "Blank.", failureScenario: "y" },
        ],
        model: null,
        tokens: null,
      }),
    );
    writeFileSync(join(stateOf(root), `review-${old}-answers.json`), JSON.stringify({ "2": "Rejected: kept" }));

    const fake = fakeSession(answered([]), calls);
    await stop(input(root), { run, env: RISKY_ENV, now: () => 0, reviewSession: fake.session }, () => {});

    expect(fake.calls[0]?.prompt).toEndWith(
      `This is review round 1. A local review in the author's session read this change first. Its findings and the author's answers:\n- a.ts:1: Off by one. | Author: Fixed in ${HEAD.slice(0, 7)}\n- b.ts: Blank. | Author: Rejected: kept\nReport only what is wrong now. Never report again a finding the author resolved with a valid reason, nor one already open.`,
    );
  });

  test("a partial answer right after a block blocks again with what is left; no further answer then ends the session", async () => {
    const { run, calls, root } = worldOf({ paths: RISKY });
    const fake = fakeSession(answered(TWO_AND_A_NIT), calls);
    const deps = { run, env: RISKY_ENV, now: () => 0, reviewSession: fake.session };

    await stop(input(root), deps, () => {});
    writeFileSync(join(stateOf(root), `review-${HEAD}-answers.json`), JSON.stringify({ "1": "Rejected: a" }));

    const partial = await stop({ ...input(root), stop_hook_active: true }, deps, () => {});
    const idle = await stop({ ...input(root), stop_hook_active: true }, deps, () => {});

    expect(partial.kind === "block" && partial.reason).toStartWith("The local review found 1 Important finding(s)");
    expect(partial.kind === "block" && partial.reason).toContain("\n2. scripts/land-loop/stop/hook.ts:20: B breaks.");
    expect(idle).toEqual({ kind: "allow" });
    expect(readFileSync(join(stateOf(root), `review-${HEAD}-shown.json`), "utf8")).toBe("[2]\n");
    expect(publishing(calls)).toEqual([]);
  });

  test("a review run in this stop ignores a shown record an earlier run left, and blocks with its findings", async () => {
    const { run, calls, root } = worldOf({ paths: RISKY });
    mkdirSync(stateOf(root), { recursive: true });
    writeFileSync(join(stateOf(root), `review-${HEAD}-shown.json`), "[1,2]\n");

    const fake = fakeSession(answered(TWO_AND_A_NIT), calls);
    const deps = { run, env: RISKY_ENV, now: () => 0, reviewSession: fake.session };
    const outcome = await stop({ ...input(root), stop_hook_active: true }, deps, () => {});

    expect(fake.calls).toHaveLength(1);
    expect(outcome.kind === "block" && outcome.reason).toStartWith("The local review found 2 Important finding(s)");
  });

  test("a stop that follows no block forgets the shown record, so a later turn shows the findings again", async () => {
    const { run, calls, root } = worldOf({ doneJudgeAnswer: "", paths: RISKY });
    const shownFile = join(stateOf(root), `review-${HEAD}-shown.json`);
    const deps = { run, env: RISKY_ENV, now: () => 0, reviewSession: fakeSession(answered([]), calls).session };
    mkdirSync(stateOf(root), { recursive: true });
    writeFileSync(shownFile, "[1,2]\n");

    await stop({ ...input(root), stop_hook_active: true }, deps, () => {});

    expect(existsSync(shownFile)).toBe(true);

    await stop(
      { ...input(root), stop_hook_active: false },
      { ...deps, env: { ...RISKY_ENV, [FORK_FLAG]: "1" } },
      () => {},
    );

    expect(existsSync(shownFile)).toBe(true);

    const blocked = await stop(input(root), deps, () => {});

    expect(blocked.kind).toBe("block");
    expect(existsSync(shownFile)).toBe(false);
  });

  test("a new head reviewed right after a block still shows its Importants once, then lets the session end", async () => {
    const { run, calls, root } = worldOf({ paths: RISKY });
    const fake = fakeSession(answered(TWO_AND_A_NIT), calls);
    const deps = { run, env: RISKY_ENV, now: () => 0, reviewSession: fake.session };

    const first = await stop({ ...input(root), stop_hook_active: true }, deps, () => {});
    const second = await stop({ ...input(root), stop_hook_active: true }, deps, () => {});

    expect(first.kind === "block" && first.reason).toStartWith("The local review found 2 Important finding(s)");
    expect(second).toEqual({ kind: "allow" });
    expect(fake.calls).toHaveLength(1);
    expect(publishing(calls)).toEqual([]);
  });

  test("a non-risky stop, a Done judge NO, and a head already reviewed run no session", async () => {
    const plain = worldOf({ paths: ["app/src/commands/add.ts", "docs/usage.md"] });
    const no = worldOf({ doneJudgeAnswer: "NO, a question is pending", paths: RISKY });
    const reviewed = worldOf({ paths: RISKY });
    mkdirSync(stateOf(reviewed.root), { recursive: true });
    writeFileSync(
      join(stateOf(reviewed.root), `review-${HEAD}.json`),
      JSON.stringify({ findings: [], model: null, tokens: null }),
    );

    for (const { run, calls, root } of [plain, no, reviewed]) {
      const fake = fakeSession(answered([]), calls);
      await stop(input(root), { run, env: RISKY_ENV, now: () => 0, reviewSession: fake.session }, () => {});

      expect(fake.calls).toHaveLength(0);
    }

    expect(publishing(plain.calls).map(([line]) => line)).toEqual(["push", "gh pr create --base"]);
    expect(publishing(no.calls)).toEqual([]);
    expect(publishing(reviewed.calls).map(([line]) => line)).toEqual(["push", "gh pr create --base"]);
  });

  test("an unanswered Important blocks with the text and writes the record; stop_hook_active then allows, a fresh stop blocks again", async () => {
    const { run, calls, root } = worldOf({ paths: RISKY });
    const fake = fakeSession(answered(TWO_AND_A_NIT), calls);
    const deps = { run, env: RISKY_ENV, now: () => 0, reviewSession: fake.session };

    const first = await stop(input(root), deps, () => {});
    const record = recordOf(root);

    expect(record).toEqual({
      findings: [
        {
          file: "scripts/land-loop/stop/hook.ts",
          line: 10,
          severity: "important",
          summary: "A breaks.",
          failureScenario: "When A breaks.",
        },
        {
          file: "scripts/land-loop/stop/hook.ts",
          line: 11,
          severity: "nit",
          summary: "A name.",
          failureScenario: "When A name.",
        },
        {
          file: "scripts/land-loop/stop/hook.ts",
          line: 20,
          severity: "important",
          summary: "B breaks.",
          failureScenario: "When B breaks.",
        },
      ],
      model: "claude-opus-5-5",
      tokens: { input: 5, output: 7, cacheRead: 0, cacheCreation: 0 },
    });
    expect(first).toEqual({
      kind: "block",
      reason: localReviewReason(record, {}, `bun ${join(root, "scripts", "land-loop", "local-review.ts")}`),
    });

    const active = await stop({ ...input(root), stop_hook_active: true }, deps, () => {});
    const fresh = await stop(input(root), deps, () => {});

    expect(active).toEqual({ kind: "allow" });
    expect(fresh).toEqual(first);
    expect(fake.calls).toHaveLength(1);
    expect(publishing(calls)).toEqual([]);
  });

  test("a rejection of every Important publishes; a new head is reviewed again", async () => {
    const { run, calls, root } = worldOf({ branch: "feat/66-x", paths: RISKY });
    const fake = fakeSession(answered(TWO_AND_A_NIT), calls);
    const deps = { run, env: RISKY_ENV, now: () => 0, reviewSession: fake.session };

    await stop(input(root), deps, () => {});
    writeFileSync(
      join(stateOf(root), `review-${HEAD}-answers.json`),
      JSON.stringify({ "1": "Rejected: a", "2": "Rejected: b" }),
    );
    const outcome = await stop(input(root), deps, () => {});

    expect(outcome.kind === "block" && outcome.reason).toContain("PR #12 is ready for review.");
    expect(publishing(calls).map(([line]) => line)).toEqual(["push", "gh pr create --base"]);

    const next = worldOf({ branch: "feat/66-x", paths: RISKY });
    mkdirSync(stateOf(next.root), { recursive: true });
    writeFileSync(
      join(stateOf(next.root), `review-${"c".repeat(40)}.json`),
      JSON.stringify({ findings: [], model: null, tokens: null }),
    );
    const again = fakeSession(answered([]), next.calls);
    await stop(input(next.root), { ...deps, run: next.run, reviewSession: again.session }, () => {});

    expect(again.calls.map((call) => call.prompt.split("\n")[0])).toEqual([
      `/code-review high --max-findings all ${BASE}...${HEAD}`,
    ]);
  });

  test("a failed session blocks once with its error and writes nothing; a second stop with stop_hook_active allows and publishes nothing", async () => {
    const { run, calls, root } = worldOf({ paths: RISKY });

    const failed: SessionAnswer = {
      kind: "failed",
      error: "timed out after 600000 ms",
      model: null,
      claudeCodeVersion: null,
      tokens: null,
    };

    const fake = fakeSession(failed, calls);
    const deps = { run, env: RISKY_ENV, now: () => 0, reviewSession: fake.session };

    expect(await stop(input(root), deps, () => {})).toEqual({
      kind: "block",
      reason:
        "The local review could not run (timed out after 600000 ms), so nothing was published. Stop again to retry; ask no question.",
    });
    expect(existsSync(join(stateOf(root), `review-${HEAD}.json`))).toBe(false);
    expect(await stop({ ...input(root), stop_hook_active: true }, deps, () => {})).toEqual({ kind: "allow" });
    expect(publishing(calls)).toEqual([]);
  });

  test("the block goes in the body on gh pr create, before the closing line", async () => {
    const { run, calls, root } = worldOf({ branch: "feat/66-x", paths: RISKY });
    const fake = fakeSession(answered([reported("nit", 3, "A name.")]), calls);
    await stop(input(root), { run, env: RISKY_ENV, now: () => 0, reviewSession: fake.session }, () => {});

    const body = calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.options.stdin;

    expect(body).toBe(
      `Body text.\n\n<!-- lab-local-review -->\nLocal review (deep, ${HEAD.slice(0, 7)}): 0 Important fixed, 0 rejected, 1 Nit.\n<details><summary>Findings</summary>\n\n</details>\n<!-- /lab-local-review -->\n\nCloses #66`,
    );
  });

  test("on an existing PR the block is edited in the body in place before the push, so a review the push starts reads it", async () => {
    const old = "a".repeat(40);

    const { run, calls, root } = worldOf({
      listed: DRAFT_PR,
      branch: "feat/66-x",
      paths: RISKY,
      heads: [old, HEAD],
      prBody: "Intro.\n\n<!-- lab-local-review -->\nstale\n<!-- /lab-local-review -->\n\nCloses #66",
    });

    mkdirSync(stateOf(root), { recursive: true });
    writeFileSync(
      join(stateOf(root), `review-${old}.json`),
      JSON.stringify({
        findings: [
          { file: "a.ts", line: 1, severity: "important", summary: "Off by one.", failureScenario: "x" },
          { file: "b.ts", line: null, severity: "important", summary: "Blank.", failureScenario: "y" },
        ],
        model: null,
        tokens: null,
      }),
    );
    writeFileSync(join(stateOf(root), `review-${old}-answers.json`), JSON.stringify({ "2": "Rejected: kept" }));
    const fake = fakeSession(answered([]), calls);
    await stop(input(root), { run, env: RISKY_ENV, now: () => 0, reviewSession: fake.session }, () => {});

    expect(publishing(calls)).toEqual([
      [
        "gh pr edit 12",
        { GH_TOKEN: TOKEN },
        `Intro.\n\n<!-- lab-local-review -->\nLocal review (deep, ${HEAD.slice(0, 7)}): 1 Important fixed, 1 rejected, 0 Nit.\n<details><summary>Findings</summary>\n\n- a.ts:1: Off by one. | Author: Fixed in ${HEAD.slice(0, 7)}\n- b.ts: Blank. | Author: Rejected: kept\n</details>\n<!-- /lab-local-review -->\n\nCloses #66`,
      ],
      ["push", { LAB_AUTHOR_TOKEN: TOKEN }, undefined],
      ["gh pr ready 12", { GH_TOKEN: TOKEN }, undefined],
    ]);
  });

  test("a branch with no local review writes no block and reads no body", async () => {
    const { run, calls, root } = world("YES", DRAFT_PR, "feat/66-x");
    await stop(input(root), { run, env: TOKEN_ENV, now: () => 0, reviewSession: NO_SESSION }, () => {});

    expect(calls.some((call) => /^gh pr (view|edit)/u.test(call.argv.join(" ")))).toBe(false);
  });

  test("each session logs one local-review record with its counts, its latency and its tokens", async () => {
    const { run, calls, root } = worldOf({ paths: RISKY });
    const fake = fakeSession(answered([...TWO_AND_A_NIT, reported("pre_existing", 1, "Old.")]), calls);
    let clock = 0;
    const records: StopLogRecord[] = [];
    await stop(
      input(root),
      {
        run,
        env: RISKY_ENV,
        now: () => {
          clock += 1000;

          return clock;
        },
        reviewSession: fake.session,
      },
      (record) => {
        records.push(record);
      },
    );

    expect(records.filter((record) => record.step === "local-review")).toEqual([
      {
        step: "local-review",
        head: HEAD,
        paths: 1,
        ms: 1000,
        model: "claude-opus-5-5",
        tokens: { input: 5, output: 7, cacheRead: 0, cacheCreation: 0 },
        important: 2,
        nit: 1,
        preExisting: 1,
        unanswered: 2,
        nits: ["scripts/land-loop/stop/hook.ts:11: A name."],
      },
    ]);
  });

  test("a session without PATH or HOME to pass throws, naming the variable", async () => {
    const { run, calls, root } = worldOf({ paths: RISKY });
    const fake = fakeSession(answered([]), calls);
    const deps = { run, env: TOKEN_ENV, now: () => 0, reviewSession: fake.session };

    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types rejects matchers as void; Bun returns the promise the test awaits.
    await expect(stop(input(root), deps, () => {})).rejects.toThrow("PATH is unset");
  });
});

describe("transcript", () => {
  test("a user turn opening with the marker makes the session a fork; the marker elsewhere does not", () => {
    expect(hasForkMarker([{ type: "user", message: { content: `${FORK_MARKER} are you done?` } }])).toBe(true);
    expect(hasForkMarker([{ type: "user", message: { content: [{ text: ` ${FORK_MARKER} q` }] } }])).toBe(true);
    expect(hasForkMarker([{ type: "user", message: { content: `the spec names ${FORK_MARKER}` } }])).toBe(false);
    expect(hasForkMarker([{ type: "assistant", message: { content: `${FORK_MARKER} q` } }])).toBe(false);
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
});

describe("forkResultOf", () => {
  test("reads the answer and the tokens of every model `claude -p --output-format json` prints", () => {
    expect(
      forkResultOf(
        JSON.stringify({
          result: "YES",
          modelUsage: {
            "claude-haiku-5-5": {
              inputTokens: 1,
              outputTokens: 2,
              cacheReadInputTokens: 5,
              cacheCreationInputTokens: 3,
            },
            "claude-opus-5-5": {
              inputTokens: 10,
              outputTokens: 20,
              cacheReadInputTokens: 50,
              cacheCreationInputTokens: 30,
            },
          },
        }),
        0,
        9,
      ),
    ).toEqual({
      text: "YES",
      ms: 9,
      tokens: { input: 11, output: 22, cacheRead: 55, cacheCreation: 33 },
      code: 0,
      unreadable: null,
    });
    expect(forkResultOf(JSON.stringify({ result: "YES" }), 0, 9).tokens).toBeNull();
  });

  test("a modelUsage that does not read loses the tokens, never the answer", () => {
    const partial = { "claude-haiku-5-5": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: null } };

    for (const modelUsage of [partial, "none"]) {
      expect(forkResultOf(JSON.stringify({ result: "YES", modelUsage }), 0, 9)).toEqual({
        text: "YES",
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
      ms: 9,
      tokens: null,
      code: 124,
      unreadable: "Expected a valid JSON string",
    });
    expect(forkResultOf(JSON.stringify({ result: 7 }), 0, 9).unreadable).toBe('Expected string\n  at ["result"]');
  });
});

describe("doneJudgeFailure", () => {
  test("an answer is not a failure", () => {
    expect(doneJudgeFailure(0, "NO, a question is open", false)).toBeNull();
  });

  test("a Done judge killed or silent blocks once, so it is asked again, then lets the session end", () => {
    const blocked = doneJudgeFailure(124, "", false);

    expect(blocked?.kind).toBe("block");
    expect(blocked?.kind === "block" && blocked.reason).toContain("exited 124");
    expect(doneJudgeFailure(0, "  ", false)?.kind).toBe("block");
    expect(doneJudgeFailure(124, "", true)).toEqual({ kind: "allow" });
  });
});

describe("the inputs the Stop hook decodes", () => {
  test("the Stop input reads, with or without stop_hook_active", () => {
    const stdin = { session_id: "S1", transcript_path: "/t.jsonl", cwd: "/repo", hook_event_name: "Stop" };

    expect(decodeJson(StopInput, "the Stop input", JSON.stringify(stdin))).toEqual({
      session_id: "S1",
      transcript_path: "/t.jsonl",
      cwd: "/repo",
    });
    expect(
      decodeJson(StopInput, "the Stop input", JSON.stringify({ ...stdin, stop_hook_active: true })).stop_hook_active,
    ).toBe(true);
  });

  test("a Stop input, or a gh pr list answer, outside its schema is refused", () => {
    expect(() => decodeJson(StopInput, "the Stop input", JSON.stringify({ session_id: "S1", cwd: "/repo" }))).toThrow(
      'the Stop input: Missing key\n  at ["transcript_path"]',
    );
    expect(() => decodeJson(ListedPrs, "gh pr list", JSON.stringify([{ number: 1, isDraft: "no" }]))).toThrow(
      'gh pr list: Expected boolean\n  at [0]["isDraft"]',
    );
  });
});
