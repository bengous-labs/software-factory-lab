import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeJson } from "../../lib/json.ts";
import { pushArgs } from "../lib/author.ts";
import type { Ran, Run, RunOptions } from "../ports/run.ts";
import { FORK_MARKER } from "./decide.ts";
import {
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

/** A fake of git, gh, bun and claude for the Author's session on `branch`, one commit ahead, with the PRs `listed`. */
function world(doneJudgeAnswer: string, listed = "[]", branch = "agent/x", forkBody = "Body text."): World {
  const root = mkdtempSync(join(tmpdir(), "stop-"));
  const calls: Call[] = [];

  const run: Run = (argv, options) => {
    calls.push({ argv, options });
    const line = argv.join(" ");

    if (line === "git rev-parse --show-toplevel") {
      return ok(`${root}\n`);
    }

    if (line === "git symbolic-ref --short -q HEAD") {
      return ok(`${branch}\n`);
    }

    if (line === "git rev-parse HEAD") {
      return ok(`${HEAD}\n`);
    }

    if (line === "git status --porcelain") {
      return ok("");
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

      return ok(JSON.stringify({ result, total_cost_usd: 0.01, usage: { cache_read_input_tokens: 9000 } }));
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
  await stop(input(root), { run, env: TOKEN_ENV, now: () => 0 }, () => {});

  return calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.options.stdin;
}

describe("stop", () => {
  test("a finished task: the Done judge's fork runs on the session's model with the flag, then the branch is pushed and the PR opened", async () => {
    const { run, calls, root } = world("YES, done and tested.");
    const outcome = await stop(input(root), { run, env: TOKEN_ENV, now: () => 0 }, () => {});

    const doneJudge = calls.find((call) => call.argv[0] === "claude" && call.argv.at(-1) === DONE_QUESTION);

    expect(doneJudge?.argv).toEqual(
      // oxlint-disable-next-line typescript/no-unsafe-argument -- bun-types types every asymmetric matcher as any.
      expect.arrayContaining(["-p", "--resume", "S1", "--fork-session", "--tools", "", "--model", "claude-haiku-5-5"]),
    );
    expect(doneJudge?.options.env?.[FORK_FLAG]).toBe("1");
    expect(doneJudge?.argv[doneJudge.argv.indexOf("--tools") + 1]).toBe("");
    expect(doneJudge?.argv).toContain("--strict-mcp-config");
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
      JSON.stringify([{ number: 12, isDraft: true, headRefOid: "e".repeat(40) }]),
    );

    await stop(input(root), { run, env: TOKEN_ENV, now: () => 0 }, () => {});

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
    await stop(input(opened.root), { run: opened.run, env: TOKEN_ENV, now: () => 0 }, () => {});

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
      { run: first.run, env: { LAB_AUTHOR_TOKEN_FILE: missing }, now: () => 0 },
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
      { run: second.run, env: { LAB_AUTHOR_TOKEN_FILE: missing }, now: () => 0 },
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
    await stop(input(root), { run, env: TOKEN_ENV, now: () => 0 }, (record) => {
      records.push(record);
    });

    expect(records).toContainEqual({ step: "author-token", found: true, path: TOKEN_ENV.LAB_AUTHOR_TOKEN_FILE });
  });

  test("a PR ready at HEAD and not armed yet: the hook asks to arm its PR watch, naming the PR in its commands, and pushes nothing", async () => {
    const { run, calls, root } = world("YES", JSON.stringify([{ number: 12, isDraft: false, headRefOid: HEAD }]));
    const outcome = await stop(input(root), { run, env: TOKEN_ENV, now: () => 0 }, () => {});

    expect(outcome.kind === "block" && outcome.reason).toContain(`bun ${root}/scripts/land-loop/pr-watch.ts 12`);
    expect(outcome.kind === "block" && outcome.reason).toContain(
      `\`bun ${root}/scripts/land-loop/thread.ts <thread-id> `,
    );
    expect(outcome.kind === "block" && outcome.reason).toContain(`\`bun ${root}/scripts/land-loop/comment.ts 12 "`);
    expect(calls.some((call) => call.argv[1] === "push")).toBe(false);
  });

  test("a stop that asks the Owner a question: the Done judge says NO and nothing is pushed", async () => {
    const { run, calls, root } = world("NO, I asked the Owner which command to add.");
    const outcome = await stop(input(root), { run, env: TOKEN_ENV, now: () => 0 }, () => {});

    expect(outcome).toEqual({ kind: "allow" });
    expect(calls.some((call) => call.argv[1] === "push")).toBe(false);
  });

  test("inside a fork the hook launched, nothing runs past reading HEAD", async () => {
    const { run, calls, root } = world("YES");
    const outcome = await stop(input(root), { run, env: { [FORK_FLAG]: "1" }, now: () => 0 }, () => {});

    expect(outcome).toEqual({ kind: "allow" });
    expect(calls.some((call) => call.argv[0] === "claude" || call.argv[1] === "fetch")).toBe(false);
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
  test("reads the answer, cost and cache reads `claude -p --output-format json` prints", () => {
    expect(
      forkResultOf(
        JSON.stringify({ result: "YES", total_cost_usd: 0.02, usage: { cache_read_input_tokens: 5 } }),
        0,
        9,
      ),
    ).toEqual({ text: "YES", ms: 9, costUsd: 0.02, cacheRead: 5, code: 0, unreadable: null });
  });

  test("output that does not read is no answer, and says why", () => {
    expect(forkResultOf("", 124, 9)).toEqual({
      text: "",
      ms: 9,
      costUsd: null,
      cacheRead: null,
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
