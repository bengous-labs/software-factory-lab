import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as fc from "fast-check";

import { decodeJson } from "../../lib/json.ts";
import type { Run, RunOptions } from "../../lib/run.port.ts";
import { pushArgs } from "../shared/author.live.ts";
import { DONE_SCHEMA } from "./decide.ts";
import { BODY_REQUEST, doneQuestionOf } from "./done-judge.prompt.ts";
import { stop } from "./hook.live.ts";
import { FORK_FLAG, ListedPrs, StopInput } from "./publish.live.ts";
import type { Answer } from "./publish.live.ts";
import {
  AUTHOR_ENV,
  draftPr,
  FINISHED,
  git,
  HEAD,
  input,
  readyPr,
  stopIn,
  thread,
  TOKEN,
  TOKEN_FILE,
  UNFINISHED,
  world,
  writes,
} from "./stop.fixtures.ts";
import type { Fake, OutcomeLine, World } from "./stop.fixtures.ts";

const closedPr = (state: string, head = HEAD, isCrossRepository = false): string =>
  JSON.stringify([{ number: 146, headRefOid: head, state, isCrossRepository }]);

/** The body `gh pr create` reads on stdin when the hook opens the PR from `branch` with the fork's `forkBody`. */
async function bodyOf(branch: string, forkBody: string): Promise<string | undefined> {
  const found = world({ branch, forkBody });
  await stopIn(found);

  return found.calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.options.stdin;
}

const REPO = resolve(import.meta.dir, "..", "..", "..");

const FORK_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: `cd "${REPO}" && bun "${REPO}/factory/bin/fork-guard.ts"`, timeout: 30 }],
      },
    ],
  },
});

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

describe("the guard of a fork", () => {
  test("the settings a fork gets name a script of the factory", () => {
    expect(existsSync(join(REPO, "factory", "bin", "fork-guard.ts"))).toBe(true);
  });
});

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
      expect(found.relays).toEqual([{ pr: 12, session: "S1", headless: null, checkout: main }]);
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
    expect(opened.relays).toEqual([{ pr: 12, session: "S1", headless: null, checkout: opened.checkout }]);
    expect(opened.records).toContainEqual({ step: "relay", pr: 12, relay: "started" });

    const pushed = world({ listed: readyPr("e".repeat(40)) });

    expect(await stopIn(pushed)).toEqual({ kind: "allow" });
    expect(pushed.relays).toEqual([{ pr: 12, session: "S1", headless: null, checkout: pushed.checkout }]);
  });

  test("the stop of any other Author: its forks name no key helper, its relay no headless resume, its outcome no API Worker", async () => {
    const found = world();

    await stopIn(found);

    expect(found.calls.find((call) => call.argv[0] === "claude")?.argv).toContain(FORK_SETTINGS);
    expect(found.relays[0]?.headless).toBeNull();
    expect(found.outcomes[0]?.line.api).toBe(false);
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

  test("the Author's token reaches no command line, no log record and no outcome line", async () => {
    const found = world({ listed: draftPr("e".repeat(40)), threads: [thread("T1", "nit")] });
    await stopIn(found);

    const written = JSON.stringify([found.calls.map((call) => call.argv), found.records, found.outcomes]);

    expect(found.calls.some((call) => call.argv.includes("push"))).toBe(true);
    expect(found.outcomes).toHaveLength(1);
    expect(written).not.toContain(TOKEN);
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
      reason: `The Stop hook found no Author token at ${missing}, so nothing was published. The Owner provisions it (factory/install/AGENTS.md). Stop, and ask no question.`,
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
      "api",
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
      expect(Object.keys(line ?? {})).toEqual([
        "at",
        "session",
        "api",
        "worktree",
        "branch",
        "head",
        "outcome",
        "reason",
      ]);
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
