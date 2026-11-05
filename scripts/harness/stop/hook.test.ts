import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Ran, Run, RunOptions } from "../lib/run.ts";
import { FORK_MARKER } from "./decide.ts";
import { DONE_QUESTION, FORK_FLAG, hasForkMarker, modelOf, prTextOf, stop, type StopInput } from "./hook.ts";

const HEAD = "d".repeat(40);

interface Call {
  readonly argv: readonly string[];
  readonly options: RunOptions;
}

/** A fake of git, gh, bun and claude for one author session on `agent/x`, one commit ahead, no PR. */
function world(forkAnswer: string): { run: Run; calls: Call[]; root: string } {
  const root = mkdtempSync(join(tmpdir(), "stop-"));
  const calls: Call[] = [];
  const ok = (stdout: string): Ran => ({ code: 0, stdout, stderr: "" });

  const run: Run = async (argv, options) => {
    calls.push({ argv, options });
    const line = argv.join(" ");

    if (line === "git rev-parse --show-toplevel") return ok(`${root}\n`);
    if (line === "git symbolic-ref --short -q HEAD") return ok("agent/x\n");
    if (line === "git rev-parse HEAD") return ok(`${HEAD}\n`);
    if (line === "git status --porcelain") return ok("");
    if (line.startsWith("git rev-list --count")) return ok("1\n");
    if (line.startsWith("git log -1")) return ok("feat: x\n");
    if (line.startsWith("gh pr list")) return ok("[]");
    if (line.startsWith("gh pr create")) return ok("https://github.com/o/r/pull/12\n");
    if (argv[0] === "claude") {
      const prompt = argv.at(-1) ?? "";
      const result = prompt === DONE_QUESTION ? forkAnswer : "feat: x\n\nBody text.";

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
      JSON.stringify({ type: "assistant", message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "done" }] } }),
    ].join("\n"),
  );

  return { session_id: "S1", transcript_path: transcript, cwd: root };
}

describe("stop", () => {
  test("a finished task: the fork runs on the session's model with the flag, then the branch is pushed and the PR opened", async () => {
    const { run, calls, root } = world("YES, done and tested.");
    const outcome = await stop(input(root), { run, env: {}, now: () => 0 }, () => {});

    const fork = calls.find((call) => call.argv[0] === "claude" && call.argv.at(-1) === DONE_QUESTION);

    expect(fork?.argv).toEqual(
      expect.arrayContaining(["-p", "--resume", "S1", "--fork-session", "--model", "claude-haiku-5-5"]),
    );
    expect(fork?.options.env?.[FORK_FLAG]).toBe("1");
    expect(calls.some((call) => call.argv.join(" ").startsWith("git push --force-with-lease -u origin HEAD:refs/heads/agent/x"))).toBe(true);

    const create = calls.find((call) => call.argv.join(" ").startsWith("gh pr create"));

    expect(create?.argv).toEqual(expect.arrayContaining(["--base", "dev", "--title", "feat: x"]));
    expect(create?.options.stdin).toBe("Body text.");
    expect(outcome.kind).toBe("block");
    expect(outcome.kind === "block" && outcome.reason).toContain("PR #12 is ready");
  });

  test("a stop that asks the user a question: the fork says NO and nothing is pushed", async () => {
    const { run, calls, root } = world("NO, I asked the user which command to add.");
    const outcome = await stop(input(root), { run, env: {}, now: () => 0 }, () => {});

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
    expect(hasForkMarker([{ type: "user", message: { content: [{ type: "text", text: ` ${FORK_MARKER} q` }] } }])).toBe(true);
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

  test("the PR text is the fork's first line as title, the rest as body", () => {
    expect(prTextOf("# feat: x\n\nwhy\nhow")).toEqual({ title: "feat: x", body: "why\nhow" });
    expect(prTextOf("  ")).toBeNull();
  });
});
