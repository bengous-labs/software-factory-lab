import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Schema } from "effect";
import * as fc from "fast-check";

import { decodeJson } from "../../lib/json.ts";
import { AUTHOR_MARK, REJECT_MARK } from "../author-mark.ts";
import { pushArgs } from "../lib/author.ts";
import { AUTHOR_LOGIN, OWNER_LOGIN } from "../logins.ts";
import type { RelayStart } from "../ports/relay.ts";
import type { Ran, Run, RunOptions } from "../ports/run.ts";
import { conversationArgsOf } from "../relay/wakes.ts";
import { DONE_SCHEMA, FORK_MARKER, questionCommentOf } from "./decide.ts";
import { BODY_REQUEST, doneQuestionOf } from "./done-prompt.ts";
import {
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
import type { Answer, Deps, StopLogRecord } from "./hook.ts";

const HEAD = "d".repeat(40);

const TOKEN = "t0k";

function tokenFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "author-")), "author-token");
  writeFileSync(path, `${TOKEN}\n`);

  return path;
}

const TOKEN_FILE = tokenFile();

/** The environment of an Author's session: the marker the launcher's settings file gives, and the token's file. */
const AUTHOR_ENV = { LAB_AUTHOR: "1", LAB_AUTHOR_TOKEN_FILE: TOKEN_FILE };

interface Call {
  readonly argv: readonly string[];
  readonly options: RunOptions;
}

const ok = (stdout: string): Promise<Ran> => Promise.resolve({ code: 0, stdout, stderr: "" });

const DONE_OPENING = doneQuestionOf([]).split("\n")[0] ?? "";

const MODEL_USAGE = {
  "claude-haiku-5-5": { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 9000, cacheCreationInputTokens: 700 },
};

/** One line of `.lab/outcomes.log`, as the hook writes it for a stop. */
const OutcomeLine = Schema.Struct({
  at: Schema.String,
  session: Schema.String,
  worktree: Schema.String,
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["published", "not-published"]),
  pr: Schema.optionalKey(Schema.Finite),
  reason: Schema.optionalKey(Schema.String),
});

type OutcomeLine = typeof OutcomeLine.Type;

const FINISHED = { finished: true, question: "", reason: "done and tested", rejections: [] };

const UNFINISHED = { finished: false, question: "", reason: "a test is missing", rejections: [] };

/** A review thread of the App as the threads query gives it. */
function thread(id: string, severity: "important" | "nit" | "pre_existing", resolved = false) {
  const label = { important: "Important", nit: "Nit", pre_existing: "Pre-existing" }[severity];

  return {
    id,
    isResolved: resolved,
    path: "app/src/cli.ts",
    line: 7,
    comments: {
      nodes: [
        {
          author: { login: "bengous-labs-agents" },
          body: `**${label}**: ${id} is wrong\n\nscenario\n\n<!-- lab-finding severity=${severity} -->`,
        },
      ],
    },
  };
}

const threadsAnswer = (threads: readonly unknown[]): string =>
  JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } });

/** The fake's say on the session and the branch. */
interface Fake {
  /** The Done judge's structured outputs, one per ask; the last one answers every later ask. `undefined` is a fork with none. */
  readonly done: ReadonlyArray<Schema.Json | undefined>;
  /** The exit code of the Done judge's fork. */
  readonly doneCode: number;
  readonly listed: string;
  /** What `gh pr list --state closed` prints: the branch's closed and landed PRs. */
  readonly closedListed: string;
  readonly branch: string | null;
  readonly forkBody: string;
  readonly mainCheckout: boolean;
  readonly ahead: number;
  readonly dirty: boolean;
  readonly threads: readonly unknown[];
  /** The command line prefixes that exit 1. */
  readonly failing: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The main checkout of an earlier world, to stop again where its state files are; null for a new one. */
  readonly checkout: string | null;
  /** The commit HEAD names. */
  readonly head: string;
  /** What the PR's conversation comments print, one JSON line each, as the relay's filter prints them. */
  readonly conversation: string;
}

const conversationLine = (id: string, author: string, body: string): string =>
  `${JSON.stringify({ id, author, body })}\n`;

interface World {
  readonly deps: Deps;
  readonly calls: readonly Call[];
  readonly root: string;
  /** The main checkout, which the fake's worktree belongs to. */
  readonly checkout: string;
  readonly relays: readonly RelayStart[];
  readonly outcomes: ReadonlyArray<{ readonly checkout: string; readonly line: OutcomeLine }>;
  readonly records: readonly StopLogRecord[];
  readonly log: (record: StopLogRecord) => void;
}

const draftPr = (head = HEAD, isCrossRepository = false): string =>
  JSON.stringify([{ number: 12, isDraft: true, headRefOid: head, isCrossRepository }]);

const closedPr = (state: string, head = HEAD, isCrossRepository = false): string =>
  JSON.stringify([{ number: 146, headRefOid: head, state, isCrossRepository }]);

const readyPr = (head = HEAD): string =>
  JSON.stringify([{ number: 12, isDraft: false, headRefOid: head, isCrossRepository: false }]);

/** A fake of git, gh, bun and claude for an Author's session in a worktree, on `branch`, one commit ahead of dev. */
function world(fake: Partial<Fake> = {}): World {
  const {
    done = [FINISHED],
    doneCode = 0,
    listed = "[]",
    closedListed = "[]",
    branch = "agent/x",
    forkBody = "Body text.",
    mainCheckout = false,
    ahead = 1,
    dirty = false,
    threads = [],
    failing = [],
    env = AUTHOR_ENV,
    head = HEAD,
    conversation = "",
  } = fake;

  const checkout = fake.checkout ?? mkdtempSync(join(tmpdir(), "stop-"));
  const root = mainCheckout ? checkout : join(checkout, ".claude", "worktrees", "x");
  const calls: Call[] = [];
  const relays: RelayStart[] = [];
  const outcomes: Array<{ checkout: string; line: OutcomeLine }> = [];
  const records: StopLogRecord[] = [];
  let asked = 0;

  const exact = new Map([
    ["git rev-parse --show-toplevel", `${root}\n`],
    ["git rev-parse --absolute-git-dir", mainCheckout ? `${checkout}/.git\n` : `${checkout}/.git/worktrees/x\n`],
    ["git rev-parse --path-format=absolute --git-common-dir", `${checkout}/.git\n`],
    ["git rev-parse HEAD", `${head}\n`],
    ["git status --porcelain", dirty ? " M app/src/cli.ts\n" : ""],
    [conversationArgsOf(12).join(" "), conversation],
  ]);

  /** What a fork asked `prompt` prints: the PR's text, or the Done judge's next answer. */
  const fork = (prompt: string): Promise<Ran> => {
    if (!prompt.startsWith(DONE_OPENING)) {
      return ok(JSON.stringify({ result: `feat: x\n\n${forkBody}`, modelUsage: MODEL_USAGE }));
    }

    const answer = done[Math.min(asked, done.length - 1)];
    asked += 1;

    const printed =
      answer === undefined
        ? { result: "", modelUsage: MODEL_USAGE }
        : { result: "", structured_output: answer, modelUsage: MODEL_USAGE };

    return Promise.resolve({ code: doneCode, stdout: JSON.stringify(printed), stderr: "" });
  };

  const run: Run = (argv, options) => {
    calls.push({ argv, options });
    const line = argv.join(" ");
    const known = exact.get(line);

    if (failing.some((prefix) => line.startsWith(prefix))) {
      return Promise.resolve({ code: 1, stdout: "", stderr: `${argv[0]} failed` });
    }

    if (known !== undefined) {
      return ok(known);
    }

    if (line === "git symbolic-ref --short -q HEAD") {
      return branch === null ? Promise.resolve({ code: 1, stdout: "", stderr: "" }) : ok(`${branch}\n`);
    }

    if (line.startsWith("git rev-list --count")) {
      return ok(`${ahead}\n`);
    }

    if (line.startsWith("git log -1")) {
      return ok("feat: x\n");
    }

    if (line.startsWith("gh pr list")) {
      return ok(argv.includes("closed") ? closedListed : listed);
    }

    if (line.startsWith("gh pr create")) {
      return ok("https://github.com/o/r/pull/12\n");
    }

    if (line.startsWith("gh api graphql -f query=query")) {
      return ok(threadsAnswer(threads));
    }

    return argv[0] === "claude" ? fork(argv.at(-1) ?? "") : ok("");
  };

  const deps: Deps = {
    run,
    env,
    now: () => 0,
    startRelay: (relay) => {
      relays.push(relay);

      return "started";
    },
    recordOutcome: (where, line) => {
      outcomes.push({ checkout: where, line: decodeJson(OutcomeLine, "an outcome line", line) });
    },
  };

  return {
    deps,
    calls,
    root,
    checkout,
    relays,
    outcomes,
    records,
    log: (record) => {
      records.push(record);
    },
  };
}

/** One stop of the fake's session. */
const stopIn = (found: World, stopHookActive = false): Promise<Answer> =>
  stop(input(found.root, stopHookActive), found.deps, found.log);

/** The body `gh pr create` reads on stdin when the hook opens the PR from `branch` with the fork's `forkBody`. */
async function bodyOf(branch: string, forkBody: string): Promise<string | undefined> {
  const found = world({ branch, forkBody });
  await stopIn(found);

  return found.calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.options.stdin;
}

function input(root: string, stopHookActive = false): StopInput {
  const dir = mkdtempSync(join(tmpdir(), "transcript-"));
  const transcript = join(dir, "t.jsonl");
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

  return { session_id: "S1", transcript_path: transcript, cwd: root, stop_hook_active: stopHookActive };
}

/** What the hook wrote on GitHub and pushed, in its order: each reply and resolution with its thread, the push, the PR calls. */
function writes(calls: readonly Call[]): string[] {
  return calls.flatMap((call) => {
    const line = call.argv.join(" ");
    const id = call.argv.find((word) => word.startsWith("id="))?.slice(3) ?? "";

    if (line.includes("addPullRequestReviewThreadReply")) {
      return [`reply ${id}`];
    }

    if (line.includes("resolveReviewThread")) {
      return [`resolve ${id}`];
    }

    if (call.argv.includes("push")) {
      return ["push"];
    }

    const undo = call.argv.includes("--undo") ? " --undo" : "";

    return /^gh pr (create|edit|comment|ready)/u.test(line) ? [`${call.argv.slice(1, 3).join(" ")}${undo}`] : [];
  });
}

const REPO = resolve(import.meta.dir, "..", "..", "..");

const FORK_SETTINGS = `{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"bun \\"${REPO}/scripts/land-loop/stop/fork-guard.ts\\"","timeout":30}]}]}}`;

/** The command line of a fork asked `prompt` on the session's model, with the JSON Schema of its answer, if any. */
const forkArgv = (prompt: string, schema: string | null): readonly string[] => [
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
  ...(schema === null ? [] : ["--json-schema", schema]),
  "--output-format",
  "json",
  "--model",
  "claude-haiku-5-5",
  prompt,
];

describe("who is an Author", () => {
  test("a stop of a session without LAB_AUTHOR on a branch ahead of dev publishes nothing, and reads nothing", async () => {
    for (const env of [
      { LAB_AUTHOR_TOKEN_FILE: TOKEN_FILE },
      { ...AUTHOR_ENV, LAB_AUTHOR: "0" },
      { ...AUTHOR_ENV, LAB_AUTHOR: "" },
    ]) {
      const found = world({ env });

      expect(await stopIn(found)).toEqual({ kind: "allow" });
      expect(found.calls).toEqual([]);
      expect(found.outcomes).toEqual([]);
      expect(found.records).toEqual([
        { step: "admit", kind: "none", reason: "this session is not an Author: its environment holds no LAB_AUTHOR=1" },
      ]);
    }
  });

  test("a session that is not an Author, or a fork, has no transcript read: one that does not read stops no stop", async () => {
    const unreadable = join(mkdtempSync(join(tmpdir(), "transcript-")), "t.jsonl");
    writeFileSync(unreadable, "not JSON\n");

    for (const env of [{}, { ...AUTHOR_ENV, [FORK_FLAG]: "1" }]) {
      const found = world({ env });

      expect(
        await stop({ session_id: "S1", transcript_path: unreadable, cwd: found.root }, found.deps, found.log),
      ).toEqual({ kind: "allow" });
    }

    const author = world();

    expect(
      stop({ session_id: "S1", transcript_path: unreadable, cwd: author.root }, author.deps, author.log),
    ).rejects.toThrow(`${unreadable} line 1`);
  });

  test("inside a fork the hook launched, nothing runs though the fork inherits the Author's marker", async () => {
    const found = world({ env: { ...AUTHOR_ENV, [FORK_FLAG]: "1" } });

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(found.calls).toEqual([]);
    expect(found.outcomes).toEqual([]);
    expect(found.records).toEqual([
      { step: "admit", kind: "none", reason: "this session is a fork the hook launched" },
    ]);
  });

  test("an Author session in the main checkout publishes nothing; the same session in a worktree publishes", async () => {
    const main = world({ mainCheckout: true });

    expect(await stopIn(main)).toEqual({ kind: "allow" });
    expect(writes(main.calls)).toEqual([]);
    expect(main.calls.some((call) => call.argv[0] === "claude" || call.argv[0] === "bun")).toBe(false);
    expect(main.outcomes.map((outcome) => outcome.line)).toMatchObject([
      {
        outcome: "not-published",
        reason: "this session works in the main checkout: an Author publishes from its own worktree",
      },
    ]);

    const worktree = world();

    expect(await stopIn(worktree)).toEqual({ kind: "allow" });
    expect(writes(worktree.calls)).toEqual(["push", "pr create"]);
    expect(worktree.outcomes.map((outcome) => outcome.line)).toMatchObject([{ outcome: "published", pr: 12 }]);
  });
});

// An inherited GIT_DIR would point a fixture's git at the real repository; the test layer cannot import fixtureEnv.
const FIXTURE_ENV = Object.fromEntries(
  Object.entries(process.env).flatMap(([name, value]) =>
    name.startsWith("GIT_") || value === undefined ? [] : [[name, value] as const],
  ),
);

/** Runs git in `cwd` of a fixture repository, as a test author with no signing. */
async function git(cwd: string, ...args: string[]): Promise<Ran> {
  const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
  const child = Bun.spawn(["git", ...identity, ...args], { cwd, env: FIXTURE_ENV, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, stdout, stderr };
}

/** A repository whose main checkout and whose linked worktree are each on a branch one commit ahead of `origin/dev`. */
async function fixtureRepository(): Promise<{ readonly main: string; readonly worktree: string }> {
  const main = realpathSync(mkdtempSync(join(tmpdir(), "stop-repo-")));
  const worktree = join(main, ".claude", "worktrees", "w");

  await git(main, "init", "--quiet", "--initial-branch", "dev");
  // The hook keeps its state under `.lab/`, which the repository ignores.
  writeFileSync(join(main, ".gitignore"), ".lab/\n");
  await git(main, "add", ".gitignore");
  await git(main, "commit", "--quiet", "-m", "chore: base");
  await git(main, "update-ref", "refs/remotes/origin/dev", "HEAD");
  await git(main, "worktree", "add", "--quiet", "-b", "feat/in-a-worktree", worktree);
  await git(worktree, "commit", "--quiet", "--allow-empty", "-m", "feat: w");
  await git(main, "switch", "--quiet", "-c", "feat/in-the-main-checkout");
  await git(main, "commit", "--quiet", "--allow-empty", "-m", "feat: m");
  mkdirSync(join(main, "sub"));
  mkdirSync(join(worktree, "sub"));

  return { main, worktree };
}

/** One stop in `cwd` of the fixture: git reads the repository for real, GitHub and the forks are the fake's. */
async function stopAt(cwd: string): Promise<World> {
  const found = world();

  const run: Run = (argv, options) =>
    argv[0] === "git" && !argv.includes("push") && !argv.includes("fetch")
      ? git(options.cwd, ...argv.slice(1))
      : found.deps.run(argv, options);

  await stop({ ...input(cwd), cwd }, { ...found.deps, run }, found.log);

  return found;
}

describe("the checkout a stop comes from, as git reads it", () => {
  test("a stop in the main checkout, or in a directory under it, publishes nothing; one in a linked worktree publishes", async () => {
    const { main, worktree } = await fixtureRepository();

    for (const cwd of [main, join(main, "sub")]) {
      const found = await stopAt(cwd);

      expect(writes(found.calls)).toEqual([]);
      expect(found.outcomes).toMatchObject([
        {
          checkout: main,
          line: {
            worktree: main,
            branch: "feat/in-the-main-checkout",
            outcome: "not-published",
            reason: "this session works in the main checkout: an Author publishes from its own worktree",
          },
        },
      ]);
    }

    for (const cwd of [worktree, join(worktree, "sub")]) {
      const found = await stopAt(cwd);

      expect(writes(found.calls)).toEqual(["push", "pr create"]);
      expect(found.outcomes).toMatchObject([
        { checkout: main, line: { worktree, branch: "feat/in-a-worktree", outcome: "published", pr: 12 } },
      ]);
      expect(found.relays).toEqual([{ pr: 12, session: "S1", checkout: main }]);
    }
  });
});

describe("the stop of an Author", () => {
  test("a finished change: the Done judge's fork answers through the schema, then the branch is pushed and the PR opened", async () => {
    const found = world();
    const answer = await stopIn(found);
    const forks = found.calls.filter((call) => call.argv[0] === "claude");

    expect(forks.map((call) => call.argv)).toEqual([
      forkArgv(doneQuestionOf([]), JSON.stringify(DONE_SCHEMA)),
      forkArgv(BODY_REQUEST, null),
    ]);
    expect(forks.every((call) => !(call.argv[call.argv.indexOf("--tools") + 1] ?? "").includes("Monitor"))).toBe(true);
    expect(forks.map((call) => call.options)).toEqual([
      { cwd: found.root, env: { [FORK_FLAG]: "1" }, timeoutMs: 180_000 },
      { cwd: found.root, env: { [FORK_FLAG]: "1" }, timeoutMs: 180_000 },
    ]);
    expect(found.calls.some((call) => call.argv.join(" ") === pushArgs("agent/x").join(" "))).toBe(true);

    const create = found.calls.find((call) => call.argv.join(" ").startsWith("gh pr create"));

    expect(create?.argv).toEqual([
      "gh",
      "pr",
      "create",
      "--base",
      "dev",
      "--head",
      "agent/x",
      "--title",
      "feat: x",
      "--body-file",
      "-",
    ]);
    expect(create?.options.stdin).toBe("Body text.");
    expect(answer).toEqual({ kind: "allow" });
  });

  test("a Publication ends the stop with no block and no text, and leaves one relay for its PR and its session", async () => {
    const opened = world();

    expect(await stopIn(opened)).toEqual({ kind: "allow" });
    expect(opened.relays).toEqual([{ pr: 12, session: "S1", checkout: opened.checkout }]);
    expect(opened.records).toContainEqual({ step: "relay", pr: 12, relay: "started" });

    const pushed = world({ listed: readyPr("e".repeat(40)) });

    expect(await stopIn(pushed)).toEqual({ kind: "allow" });
    expect(pushed.relays).toEqual([{ pr: 12, session: "S1", checkout: pushed.checkout }]);
  });

  test("a stop that publishes nothing leaves no relay", async () => {
    for (const found of [world({ done: [UNFINISHED] }), world({ listed: readyPr() }), world({ dirty: true })]) {
      await stopIn(found);

      expect(found.relays).toEqual([]);
    }
  });

  test("a relay that cannot be left is logged, and the PR is published all the same", async () => {
    const found = world();

    const answer = await stop(
      input(found.root),
      {
        ...found.deps,
        startRelay: () => {
          throw new Error("no bun on the PATH");
        },
      },
      found.log,
    );

    expect(answer).toEqual({ kind: "allow" });
    expect(found.records).toContainEqual({ step: "relay", pr: 12, relay: null, error: "no bun on the PATH" });
    expect(found.outcomes.map((outcome) => outcome.line)).toMatchObject([{ outcome: "published", pr: 12 }]);
  });

  test("the done-judge and body-fork lines log the tokens of each fork, and the judge's answer", async () => {
    const found = world();
    await stopIn(found);

    for (const step of ["done-judge", "body-fork"]) {
      expect(found.records.find((record) => record.step === step)).toMatchObject({
        tokens: { input: 2, output: 4, cacheRead: 9000, cacheCreation: 700 },
      });
    }

    expect(found.records.find((record) => record.step === "done-judge")).toMatchObject({
      model: "claude-haiku-5-5",
      answer: "finished",
      question: "",
      reason: "done and tested",
      rejections: 0,
      code: 0,
    });
  });

  test("a branch made for an issue opens a PR whose body ends with its closing line, once", async () => {
    expect(await bodyOf("fix/89-patch-delta-judge", "Body text.")).toBe("Body text.\n\nCloses #89");
    expect(await bodyOf("fix/89-patch-delta-judge", "Body text.\n\nfixes #89")).toBe("Body text.\n\nfixes #89");
    expect(await bodyOf("fix/89-patch-delta-judge", "")).toBe("Closes #89");
    expect(await bodyOf("chore/tidy-docs", "Body text.")).toBe("Body text.");
    expect(await bodyOf("chore/tidy-docs", "")).toBe("(no body)");
  });

  test("the push and every gh call carry the Author's credential; git fetch and the forks do not", async () => {
    const found = world({ listed: draftPr("e".repeat(40)), threads: [thread("T1", "nit")] });
    await stopIn(found);

    const envOf = (prefix: string): RunOptions["env"] =>
      found.calls.find((call) => call.argv.join(" ").startsWith(prefix))?.options.env;

    expect(found.calls.find((call) => call.argv.includes("push"))?.argv).toEqual(pushArgs("agent/x"));
    expect(envOf("git -c")).toEqual({ LAB_AUTHOR_TOKEN: TOKEN });
    expect(envOf("gh pr list")).toEqual({ GH_TOKEN: TOKEN });
    expect(envOf("gh pr ready 12")).toEqual({ GH_TOKEN: TOKEN });
    expect(envOf("gh api graphql -f query=query")).toEqual({ GH_TOKEN: TOKEN });
    expect(envOf("gh api graphql -f query=mutation")).toEqual({ GH_TOKEN: TOKEN });
    expect(envOf("git fetch")).toBeUndefined();
    expect(found.calls.filter((call) => call.argv[0] === "claude").map((call) => call.options.env)).toEqual([
      { [FORK_FLAG]: "1" },
    ]);

    const opened = world();
    await stopIn(opened);

    expect(opened.calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.options.env).toEqual({
      GH_TOKEN: TOKEN,
    });
  });

  test("a draft PR is pushed and readied; a ready PR behind this head is pushed only; neither reads or edits a body", async () => {
    const draft = world({ listed: draftPr() });
    await stopIn(draft);

    expect(writes(draft.calls)).toEqual(["push", "pr ready"]);
    expect(draft.calls.filter((call) => call.argv[0] === "claude")).toHaveLength(1);

    const behind = world({ listed: readyPr("e".repeat(40)) });
    await stopIn(behind);

    expect(writes(behind.calls)).toEqual(["push"]);
  });

  test("uncommitted changes: the hook blocks once asking for the commit alone, then lets the session end, and runs no Stop check, fork or push", async () => {
    const first = world({ dirty: true });

    expect(await stopIn(first)).toEqual({ kind: "block", reason: "Commit your changes, then stop." });

    const second = world({ dirty: true });

    expect(await stopIn(second, true)).toEqual({ kind: "allow" });

    for (const { calls } of [first, second]) {
      expect(
        calls.some((call) => call.argv[0] === "claude" || call.argv[0] === "bun" || call.argv.includes("push")),
      ).toBe(false);
    }
  });

  test("the block that asked for the commit leaves the Stop checks their own: red after the commit, they block with their report, once", async () => {
    const dirty = world({ dirty: true });
    await stopIn(dirty);

    const red = { checkout: dirty.checkout, failing: ["bun check"] };
    const committed = await stopIn(world(red), true);

    expect(committed.kind === "block" ? committed.reason : "").toStartWith(
      "The Stop checks are red on this head, so nothing was published:",
    );
    expect(await stopIn(world(red), true)).toEqual({ kind: "allow" });
  });

  test("the commit asked for in one session leaves another session's chain as it was", async () => {
    const dirty = world({ dirty: true });
    await stop({ ...input(dirty.root), session_id: "S0" }, dirty.deps, dirty.log);

    const other = world({ checkout: dirty.checkout, failing: ["bun check"] });

    expect(await stopIn(other, true)).toEqual({ kind: "allow" });
  });

  test("no Author token: the hook blocks once with the reason, then lets the session end, and runs no Stop check, fork or push", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "author-")), "absent");
    const env = { LAB_AUTHOR: "1", LAB_AUTHOR_TOKEN_FILE: missing };
    const first = world({ env });

    expect(await stopIn(first)).toEqual({
      kind: "block",
      reason: `The Stop hook found no Author token at ${missing}, so nothing was published. The Owner provisions it (.claude/rules/identities.md). Stop, and ask no question.`,
    });
    expect(first.records).toContainEqual({ step: "author-token", found: false, path: missing });

    const second = world({ env });

    expect(await stopIn(second, true)).toEqual({ kind: "allow" });

    for (const { calls } of [first, second]) {
      expect(
        calls.some((call) => call.argv[0] === "claude" || call.argv[0] === "bun" || call.argv.includes("push")),
      ).toBe(false);
    }
  });

  test("a token found is logged with its path", async () => {
    const found = world();
    await stopIn(found);

    expect(found.records).toContainEqual({ step: "author-token", found: true, path: TOKEN_FILE });
  });

  test("red Stop checks block once with their report, then let the session end, and no fork runs", async () => {
    const first = world({ failing: ["bun check"] });
    const blocked = await stopIn(first);

    expect(blocked).toEqual({
      kind: "block",
      reason:
        "The Stop checks are red on this head, so nothing was published:\n\nbun failed\n\nFix them and commit, then stop.",
    });

    const second = world({ failing: ["bun check"] });

    expect(await stopIn(second, true)).toEqual({ kind: "allow" });

    for (const { calls } of [first, second]) {
      expect(calls.some((call) => call.argv[0] === "claude" || call.argv.includes("push"))).toBe(false);
    }
  });
});

/** What one stop of a session finds: its tree, the Author token, the Stop checks, and whether the Done judge answers. */
interface StopState {
  readonly dirty: boolean;
  readonly token: boolean;
  readonly checksRed: boolean;
  readonly doneAnswers: boolean;
}

const STOP_STATE: fc.Arbitrary<StopState> = fc.record({
  dirty: fc.boolean(),
  token: fc.boolean(),
  checksRed: fc.boolean(),
  doneAnswers: fc.boolean(),
});

const COMMIT_ASKED = "Commit your changes, then stop.";

const NO_TOKEN_ENV = {
  LAB_AUTHOR: "1",
  LAB_AUTHOR_TOKEN_FILE: join(mkdtempSync(join(tmpdir(), "author-")), "absent"),
};

/** A clean stop the hook reports a failure on: no Author token, red Stop checks, or a Done judge with no answer. */
const failsOn = (state: StopState): boolean => !state.dirty && (!state.token || state.checksRed || !state.doneAnswers);

/** The fake of the `index`th stop of a session whose main checkout is `checkout`. */
const stopWorld = (checkout: string, index: number, state: StopState): World =>
  world({
    checkout,
    // The hook keeps green Stop checks per head: each stop comes after a commit of its own.
    head: String(index).repeat(40),
    dirty: state.dirty,
    env: state.token ? AUTHOR_ENV : NO_TOKEN_ENV,
    failing: state.checksRed ? ["bun check"] : [],
    done: state.doneAnswers ? [FINISHED] : [undefined],
  });

/** Where a session stands in its chain: the blocks so far, and whether one of them reported a failure. */
interface ChainSoFar {
  readonly blocks: number;
  readonly reported: boolean;
}

const NEW_CHAIN: ChainSoFar = { blocks: 0, reported: false };

/** The rule of a chain of stops, on one stop of `state` the hook answered `answer`. */
function expectChainRule(chain: ChainSoFar, state: StopState, answer: Answer): void {
  const reason = answer.kind === "block" ? answer.reason : "";

  if (state.dirty) {
    expect(reason).toBe(chain.blocks === 0 ? COMMIT_ASKED : "");
  } else if (failsOn(state) && !chain.reported) {
    expect(reason).not.toBeOneOf(["", COMMIT_ASKED]);
  } else {
    expect(reason).toBe("");
  }
}

/** The chain after a stop answered `answer`: an allowed stop ends it. */
const chainAfter = (chain: ChainSoFar, answer: Answer): ChainSoFar =>
  answer.kind === "allow"
    ? NEW_CHAIN
    : { blocks: chain.blocks + 1, reported: chain.reported || answer.reason !== COMMIT_ASKED };

describe("a chain of stops", () => {
  test("each failure is reported once before the session ends, a dirty tree asks for the commit alone once per chain, and a chain blocks at most twice", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(STOP_STATE, { minLength: 1, maxLength: 6 }), async (states) => {
        const checkout = mkdtempSync(join(tmpdir(), "chain-"));
        let chain = NEW_CHAIN;

        for (const [index, state] of states.entries()) {
          const answer = await stopIn(stopWorld(checkout, index, state), chain.blocks > 0);
          expectChainRule(chain, state, answer);
          chain = chainAfter(chain, answer);
          expect(chain.blocks).toBeLessThanOrEqual(2);
        }
      }),
    );
  });
});

describe("the Done judge", () => {
  test("a change that is not finished publishes nothing, and the stop goes", async () => {
    const found = world({ done: [UNFINISHED] });

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(writes(found.calls)).toEqual([]);
  });

  test("a question with no PR opens one in draft, posts the question on it, and leaves its relay to this session", async () => {
    const found = world({ branch: "feat/7-x", done: [{ ...FINISHED, question: "  Leave the doc, or update it?\n" }] });

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(writes(found.calls)).toEqual(["push", "pr create", "pr comment"]);
    expect(found.calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.argv).toContain("--draft");

    const comment = found.calls.find((call) => call.argv.join(" ").startsWith("gh pr comment"));
    expect(comment?.argv).toEqual(["gh", "pr", "comment", "12", "--body-file", "-"]);
    expect(comment?.options.stdin).toBe(questionCommentOf("Leave the doc, or update it?", "feat/7-x", "S1"));
    expect(comment?.options.env).toEqual({ GH_TOKEN: TOKEN });

    expect(found.relays).toEqual([{ pr: 12, session: "S1", checkout: found.checkout }]);
    expect(found.records.find((record) => record.step === "done-judge")).toMatchObject({
      answer: "finished",
      question: "Leave the doc, or update it?",
    });
    expect(found.outcomes[0]?.line).toMatchObject({
      outcome: "not-published",
      reason: "the Author's last message leaves a question to its user: Leave the doc, or update it?",
    });
  });

  test("a question still open on the PR is not posted again; one the Owner answered is followed by the new one", async () => {
    const asked = conversationLine("1", AUTHOR_LOGIN, questionCommentOf("Which wording?", "agent/x", "S1"));
    const answered = conversationLine("2", OWNER_LOGIN, "The first.");
    const asking = { done: [{ ...FINISHED, question: "Which wording, again?" }], listed: draftPr() };

    const repeated = world({ ...asking, conversation: asked });
    await stopIn(repeated);
    expect(writes(repeated.calls)).toEqual(["push"]);
    expect(repeated.records.find((record) => record.step === "question")).toEqual({
      step: "question",
      pr: 12,
      posted: false,
    });
    expect(repeated.relays).toHaveLength(1);

    const next = world({ ...asking, conversation: `${asked}${answered}` });
    await stopIn(next);
    expect(writes(next.calls)).toEqual(["push", "pr comment"]);
  });

  test("a question on a ready PR sends it to draft before the push, and nothing readies it: nothing lands while it is open", async () => {
    const found = world({ done: [{ ...FINISHED, question: "Which wording?" }], listed: readyPr("e".repeat(40)) });

    await stopIn(found);

    expect(writes(found.calls)).toEqual(["pr ready --undo", "push", "pr comment"]);
  });

  test("not finished, then finished, on the same head with no new commit: the second stop publishes", async () => {
    const found = world({ done: [UNFINISHED, FINISHED] });

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(writes(found.calls)).toEqual([]);

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(writes(found.calls)).toEqual(["push", "pr create"]);
    expect(found.outcomes.map((outcome) => outcome.line)).toMatchObject([
      {
        head: HEAD,
        outcome: "not-published",
        reason: "the Done judge says the change is not finished: a test is missing",
      },
      { head: HEAD, outcome: "published", pr: 12 },
    ]);
  });

  test("an answer that does not fit the schema is no answer: the hook blocks once, then lets the session end, and publishes nothing", async () => {
    const unfit: Array<Schema.Json | undefined> = [
      undefined,
      "YES",
      "YES, HOLD: a stored format",
      { finished: "yes", reason: "done", rejections: [] },
      { finished: true, reason: "done" },
    ];

    for (const answer of unfit) {
      const first = world({ done: [answer] });

      expect(await stopIn(first)).toEqual({
        kind: "block",
        reason:
          "The Stop hook could not ask whether your change is finished (the Done judge's fork exited 0 with no answer that reads), so nothing was published. Stop again to retry; ask no question.",
      });
      expect(await stopIn(first, true)).toEqual({ kind: "allow" });
      expect(writes(first.calls)).toEqual([]);
      expect(first.records.filter((record) => record.step === "done-judge")).toMatchObject([
        { answer: "none" },
        { answer: "none" },
      ]);
    }
  });

  test("a fork that exits non-zero gave no answer, whatever it printed", async () => {
    const found = world({ doneCode: 124 });
    const blocked = await stopIn(found);

    expect(blocked.kind === "block" && blocked.reason).toContain("exited 124");
    expect(writes(found.calls)).toEqual([]);
  });

  test("no answer puts land:human: the hook edits no label and posts no comment, whatever the judge answers", async () => {
    const answers: Array<Schema.Json | undefined> = [
      FINISHED,
      UNFINISHED,
      "YES, HOLD: a stored format",
      { finished: true, question: "", reason: "HOLD: a human should read this", rejections: [] },
      { finished: true, question: "", reason: "done", rejections: [], hold: "a stored format" },
    ];

    for (const answer of answers) {
      for (const listed of ["[]", draftPr(), readyPr("e".repeat(40))]) {
        const found = world({ done: [answer], listed });
        await stopIn(found);

        expect(found.calls.filter((call) => /^gh pr (edit|comment)/u.test(call.argv.join(" ")))).toEqual([]);
        expect(found.calls.some((call) => call.argv.join(" ").includes("land:human"))).toBe(false);
      }
    }
  });

  test("the question lists the App's open Important and Nit findings of the PR, not a resolved or Pre-existing one", async () => {
    const found = world({
      listed: draftPr(),
      threads: [
        thread("T1", "important"),
        thread("T2", "nit"),
        thread("T3", "nit", true),
        thread("T4", "pre_existing"),
      ],
    });

    await stopIn(found);

    expect(found.calls.find((call) => call.argv[0] === "claude")?.argv.at(-1)).toBe(
      doneQuestionOf([
        { thread: "T1", where: "app/src/cli.ts:7", severity: "important", summary: "T1 is wrong" },
        { thread: "T2", where: "app/src/cli.ts:7", severity: "nit", summary: "T2 is wrong" },
      ]),
    );
  });
});

describe("rejections and Nit threads", () => {
  const REJECTING = {
    finished: true,
    question: "",
    reason: "done",
    rejections: [{ thread: "T1", reason: "by design: <cli> reads it" }],
  };

  test("a rejection is posted with its marks and its thread resolved, before the push", async () => {
    const found = world({ done: [REJECTING], listed: draftPr(), threads: [thread("T1", "important")] });
    await stopIn(found);

    expect(writes(found.calls)).toEqual(["reply T1", "resolve T1", "push", "pr ready"]);
    expect(
      found.calls.find((call) => call.argv.join(" ").includes("addPullRequestReviewThreadReply"))?.argv.at(-1),
    ).toBe(`body=Rejected: by design: &lt;cli> reads it\n\n${REJECT_MARK}\n\n${AUTHOR_MARK}`);
    expect(found.records).toContainEqual({ step: "rejection", thread: "T1" });
  });

  test("when the push fails, nothing is written after the rejection, and the outcome says so", async () => {
    const found = world({
      done: [REJECTING],
      listed: draftPr(),
      threads: [thread("T1", "important"), thread("T2", "nit")],
      failing: ["git -c"],
    });

    expect(stopIn(found)).rejects.toThrow("git -c url.https://github.com/.pushInsteadOf=git@github.com: exited 1");
    await stopIn(found).catch(() => {});

    expect(writes(found.calls).slice(0, 3)).toEqual(["reply T1", "resolve T1", "push"]);
    expect(writes(found.calls).filter((write) => write !== "push" && !write.endsWith("T1"))).toEqual([]);
    expect(found.relays).toEqual([]);
    expect(found.outcomes[0]?.line).toMatchObject({ outcome: "not-published" });
    expect(String(found.outcomes[0]?.line.reason)).toStartWith("the Stop hook failed: git -c");
  });

  test("a rejection that names no open thread of the App is dropped and logged, and nothing is posted for it", async () => {
    const found = world({
      done: [
        {
          finished: true,
          question: "",
          reason: "done",
          rejections: [
            { thread: "T9", reason: "not mine" },
            { thread: "T3", reason: "resolved before" },
          ],
        },
      ],
      listed: draftPr(),
      threads: [thread("T1", "important"), thread("T3", "nit", true)],
    });

    await stopIn(found);

    expect(writes(found.calls)).toEqual(["push", "pr ready"]);
    expect(found.records).toContainEqual({ step: "rejection-dropped", thread: "T9", reason: "not mine" });
    expect(found.records).toContainEqual({ step: "rejection-dropped", thread: "T3", reason: "resolved before" });
  });

  test("after a push, the App's open Nit threads are resolved; an Important thread is not", async () => {
    const found = world({
      listed: readyPr("e".repeat(40)),
      threads: [thread("T1", "important"), thread("T2", "nit"), thread("T3", "nit"), thread("T4", "pre_existing")],
    });

    await stopIn(found);

    expect(writes(found.calls)).toEqual(["push", "resolve T2", "resolve T3"]);
    expect(found.records).toContainEqual({ step: "nits", resolved: 2 });
  });

  test("a rejected Nit is resolved once, by its rejection", async () => {
    const found = world({ done: [REJECTING], listed: draftPr(), threads: [thread("T1", "nit"), thread("T2", "nit")] });
    await stopIn(found);

    expect(writes(found.calls)).toEqual(["reply T1", "resolve T1", "push", "pr ready", "resolve T2"]);
  });

  test("no reply the hook posts cites a commit: a fix is declared by nobody", async () => {
    const found = world({ listed: draftPr(), threads: [thread("T1", "important"), thread("T2", "nit")] });
    await stopIn(found);

    expect(writes(found.calls).filter((write) => write.startsWith("reply"))).toEqual([]);
    expect(writes(found.calls)).toEqual(["push", "pr ready", "resolve T2"]);
  });

  test("Nit threads that cannot be resolved leave the PR published; the next stop of an Author on the PR resolves them", async () => {
    const failed = world({
      listed: draftPr(),
      threads: [thread("T2", "nit")],
      failing: ["gh api graphql -f query=mutation"],
    });

    expect(await stopIn(failed)).toEqual({ kind: "allow" });
    expect(failed.outcomes.map((outcome) => outcome.line)).toMatchObject([{ outcome: "published", pr: 12 }]);
    expect(failed.records).toContainEqual({
      step: "nits",
      resolved: null,
      error: "gh api graphql exited 1: gh failed",
    });

    const next = world({ listed: readyPr(), threads: [thread("T1", "important"), thread("T2", "nit")] });

    expect(await stopIn(next)).toEqual({ kind: "allow" });
    expect(writes(next.calls)).toEqual(["resolve T2"]);
    expect(next.calls.some((call) => call.argv[0] === "claude" || call.argv[0] === "bun")).toBe(false);
  });
});

/** The one outcome line a stop of the fake's session leaves, in its main checkout's log. */
async function outcomeOf(fake: Partial<Fake>, stopHookActive = false): Promise<OutcomeLine | undefined> {
  const found = world(fake);
  await stopIn(found, stopHookActive).catch(() => {});

  expect(found.outcomes).toHaveLength(1);
  expect(found.outcomes[0]?.checkout).toBe(found.checkout);
  expect(found.outcomes[0]?.line).toMatchObject({
    at: "1970-01-01T00:00:00.000Z",
    session: "S1",
    worktree: found.root,
    head: HEAD,
  });

  return found.outcomes[0]?.line;
}

describe("a PR closed without landing", () => {
  test("a stop at the head the closed PR had pushes nothing, opens nothing and asks no fork", async () => {
    const found = world({ closedListed: closedPr("CLOSED") });

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(writes(found.calls)).toEqual([]);
    expect(found.calls.some((call) => call.argv[0] === "claude")).toBe(false);
    expect(found.relays).toEqual([]);
  });

  test("the closed list is read as the Author, closed PRs only", async () => {
    const found = world();
    await stopIn(found);

    const closedList = found.calls.find((call) => call.argv.join(" ").includes("--state closed"));

    expect(closedList?.argv).toEqual([
      "gh",
      "pr",
      "list",
      "--head",
      "agent/x",
      "--state",
      "closed",
      "--json",
      "number,headRefOid,state,isCrossRepository",
    ]);
    expect(closedList?.options.env).toEqual({ GH_TOKEN: TOKEN });
  });

  test("a fork's open PR of the same branch name is not the branch's: the closed PR still holds the stop", async () => {
    const found = world({ listed: draftPr(HEAD, true), closedListed: closedPr("CLOSED") });
    await stopIn(found);

    expect(writes(found.calls)).toEqual([]);
    expect(found.outcomes.map((outcome) => outcome.line)).toMatchObject([
      { reason: `#146 was closed without landing at ${HEAD}: a stop at the head it had publishes nothing` },
    ]);
    expect(found.calls.find((call) => call.argv.includes("open"))?.argv.at(-1)).toBe(
      "number,isDraft,headRefOid,isCrossRepository",
    );
  });

  test("the closed list is not read when the stop publishes nothing anyway, or a PR is open", async () => {
    for (const fake of [{ ahead: 0 }, { dirty: true }, { listed: draftPr() }]) {
      const found = world({ ...fake, closedListed: closedPr("CLOSED") });
      await stopIn(found);

      expect(found.calls.some((call) => call.argv.join(" ").includes("--state closed"))).toBe(false);
    }
  });

  test("a landed PR at this head, a PR closed at another head, or a fork's PR closed at this head, still lets the branch open a PR", async () => {
    for (const closedListed of [
      closedPr("MERGED"),
      closedPr("CLOSED", "b".repeat(40)),
      closedPr("CLOSED", HEAD, true),
    ]) {
      const found = world({ closedListed });
      await stopIn(found);

      expect(writes(found.calls)).toEqual(["push", "pr create"]);
    }
  });
});

describe("the outcome of each stop", () => {
  test("a Publication leaves one line in the main checkout's log, with the PR it opened or pushed", async () => {
    expect(await outcomeOf({})).toMatchObject({ branch: "agent/x", outcome: "published", pr: 12 });
    expect(await outcomeOf({ listed: draftPr() })).toMatchObject({ outcome: "published", pr: 12 });
    expect(Object.keys((await outcomeOf({})) ?? {})).toEqual([
      "at",
      "session",
      "worktree",
      "branch",
      "head",
      "outcome",
      "pr",
    ]);
  });

  test("each way of not publishing leaves one line with its reason", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "author-")), "absent");
    const noToken = { LAB_AUTHOR: "1", LAB_AUTHOR_TOKEN_FILE: missing };

    const cases: Array<[Partial<Fake>, boolean, string]> = [
      [{ branch: null }, false, "HEAD is detached"],
      [{ branch: "dev" }, false, "dev is never published"],
      [{ branch: "main" }, false, "main is never published"],
      [{ branch: "lab/x" }, false, "lab/x is never published"],
      [
        { mainCheckout: true },
        false,
        "this session works in the main checkout: an Author publishes from its own worktree",
      ],
      [{ ahead: 0 }, false, "agent/x has no commit that dev lacks"],
      [{ dirty: true }, false, "the tree has uncommitted changes"],
      [{ dirty: true }, true, "the tree has uncommitted changes"],
      [{ listed: readyPr() }, false, `#12 is ready at ${HEAD} already`],
      [
        { closedListed: closedPr("CLOSED") },
        false,
        `#146 was closed without landing at ${HEAD}: a stop at the head it had publishes nothing`,
      ],
      [{ env: noToken }, false, `no Author token at ${missing}`],
      [{ env: noToken }, true, "no Author token after a block: nothing is published"],
      [{ failing: ["bun check"] }, false, `the Stop checks are red on ${HEAD}`],
      [{ failing: ["bun check"] }, true, "the Stop checks are still red after a block: nothing is published"],
      [{ done: ["YES"] }, false, "the Done judge gave no answer"],
      [{ done: ["YES"] }, true, "the Done judge gave no answer after a block: nothing is published"],
      [{ done: [UNFINISHED] }, false, "the Done judge says the change is not finished: a test is missing"],
      [
        { failing: ["git -c"] },
        false,
        "the Stop hook failed: git -c url.https://github.com/.pushInsteadOf=git@github.com: exited 1: git failed",
      ],
    ];

    for (const [fake, stopHookActive, reason] of cases) {
      const line = await outcomeOf(fake, stopHookActive);

      expect(line).toMatchObject({ outcome: "not-published", reason });
      expect(Object.keys(line ?? {})).toEqual(["at", "session", "worktree", "branch", "head", "outcome", "reason"]);
    }
  });

  test("a hook that throws before it reads the branch still leaves its line, then throws", async () => {
    const found = world({ failing: ["git rev-parse HEAD"] });

    expect(stopIn(found)).rejects.toThrow("git rev-parse HEAD exited 1");
    await stopIn(found).catch(() => {});

    expect(found.outcomes[0]?.line).toMatchObject({
      worktree: found.root,
      branch: null,
      head: null,
      outcome: "not-published",
      reason: "the Stop hook failed: git rev-parse HEAD exited 1: git failed",
    });
  });
});

describe("transcript", () => {
  test("a user turn opening with the marker makes the session a fork; the marker elsewhere does not", () => {
    expect(hasForkMarker([{ type: "user", message: { content: `${FORK_MARKER} are you done?` } }])).toBe(true);
    expect(hasForkMarker([{ type: "user", message: { content: [{ text: ` ${FORK_MARKER} q` }] } }])).toBe(true);
    expect(hasForkMarker([{ type: "user", message: { content: `the spec names ${FORK_MARKER}` } }])).toBe(false);
    expect(hasForkMarker([{ type: "assistant", message: { content: `${FORK_MARKER} q` } }])).toBe(false);
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
