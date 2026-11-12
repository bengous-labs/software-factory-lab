import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import type { Ran, Run, RunOptions } from "../../lib/run.port.ts";
import { threadsQueryOf } from "../shared/findings.ts";
import { fixedRecordBodyOf } from "../stop/decide.ts";
import type { Env } from "./env.ts";
import {
  againPoster,
  api,
  call as apiCall,
  checkSetter,
  conversationReader,
  devRunsReader,
  draftConverter,
  gh,
  issueOpener,
  labelEventsReader,
  mutate,
  ownerCommenter,
  readOrGone,
  reviewsReader,
  send,
  stateWriter,
  threadLoginsOf,
  threadsOf,
  threadsResolver,
} from "./github.ts";
import { commandsAnswering, labeled, ok, page, runIn, WHERE } from "./merge-bot.fixtures.ts";
import type { CheckRun, LabelEvent } from "./merge-bot.fixtures.ts";
import { checkRunBodyOf, ciRunsPathsOf, devRedOf, humanLabelByOf, PostedComment, stateCommentIn } from "./readings.ts";
import { rangeRefspecsOf } from "./routing-inputs.ts";

describe("conversationReader", () => {
  test("reads every page of the PR's conversation, so the Author's record past the first 100 comments is found", async () => {
    const record = fixedRecordBodyOf({ comment: null, fixed: [] }, ["T1"]) ?? "";
    const pages = [page(1, 100), [...page(101, 5), { id: 106, user: { login: "bengous-labs-author" }, body: record }]];
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      return Promise.resolve({ code: 0, stdout: JSON.stringify(pages), stderr: "" });
    };

    const comments = await conversationReader(runner)(WHERE, 12);

    expect(calls).toEqual([
      ["gh", "api", "-X", "GET", "--paginate", "--slurp", "repos/o/r/issues/12/comments?per_page=100"],
    ]);
    expect(comments).toHaveLength(106);
    expect(
      stateCommentIn(comments, { appLogin: "bengous-labs-agents[bot]", authorLogin: "bengous-labs-author" }).fixed,
    ).toEqual(new Set(["T1"]));
  });
});

describe("stateWriter", () => {
  test("edits the comment it names, or posts a new one and gives the id GitHub answers", async () => {
    const calls: Array<{ argv: string[]; body: string }> = [];

    const runner: Run = (argv, options) => {
      calls.push({
        argv: [...argv],
        body: decodeJson(Schema.Struct({ body: Schema.String }), "a write", options.stdin ?? "").body,
      });

      return Promise.resolve({
        code: 0,
        stdout: argv[3] === "POST" ? '{"id":4242,"body":"x"}' : "not json",
        stderr: "",
      });
    };

    expect(await stateWriter(runner)(WHERE, 12, 7, "edited")).toBe(7);
    expect(await stateWriter(runner)(WHERE, 12, null, "posted")).toBe(4242);
    expect(calls).toEqual([
      { argv: ["gh", "api", "-X", "PATCH", "repos/o/r/issues/comments/7", "--input", "-"], body: "edited" },
      { argv: ["gh", "api", "-X", "POST", "repos/o/r/issues/12/comments", "--input", "-"], body: "posted" },
    ]);
  });
});

const filler = (count: number): LabelEvent[] =>
  Array.from({ length: count }, () => ({
    event: "mentioned",
    actor: { login: "x" },
    created_at: "2026-11-05T09:00:00Z",
  }));

describe("labelEventsReader", () => {
  test("reads every page of the PR's events, so a labeled event past the first 100 is found", async () => {
    const pages = [filler(100), [...filler(20), labeled("land:human", "agents[bot]", "2026-11-05T11:00:00Z")]];
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      return Promise.resolve({ code: 0, stdout: JSON.stringify(pages), stderr: "" });
    };

    const events = await labelEventsReader(runner)(WHERE, 12);

    expect(calls).toEqual([
      ["gh", "api", "-X", "GET", "--paginate", "--slurp", "repos/o/r/issues/12/events?per_page=100"],
    ]);
    expect(events).toHaveLength(121);
    expect(humanLabelByOf(events, ["land:human"], { appLogin: "agents[bot]", authorLogin: "author" })).toBe(
      "merge-bot",
    );
  });
});

/** A runner every command of which succeeds with an empty JSON object. */
const answersEmpty: Run = () => Promise.resolve({ code: 0, stdout: "{}", stderr: "" });

describe("issueOpener", () => {
  test("opens the issue on the repository with its title and body as they are, and answers its number", async () => {
    const calls: Array<{ argv: string[]; stdin: string | undefined }> = [];

    const runner: Run = (argv, options) => {
      calls.push({ argv: [...argv], stdin: options.stdin });

      return Promise.resolve({ code: 0, stdout: JSON.stringify({ number: 31, title: "t" }), stderr: "" });
    };

    const issue = { title: "Follow up #12: Important findings landed open", body: "- Important in `a.ts`" };

    expect(await issueOpener(runner)(WHERE, issue)).toBe(31);
    expect(calls).toEqual([
      { argv: ["gh", "api", "-X", "POST", "repos/o/r/issues", "--input", "-"], stdin: JSON.stringify(issue) },
    ]);
  });

  test("an answer with no issue number fails, naming the endpoint", () => {
    expect(issueOpener(answersEmpty)(WHERE, { title: "t", body: "b" })).rejects.toThrow("gh api repos/o/r/issues");
  });
});

describe("ownerCommenter", () => {
  test("posts an owner-comment step as a new comment on the PR, with its body as is", async () => {
    const calls: Array<{ argv: string[]; stdin: string | undefined }> = [];

    const runner: Run = (argv, options) => {
      calls.push({ argv: [...argv], stdin: options.stdin });

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };

    await ownerCommenter(runner)(WHERE, 12, "Only the Owner's Land approval counts.");

    expect(calls).toEqual([
      {
        argv: ["gh", "api", "-X", "POST", "repos/o/r/issues/12/comments", "--input", "-"],
        stdin: JSON.stringify({ body: "Only the Owner's Land approval counts." }),
      },
    ]);
  });
});

describe("checkSetter", () => {
  test("posts the body checkRunBodyOf gives to the repository's check-runs", async () => {
    const calls: Array<{ argv: string[]; stdin: string | undefined }> = [];

    const runner: Run = (argv, options) => {
      calls.push({ argv: [...argv], stdin: options.stdin });

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };

    const runUrl = "https://github.com/o/r/actions/runs/42";
    const head = "c".repeat(40);
    const check = { kind: "success", summary: "Landable." } as const;

    await checkSetter(runner)({ ...WHERE, runUrl }, "land-gate", head, check);

    expect(calls).toEqual([
      {
        argv: ["gh", "api", "-X", "POST", "repos/o/r/check-runs", "--input", "-"],
        stdin: JSON.stringify(checkRunBodyOf("land-gate", head, check, runUrl)),
      },
    ]);
  });
});

/** A runner whose every command GitHub refuses. */
const REFUSED: Run = () => Promise.resolve({ code: 1, stdout: "", stderr: "HTTP 502" });

describe("draftConverter", () => {
  test("sends the PR back to draft with one GraphQL mutation that names its node id", async () => {
    const calls: Array<{ argv: string[]; stdin: string | undefined }> = [];

    const runner: Run = (argv, options) => {
      calls.push({ argv: [...argv], stdin: options.stdin });

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };

    await draftConverter(runner)(WHERE, "PR_node1");

    expect(calls).toEqual([
      {
        argv: ["gh", "api", "-X", "POST", "graphql", "--input", "-"],
        stdin: JSON.stringify({
          query: "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}",
          variables: { id: "PR_node1" },
        }),
      },
    ]);
  });

  test("a conversion GitHub refuses throws, so the round is not recorded and a later run sends the PR back again", () => {
    expect(draftConverter(REFUSED)(WHERE, "PR_node1")).rejects.toThrow("gh api -X exited 1: HTTP 502");
  });
});

describe("threadsResolver", () => {
  test("resolves each thread, in its order, and stops at the first GitHub refuses", async () => {
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      return Promise.resolve(
        argv.includes("id=T2") ? { code: 1, stdout: "", stderr: "HTTP 502" } : { code: 0, stdout: "{}", stderr: "" },
      );
    };

    await threadsResolver(runner)(WHERE, ["T1"]);

    expect(calls).toEqual([
      [
        "gh",
        "api",
        "graphql",
        "-f",
        "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}",
        "-f",
        "id=T1",
      ],
    ]);
    expect(threadsResolver(runner)(WHERE, ["T2", "T3"])).rejects.toThrow("gh api graphql exited 1: HTTP 502");
    expect(calls.some((call) => call.includes("id=T3"))).toBe(false);
  });
});

describe("againPoster", () => {
  test("posts each reply in its review thread, in its order", async () => {
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };

    await againPoster(runner)(WHERE, [
      { thread: "T1", body: "still wrong" },
      { thread: "T2", body: "again" },
    ]);

    const reply =
      "query=mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}";

    expect(calls).toEqual([
      ["gh", "api", "graphql", "-f", reply, "-f", "id=T1", "-f", "body=still wrong"],
      ["gh", "api", "graphql", "-f", reply, "-f", "id=T2", "-f", "body=again"],
    ]);
  });

  test("a reply GitHub refuses throws, so the round is not recorded and a later run posts what is left", () => {
    expect(againPoster(REFUSED)(WHERE, [{ thread: "T1", body: "still wrong" }])).rejects.toThrow(
      "gh api graphql exited 1: HTTP 502",
    );
  });
});

describe("devRunsReader", () => {
  const DEV_HEAD = "43e27e7".padEnd(40, "0");

  const QUEUE_SUITE = 1;
  const PUSH_SUITE = 2;
  const APP_SUITE = 3;

  /** The merge queue's suite, CI's push suite and the App's suite on DEV_HEAD. */
  const SUITES = {
    check_suites: [
      { id: QUEUE_SUITE, head_branch: "gh-readonly-queue/dev/pr-1-a", created_at: "t" },
      { id: PUSH_SUITE, head_branch: "dev", created_at: "t" },
      { id: APP_SUITE, head_branch: "dev", created_at: "t" },
    ],
  };

  /** `origin/dev` is DEV_HEAD, with SUITES, and `validate` and `mutation` answer these check runs, the queue's listed first. */
  function devRunner(validate: readonly CheckRun[], mutation: readonly CheckRun[]) {
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      if (argv[0] === "git") {
        return Promise.resolve(ok(argv[1] === "rev-parse" ? `${DEV_HEAD}\n` : ""));
      }

      const path = argv.at(-1) ?? "";

      const answer = path.includes("/check-suites")
        ? SUITES
        : { check_runs: path.endsWith("=validate") ? validate : mutation };

      return Promise.resolve(ok(JSON.stringify(answer)));
    };

    return { runner, calls };
  }

  test("rangeOf fetches dev once, beside the PR's base when that is another branch", () => {
    expect(rangeRefspecsOf({ number: 12, base: { ref: "dev" } })).toEqual([
      "+refs/pull/12/head:refs/lab/pr-12",
      "+refs/heads/dev:refs/remotes/origin/dev",
    ]);
    expect(rangeRefspecsOf({ number: 12, base: { ref: "main" } })).toEqual([
      "+refs/pull/12/head:refs/lab/pr-12",
      "+refs/heads/main:refs/remotes/origin/main",
      "+refs/heads/dev:refs/remotes/origin/dev",
    ]);
  });

  test("reads origin/dev's check suites and validate and mutation on its head, and no workflow run", async () => {
    const { runner, calls } = devRunner(
      [runIn(PUSH_SUITE, "completed", "success")],
      [runIn(PUSH_SUITE, "completed", "success")],
    );

    const runs = await devRunsReader(runner)(WHERE);

    expect(calls).toEqual([
      ["git", "rev-parse", "origin/dev"],
      ["gh", "api", "-X", "GET", `repos/o/r/commits/${DEV_HEAD}/check-suites?per_page=100`],
      ...ciRunsPathsOf("o/r", DEV_HEAD).map((path) => ["gh", "api", "-X", "GET", path]),
    ]);
    expect(devRedOf(runs)).toBe(false);
  });

  test("the merge queue's skipped mutation, listed first, does not read as red", async () => {
    const { runner } = devRunner(
      [runIn(QUEUE_SUITE, "completed", "success"), runIn(PUSH_SUITE, "completed", "success")],
      [runIn(QUEUE_SUITE, "completed", "skipped"), runIn(PUSH_SUITE, "in_progress", null)],
    );

    expect(devRedOf(await devRunsReader(runner)(WHERE))).toBe(false);
  });

  test("the merge queue's green validate, listed first, does not hide a red push validate", async () => {
    const { runner } = devRunner(
      [runIn(QUEUE_SUITE, "completed", "success"), runIn(PUSH_SUITE, "completed", "failure")],
      [runIn(QUEUE_SUITE, "completed", "skipped"), runIn(PUSH_SUITE, "completed", "success")],
    );

    expect(devRedOf(await devRunsReader(runner)(WHERE))).toBe(true);
  });

  test("a red run in another app's suite on dev is not read", async () => {
    const { runner } = devRunner(
      [runIn(APP_SUITE, "completed", "failure", "bengous-labs-agents"), runIn(PUSH_SUITE, "completed", "success")],
      [runIn(APP_SUITE, "completed", "failure", "bengous-labs-agents"), runIn(PUSH_SUITE, "completed", "success")],
    );

    expect(devRedOf(await devRunsReader(runner)(WHERE))).toBe(false);
  });
});

/** Where each command ran: the `cwd` of each call. */
const cwdsOf = (calls: ReadonlyArray<{ readonly cwd: string | undefined }>): Array<string | undefined> =>
  calls.map((done) => done.cwd);

describe("where the Merge bot runs its commands", () => {
  test("every read and write runs in the job's checkout", async () => {
    const devHead = "d".repeat(40);
    const [validate = "", mutation = ""] = ciRunsPathsOf("o/r", devHead);

    const { env, calls } = commandsAnswering({
      "api -X GET --paginate --slurp repos/o/r/pulls/12/reviews?per_page=100": ok("[[]]"),
      "api -X GET --paginate --slurp repos/o/r/issues/12/events?per_page=100": ok("[[]]"),
      "api -X GET --paginate --slurp repos/o/r/issues/12/comments?per_page=100": ok("[[]]"),
      "rev-parse origin/dev": ok(`${devHead}\n`),
      [`api -X GET repos/o/r/commits/${devHead}/check-suites?per_page=100`]: ok('{"check_suites":[]}'),
      [`api -X GET ${validate}`]: ok('{"check_runs":[]}'),
      [`api -X GET ${mutation}`]: ok('{"check_runs":[]}'),
      [`api graphql -f query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}} -f id=T1`]:
        ok("{}"),
      [`api graphql -f query=mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}} -f id=T1 -f body=again`]:
        ok("{}"),
    });

    expect(await reviewsReader(env.run)(WHERE, 12)).toEqual([]);
    expect(await labelEventsReader(env.run)(WHERE, 12)).toEqual([]);
    expect(await conversationReader(env.run)(WHERE, 12)).toEqual([]);
    expect(await devRunsReader(env.run)(WHERE)).toEqual([{ check_runs: [] }, { check_runs: [] }]);
    await threadsResolver(env.run)(WHERE, ["T1"]);
    await againPoster(env.run)(WHERE, [{ thread: "T1", body: "again" }]);

    expect(calls).toHaveLength(9);
    expect(new Set(cwdsOf(calls))).toEqual(new Set([WHERE.cwd]));
  });
});

/** The Merge bot's ports over a run that answers every command with `ran`, and each call with its options as given. */
function answeringAll(ran: Ran) {
  const calls: Array<{ argv: string[]; options: RunOptions }> = [];

  const { env } = commandsAnswering({});

  const run: Run = (argv, options) => {
    calls.push({ argv: [...argv], options });

    return Promise.resolve(ran);
  };

  const ports: Env = { ...env, run };

  return { env: ports, calls };
}

/** A read GitHub failed with a 5xx, after printing on both streams. */
const SERVER_ERROR: Ran = { code: 1, stdout: "out\n", stderr: "gh: Server Error (HTTP 502)\n" };

describe("readOrGone", () => {
  test("reads the endpoint with gh in the job's checkout and gives what it printed", async () => {
    const { env, calls } = answeringAll(ok('{"id":1}\n'));

    expect(await readOrGone(env.run, WHERE, "repos/o/r/pulls/12")).toBe('{"id":1}\n');
    expect(calls).toEqual([{ argv: ["gh", "api", "repos/o/r/pulls/12"], options: { cwd: "/tmp" } }]);
  });

  test("a read GitHub answers 404 is gone: null", async () => {
    const { env } = answeringAll({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" });

    expect(await readOrGone(env.run, WHERE, "repos/o/r/pulls/12")).toBeNull();
  });

  test("any other failure throws with the path, the exit code and what gh printed, its error first, trimmed", () => {
    expect(readOrGone(answeringAll(SERVER_ERROR).env.run, WHERE, "repos/o/r/pulls/12")).rejects.toThrow(
      new Error("gh api repos/o/r/pulls/12 exited 1: gh: Server Error (HTTP 502)"),
    );
    expect(
      readOrGone(
        answeringAll({ code: 2, stdout: " printed only here \n", stderr: "" }).env.run,
        WHERE,
        "repos/o/r/pulls/12",
      ),
    ).rejects.toThrow(new Error("gh api repos/o/r/pulls/12 exited 2: printed only here"));
  });
});

describe("the calls a step makes through the job's ports", () => {
  test("gh runs in the job's checkout, and passes stdin only when it is given", async () => {
    const { env, calls } = answeringAll(ok("printed"));

    expect(await gh(env, ["pr", "list"])).toBe("printed");
    expect(await gh(env, ["api", "graphql", "--input", "-"], "{}")).toBe("printed");
    expect(calls).toStrictEqual([
      { argv: ["gh", "pr", "list"], options: { cwd: "/tmp" } },
      { argv: ["gh", "api", "graphql", "--input", "-"], options: { cwd: "/tmp", stdin: "{}" } },
    ]);
  });

  test("a call with no body sends none; one with a body sends it as JSON on stdin", async () => {
    const { env, calls } = answeringAll(ok("answered"));

    expect(await apiCall(env, "DELETE", "repos/o/r/issues/12/labels/land-ok")).toBe("answered");
    expect(await apiCall(env, "PATCH", "repos/o/r/pulls/12", { state: "closed" })).toBe("answered");
    expect(calls).toStrictEqual([
      { argv: ["gh", "api", "-X", "DELETE", "repos/o/r/issues/12/labels/land-ok"], options: { cwd: "/tmp" } },
      {
        argv: ["gh", "api", "-X", "PATCH", "repos/o/r/pulls/12", "--input", "-"],
        options: { cwd: "/tmp", stdin: '{"state":"closed"}' },
      },
    ]);
  });

  test("send makes the call and reads nothing of its answer", async () => {
    const { env, calls } = answeringAll(ok("not json"));

    await send(env, "POST", "repos/o/r/issues/12/labels", { labels: ["land:auto"] });
    expect(calls).toStrictEqual([
      {
        argv: ["gh", "api", "-X", "POST", "repos/o/r/issues/12/labels", "--input", "-"],
        options: { cwd: "/tmp", stdin: '{"labels":["land:auto"]}' },
      },
    ]);
  });

  test("api reads the endpoint with a GET and decodes its answer by the schema", async () => {
    const { env, calls } = answeringAll(ok('{"id":4242,"body":"x"}'));

    expect(await api(env, PostedComment, "repos/o/r/issues/comments/4242")).toEqual({ id: 4242 });
    expect(calls).toStrictEqual([
      { argv: ["gh", "api", "-X", "GET", "repos/o/r/issues/comments/4242"], options: { cwd: "/tmp" } },
    ]);
  });

  test("a mutation posts its query and variables to GraphQL and reads nothing of the answer", async () => {
    const { env, calls } = answeringAll(ok("not json"));

    await mutate(env, "mutation($id:ID!){x(id:$id)}", { id: "PR_1" });
    expect(calls).toStrictEqual([
      {
        argv: ["gh", "api", "-X", "POST", "graphql", "--input", "-"],
        options: {
          cwd: "/tmp",
          stdin: JSON.stringify({ query: "mutation($id:ID!){x(id:$id)}", variables: { id: "PR_1" } }),
        },
      },
    ]);
  });

  test("the threads of a PR are read by GraphQL with the repository's owner and name, and are the nodes it answers", async () => {
    const { env, calls } = answeringAll(
      ok(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })),
    );

    expect(await threadsOf(env, 12)).toEqual([]);
    expect(calls).toStrictEqual([
      {
        argv: ["gh", "api", "-X", "POST", "graphql", "--input", "-"],
        options: {
          cwd: "/tmp",
          stdin: JSON.stringify({ query: threadsQueryOf(12), variables: { owner: "o", name: "r" } }),
        },
      },
    ]);
  });

  test("a thread's words are read as the App's by its GraphQL login, the Author's and the Owner's by theirs", () => {
    const { env } = answeringAll(ok(""));

    expect(threadLoginsOf(env)).toEqual({ app: "the-app", author: "the-author", owner: "the-owner" });
  });
});
