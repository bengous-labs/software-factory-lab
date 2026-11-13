/**
 * What the tests of the Stop hook share: a world of fakes a stop runs in, with the git, gh and fork answers
 * it reads and the calls, log records and outcomes it leaves, and a git repository with a worktree.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { worksInClone } from "../../lib/author-session.ts";
import { decodeJson } from "../../lib/json.ts";
import type { Ran, Run, RunOptions } from "../../lib/run.port.ts";
import { apiClonesDirOf } from "../shared/api-worker.ts";
import { conversationArgsOf } from "../shared/conversation.ts";
import type { RelayStart } from "../shared/relay.port.ts";
import { doneQuestionOf } from "./done-judge.prompt.ts";
import { stop } from "./hook.live.ts";
import type { Answer, Deps, StopInput, StopLogRecord } from "./publish.live.ts";

export const HEAD = "d".repeat(40);

export const TOKEN = "t0k";

function tokenFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "author-")), "author-token");
  writeFileSync(path, `${TOKEN}\n`);

  return path;
}

export const TOKEN_FILE = tokenFile();

/**
 * The environment of an Author's session: the marker the launcher's settings file gives, the token's
 * file, and the home its forks' sandbox denies.
 */
export const AUTHOR_ENV = { LAB_AUTHOR: "1", LAB_AUTHOR_TOKEN_FILE: TOKEN_FILE, HOME: "/home/me" };

/**
 * The environment of a background Worker Dispatch launched: an Author's, and the main checkout its
 * settings name, which makes it a session that works in a clone.
 */
export const BACKGROUND_WORKER_ENV = { ...AUTHOR_ENV, LAB_MAIN_CHECKOUT: "/main" };

/** The environment of an API Worker's session: a Worker's in a clone, and the marker of its settings file. */
export const API_WORKER_ENV = { ...BACKGROUND_WORKER_ENV, LAB_API_WORKER: "1" };

export interface Call {
  readonly argv: readonly string[];
  readonly options: RunOptions;
}

const ok = (stdout: string): Promise<Ran> => Promise.resolve({ code: 0, stdout, stderr: "" });

const DONE_OPENING = doneQuestionOf([]).split("\n")[0] ?? "";

const MODEL_USAGE = {
  "claude-haiku-5-5": { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 9000, cacheCreationInputTokens: 700 },
};

/** One line of `.lab/outcomes.log`, as the hook writes it for a stop. */
export const OutcomeLine = Schema.Struct({
  at: Schema.String,
  session: Schema.String,
  api: Schema.Boolean,
  worktree: Schema.String,
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["published", "asked", "not-published"]),
  pr: Schema.optionalKey(Schema.Finite),
  reason: Schema.optionalKey(Schema.String),
});

export type OutcomeLine = typeof OutcomeLine.Type;

export const FINISHED = { finished: true, question: "", reason: "done and tested", rejections: [] };

export const UNFINISHED = { finished: false, question: "", reason: "a test is missing", rejections: [] };

/** A review thread of the App as the threads query gives it. */
export function thread(id: string, severity: "important" | "nit" | "pre_existing", resolved = false) {
  const label = { important: "Important", nit: "Nit", pre_existing: "Pre-existing" }[severity];

  return {
    id,
    isResolved: resolved,
    isOutdated: false,
    resolvedBy: null,
    path: "app/src/cli.ts",
    line: 7,
    comments: {
      nodes: [
        {
          author: { login: "bengous-labs-agents" },
          body: `**${label}**: ${id} is wrong\n\nscenario\n\n<!-- lab-finding severity=${severity} -->`,
          url: `https://github.com/o/r/pull/12#discussion_${id}`,
        },
      ],
    },
  };
}

const threadsAnswer = (threads: readonly unknown[]): string =>
  JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } });

/** The fake's say on the session and the branch. */
export interface Fake {
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
  /** Whether an earlier stop asked the Worker for the Stop checks on this head: the hook's record of it is there. */
  readonly checksAsked: boolean;
}

export interface World {
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

export const draftPr = (head = HEAD, isCrossRepository = false): string =>
  JSON.stringify([{ number: 12, isDraft: true, headRefOid: head, isCrossRepository }]);

export const readyPr = (head = HEAD): string =>
  JSON.stringify([{ number: 12, isDraft: false, headRefOid: head, isCrossRepository: false }]);

/** A fake of git, gh and claude for an Author's session in a worktree, on `branch`, one commit ahead of dev. */
export function world(fake: Partial<Fake> = {}): World {
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
    checksAsked = true,
  } = fake;

  const checkout = fake.checkout ?? mkdtempSync(join(tmpdir(), "stop-"));

  const tree = worksInClone(env)
    ? join(apiClonesDirOf(AUTHOR_ENV.HOME), "x")
    : join(checkout, ".claude", "worktrees", "x");

  const root = mainCheckout ? checkout : tree;
  const calls: Call[] = [];
  const relays: RelayStart[] = [];

  if (checksAsked) {
    // Where the hook keeps its state: the main checkout for a Worker in a clone, else the worktree.
    const stateDir = join(worksInClone(env) ? checkout : root, ".lab", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `gates-${head}`), "left\n");
  }

  const outcomes: Array<{ checkout: string; line: OutcomeLine }> = [];
  const records: StopLogRecord[] = [];
  let asked = 0;

  const exact = new Map([
    ["git rev-parse --show-toplevel", `${root}\n`],
    ["git rev-parse --absolute-git-dir", mainCheckout ? `${checkout}/.git\n` : `${checkout}/.git/worktrees/x\n`],
    ["git rev-parse --path-format=absolute --git-common-dir", `${checkout}/.git\n`],
    ["git rev-parse HEAD", `${head}\n`],
    ["git status --porcelain --ignore-submodules=all", dirty ? " M app/src/cli.ts\n" : ""],
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
    checkout,
    startRelay: (relay) => {
      relays.push(relay);

      return "started";
    },
    recordOutcome: (where, line) => {
      outcomes.push({ checkout: where, line: decodeJson(OutcomeLine, "an outcome line", line) });
    },
    realpath: (path) => path,
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
export const stopIn = (found: World, stopHookActive = false): Promise<Answer> =>
  stop(input(found.root, stopHookActive), found.deps, found.log);

export function input(root: string, stopHookActive = false): StopInput {
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
export function writes(calls: readonly Call[]): string[] {
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

    if (line.startsWith("gh api -X PATCH")) {
      return [`edit ${call.argv[4]}`];
    }

    const undo = call.argv.includes("--undo") ? " --undo" : "";

    return /^gh pr (create|edit|comment|ready)/u.test(line) ? [`${call.argv.slice(1, 3).join(" ")}${undo}`] : [];
  });
}

// An inherited GIT_DIR would point a fixture's git at the real repository; the test layer cannot import fixtureEnv.
const FIXTURE_ENV = Object.fromEntries(
  Object.entries(process.env).flatMap(([name, value]) =>
    name.startsWith("GIT_") || value === undefined ? [] : [[name, value] as const],
  ),
);

/** Runs git in `cwd` of a fixture repository, as a test author with no signing. */
export async function git(cwd: string, ...args: string[]): Promise<Ran> {
  const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
  const child = Bun.spawn(["git", ...identity, ...args], { cwd, env: FIXTURE_ENV, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, stdout, stderr };
}
