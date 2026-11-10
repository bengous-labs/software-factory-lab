import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { AUTHOR_MARK, REJECT_MARK } from "../author-mark.ts";
import {
  EarlierThreads,
  earlierThreadsOf,
  findingFileOf,
  graphqlLogin,
  markerOf,
  movedLineOf,
  nitPathsOf,
  openFindingsOf,
  openImportantOf,
  rejectedImportantOf,
  reviewOfBody,
  ReviewThreads,
  severityOfBody,
  threadsQueryOf,
} from "./findings.ts";
import type { ReviewThread } from "./findings.ts";
import { reviewMarkerOf } from "./post-plan.ts";
import type { ReviewRequest } from "./review-report.ts";

const APP = "bengous-labs-agents";

const AUTHOR = "bengous-labs-author";

/** The App, the Author's machine account and the Owner: the logins a review thread's words are read from. */
const LOGINS = { app: APP, author: AUTHOR, owner: "bengous" };

interface ThreadOptions {
  readonly isResolved?: boolean;
  /** The finding's author; null for a deleted user. */
  readonly by?: string | null;
  readonly line?: number | null;
}

const thread = (
  body: string,
  replies: ReadonlyArray<readonly [string, string]> = [],
  { isResolved = false, by = APP, line = 3 }: ThreadOptions = {},
): ReviewThread => ({
  id: "T",
  isResolved,
  path: "a.ts",
  line,
  comments: {
    nodes: [
      { author: by === null ? null : { login: by }, body },
      ...replies.map(([login, reply]) => ({ author: { login }, body: reply })),
    ],
  },
});

const IMPORTANT = `**Important**: off by one\n\nwhy\n\n${markerOf("important")}`;

const NIT = `**Nit**: a name\n\nwhy\n\n${markerOf("nit")}`;

describe("the finding marker", () => {
  test("each severity's marker reads back as that severity; a comment with no marker, or another word, reads as none", () => {
    for (const severity of ["important", "nit", "pre_existing"] as const) {
      expect(severityOfBody(`**x**: y\n\n${markerOf(severity)}`)).toBe(severity);
    }

    expect(markerOf("important")).toBe("<!-- lab-finding severity=important -->");
    expect(severityOfBody("a human comment")).toBeNull();
    expect(severityOfBody("<!-- lab-finding severity=minor -->")).toBeNull();
  });
});

describe("the review threads", () => {
  test("the query names the PR and takes the repository as variables", () => {
    expect(threadsQueryOf(12)).toContain("query($owner:String!,$name:String!){repository(owner:$owner,name:$name)");
    expect(threadsQueryOf(12)).toContain("pullRequest(number:12)");
    expect(threadsQueryOf(12)).toContain("comments(first:20){nodes{author{login} body pullRequestReview{body}}}");
  });

  test("a thread whose author was deleted reads with a null author; an answer outside the schema is refused", () => {
    const answer = {
      data: { repository: { pullRequest: { reviewThreads: { nodes: [thread("x", [], { by: null, line: null })] } } } },
    };

    expect(decodeJson(ReviewThreads, "threads", JSON.stringify(answer))).toEqual(answer);

    const refused = { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "T" }] } } } } };

    expect(Result.isFailure(Schema.decodeUnknownResult(ReviewThreads)(refused))).toBe(true);
  });

  test("the App's login loses REST's [bot] suffix, and only at its end", () => {
    expect(graphqlLogin(`${APP}[bot]`)).toBe(APP);
    expect(graphqlLogin(APP)).toBe(APP);
    expect(graphqlLogin("a[bot]b")).toBe("a[bot]b");
  });
});

describe("openImportantOf", () => {
  test("counts the App's unresolved Important threads, and nothing else", () => {
    expect(
      openImportantOf(APP, [
        thread(IMPORTANT),
        thread(IMPORTANT, [["bengous", "Fixed in abc"]]),
        thread(IMPORTANT, [], { isResolved: true }),
        thread(NIT),
        thread(IMPORTANT, [], { by: "bengous" }),
        thread(IMPORTANT, [], { by: null }),
      ]),
    ).toEqual([
      { thread: "T", review: null },
      { thread: "T", review: null },
    ]);
    expect(openImportantOf(APP, [])).toEqual([]);
  });

  test("each open Important names the patch and round of the review that posted it", () => {
    expect(
      openImportantOf(APP, [
        postedIn(thread(IMPORTANT), { patch: "p1", round: 2 }, "a.ts"),
        { ...thread(IMPORTANT), id: "T2" },
      ]),
    ).toEqual([
      { thread: "T", review: { patch: "p1", round: 2 } },
      { thread: "T2", review: null },
    ]);
  });

  test("openFindingsOf lists the App's unresolved Important and Nit threads, each with its place and its first line without the label", () => {
    const security = `**Nit (security)**: reads &lt;token>\n\nwhy\n\n${markerOf("nit")}`;

    expect(
      openFindingsOf(APP, [
        thread(IMPORTANT),
        thread(NIT, [], { line: null }),
        thread(security),
        thread(NIT, [], { isResolved: true }),
        thread(`p\n\n${markerOf("pre_existing")}`),
        thread(IMPORTANT, [], { by: "bengous" }),
        thread("a human's comment", [], { by: "bengous" }),
      ]),
    ).toEqual([
      { thread: "T", path: "a.ts", line: 3, severity: "important", summary: "off by one" },
      { thread: "T", path: "a.ts", line: null, severity: "nit", summary: "a name" },
      { thread: "T", path: "a.ts", line: 3, severity: "nit", summary: "reads <token>" },
    ]);
  });

  test("a security pass's Important counts as any other, through the same marker, and reaches the next round's earlier findings", () => {
    const security = `**Important (security)**: the token reaches the log\n\nwhy\n\n${markerOf("important")}`;

    expect(severityOfBody(security)).toBe("important");
    expect(openImportantOf(APP, [thread(security), thread(IMPORTANT)])).toHaveLength(2);
    expect(earlierThreadsOf(LOGINS, [thread(security)]).map((earlier) => earlier.finding)).toEqual([
      "**Important (security)**: the token reaches the log",
    ]);
  });
});

const FIXED = `Fixed in abc1234: count the rejections apart\n\n${AUTHOR_MARK}`;

const REJECTED = `Rejected: the record is never written without reviewRounds\n\n${REJECT_MARK}\n\n${AUTHOR_MARK}`;

/** A resolved Important thread of the App with `replies`. */
const answered = (...replies: ReadonlyArray<readonly [string, string]>): ReviewThread =>
  thread(IMPORTANT, replies, { isResolved: true });

describe("rejectedImportantOf", () => {
  test("counts the App's resolved Important threads another login rejected with the reject mark, and nothing else", () => {
    expect(
      rejectedImportantOf(LOGINS, [
        thread(IMPORTANT, [[AUTHOR, REJECTED]], { isResolved: true }),
        thread(
          IMPORTANT,
          [
            [AUTHOR, FIXED],
            [AUTHOR, REJECTED],
          ],
          { isResolved: true },
        ),
        thread(IMPORTANT, [[AUTHOR, REJECTED]]),
        thread(IMPORTANT, [[AUTHOR, FIXED]], { isResolved: true }),
        thread(IMPORTANT, [[APP, REJECTED]], { isResolved: true }),
        thread(NIT, [[AUTHOR, REJECTED]], { isResolved: true }),
        thread(IMPORTANT, [[AUTHOR, REJECTED]], { isResolved: true, by: "bengous" }),
        thread(IMPORTANT, [[AUTHOR, REJECTED]], { isResolved: true, by: null }),
      ]),
    ).toBe(2);
    expect(rejectedImportantOf(LOGINS, [])).toBe(0);
  });

  test("the latest answer decides: a rejection fixed later is not rejected, and one the App replied after still is", () => {
    expect(rejectedImportantOf(LOGINS, [answered([AUTHOR, REJECTED], [AUTHOR, FIXED])])).toBe(0);
    expect(rejectedImportantOf(LOGINS, [answered([AUTHOR, REJECTED], [APP, "noted"])])).toBe(1);
    expect(earlierThreadsOf(LOGINS, [answered([AUTHOR, REJECTED], [AUTHOR, FIXED])])[0]?.reply).toBe(
      "bengous-labs-author: Rejected: the record is never written without reviewRounds / bengous-labs-author: Fixed in abc1234: count the rejections apart (thread resolved)",
    );
  });

  test("another login's reply is no answer: it neither rejects a thread nor hides the Author's rejection", () => {
    expect(rejectedImportantOf(LOGINS, [answered(["someone", REJECTED])])).toBe(0);
    expect(rejectedImportantOf(LOGINS, [answered([AUTHOR, REJECTED], ["someone", "it is not rejected"])])).toBe(1);
    expect(rejectedImportantOf(LOGINS, [answered(["bengous", REJECTED])])).toBe(1);
    expect(earlierThreadsOf(LOGINS, [answered([AUTHOR, REJECTED], ["someone", "Fixed, the Owner checked"])])).toEqual([
      {
        thread: "T",
        where: "a.ts:3",
        finding: "**Important**: off by one",
        reply:
          "bengous-labs-author: Rejected: the record is never written without reviewRounds (thread resolved: rejected by the Author)",
      },
    ]);
  });

  test("a thread answered before the reject mark existed is neither rejected nor open", () => {
    const before = [thread(IMPORTANT, [[AUTHOR, `Rejected: intended\n\n${AUTHOR_MARK}`]], { isResolved: true })];

    expect(rejectedImportantOf(LOGINS, before)).toBe(0);
    expect(openImportantOf(APP, before)).toEqual([]);
  });
});

/** `found` as the review of `posted` put it: its finding sits in the review whose body carries that marker. */
const postedIn = (
  found: ReviewThread,
  posted: { readonly patch: string; readonly round: 1 | 2 | 3 },
  path: string,
): ReviewThread => ({
  ...found,
  path,
  comments: {
    nodes: found.comments.nodes.map((comment, index) =>
      index === 0
        ? {
            ...comment,
            pullRequestReview: {
              body: `Review round ${posted.round}\n\n${reviewMarkerOf({ ...REQUEST, ...posted })}`,
            },
          }
        : comment,
    ),
  },
});

const REQUEST: ReviewRequest = {
  pr: 7,
  head: "a".repeat(40),
  base: "b".repeat(40),
  patch: "p1",
  round: 1,
  model: "claude-opus-5-5",
  effort: "high",
  security: false,
};

/** A Nit's comment as `post-plan.ts` writes it once its finding is anchored away from `place`. */
const MOVED_NIT = (place: string): string => `**Nit**: a name\n${movedLineOf(place)}\n\nwhy\n\n${markerOf("nit")}`;

describe("reviewOfBody", () => {
  test("reads the patch and round of the marker a posted review ends with; a body without one has none", () => {
    expect(reviewOfBody(`Review round 3\n\n${reviewMarkerOf({ ...REQUEST, patch: "p3", round: 3 })}`)).toEqual({
      patch: "p3",
      round: 3,
    });
    expect(reviewOfBody(reviewMarkerOf(REQUEST))).toEqual({ patch: "p1", round: 1 });
    expect(reviewOfBody("Looks good")).toBeNull();
  });
});

describe("findingFileOf", () => {
  test("a finding anchored away from its place is about the file its moved line names; any other, the file it sits on", () => {
    expect(findingFileOf("AGENTS.md", MOVED_NIT("scripts/lib/foo.ts:4"))).toBe("scripts/lib/foo.ts");
    expect(findingFileOf("AGENTS.md", MOVED_NIT("scripts/lib/foo.ts"))).toBe("scripts/lib/foo.ts");
    expect(findingFileOf("a.ts", MOVED_NIT("a.ts:120"))).toBe("a.ts");
    expect(findingFileOf("a.ts", NIT)).toBe("a.ts");
  });

  test("a moved line with long backtick runs reads in one pass, and an unclosed fence names no file", () => {
    const run = "`".repeat(20_000);

    expect(findingFileOf("a.ts", `At ${run}x${run}, outside this diff.`)).toBe("x");
    expect(findingFileOf("a.ts", `At ${run}x${run.slice(1)}, outside this diff.`)).toBe("a.ts");
  });

  test("a place that holds backticks reads back from the longer fence movedLineOf writes", () => {
    expect(findingFileOf("AGENTS.md", MOVED_NIT("a`b.ts:4"))).toBe("a`b.ts");
    expect(findingFileOf("AGENTS.md", MOVED_NIT("`a.ts`"))).toBe("`a.ts`");
  });
});

describe("nitPathsOf", () => {
  const ROUND_3 = { patch: "p3", round: 3 } as const;

  test("the files of the App's Nit threads of the review given, open or resolved, once each; none of another review's, an Important's or a human's", () => {
    expect(
      nitPathsOf(APP, ROUND_3, [
        postedIn(thread(NIT), ROUND_3, "b.ts"),
        postedIn(thread(NIT, [], { isResolved: true }), ROUND_3, "a.ts"),
        postedIn(thread(NIT), ROUND_3, "b.ts"),
        postedIn(thread(NIT), { patch: "p3", round: 2 }, "f.ts"),
        postedIn(thread(NIT), { patch: "p0", round: 3 }, "h.ts"),
        postedIn(thread(IMPORTANT), ROUND_3, "c.ts"),
        postedIn(thread(NIT, [], { by: "bengous" }), ROUND_3, "d.ts"),
        postedIn(thread(NIT, [], { by: null }), ROUND_3, "e.ts"),
        { ...thread(NIT), path: "g.ts" },
      ]),
    ).toEqual(["a.ts", "b.ts"]);
    expect(nitPathsOf(APP, ROUND_3, [])).toEqual([]);
    expect(nitPathsOf(APP, { patch: null, round: 3 }, [postedIn(thread(NIT), ROUND_3, "a.ts")])).toEqual([]);
  });

  test("a Nit anchored on another file, its own outside the diff, names neither; one moved within its own file names it", () => {
    expect(
      nitPathsOf(APP, ROUND_3, [
        postedIn(thread(MOVED_NIT("scripts/lib/foo.ts:4")), ROUND_3, "AGENTS.md"),
        postedIn(thread(MOVED_NIT("a.ts:120")), ROUND_3, "a.ts"),
      ]),
    ).toEqual(["a.ts"]);
  });
});

describe("earlierThreadsOf", () => {
  test("each of the App's findings, open or resolved, with the author's answers and its thread's state", () => {
    expect(
      earlierThreadsOf(LOGINS, [
        thread(
          IMPORTANT,
          [
            ["bengous", "Rejected: intended"],
            [APP, "noted"],
            ["bengous", "see the test"],
          ],
          { isResolved: true },
        ),
        thread(NIT, [], { line: null }),
      ]),
    ).toEqual([
      {
        thread: "T",
        where: "a.ts:3",
        finding: "**Important**: off by one",
        reply: "bengous: Rejected: intended / bengous: see the test (thread resolved)",
      },
      { thread: "T", where: "a.ts:?", finding: "**Nit**: a name", reply: "no answer (thread open)" },
    ]);
  });

  test("a placeholder escaped for GitHub reads back as written, in the finding and the answers", () => {
    const escaped = `**Important**: reads review-&lt;head>.json\n\nwhy\n\n${markerOf("important")}`;

    expect(
      earlierThreadsOf(LOGINS, [thread(escaped, [[AUTHOR, `Rejected: &lt;sha> holds it\n\n${AUTHOR_MARK}`]])]),
    ).toEqual([
      {
        thread: "T",
        where: "a.ts:3",
        finding: "**Important**: reads review-<head>.json",
        reply: "bengous-labs-author: Rejected: <sha> holds it (thread open)",
      },
    ]);
  });

  test("a human's answer is read as written: only the answers the Author escaped are read back", () => {
    expect(
      earlierThreadsOf(LOGINS, [thread(IMPORTANT, [["bengous", String.raw`the pattern &lt;word matches`]])]),
    ).toEqual([
      {
        thread: "T",
        where: "a.ts:3",
        finding: "**Important**: off by one",
        reply: String.raw`bengous: the pattern &lt;word matches (thread open)`,
      },
    ]);
  });

  test("the Author's machine account answers as the author: its replies reach the earlier findings", () => {
    expect(
      earlierThreadsOf(LOGINS, [thread(IMPORTANT, [["bengous-labs-author", "Fixed in abc: bound checked"]])]),
    ).toEqual([
      {
        thread: "T",
        where: "a.ts:3",
        finding: "**Important**: off by one",
        reply: "bengous-labs-author: Fixed in abc: bound checked (thread open)",
      },
    ]);
  });

  test("the author's answers read without their marks, a rejection with its thread's state", () => {
    expect(
      earlierThreadsOf(LOGINS, [
        thread(IMPORTANT),
        thread(IMPORTANT, [[AUTHOR, FIXED]], { isResolved: true }),
        thread(IMPORTANT, [[AUTHOR, REJECTED]], { isResolved: true }),
        thread(IMPORTANT, [[AUTHOR, `Rejected: intended\n\n${AUTHOR_MARK}`]], { isResolved: true }),
      ]).map((earlier) => earlier.reply),
    ).toEqual([
      "no answer (thread open)",
      "bengous-labs-author: Fixed in abc1234: count the rejections apart (thread resolved)",
      "bengous-labs-author: Rejected: the record is never written without reviewRounds (thread resolved: rejected by the Author)",
      "bengous-labs-author: Rejected: intended (thread resolved)",
    ]);
  });

  test("a thread a human or a deleted user opened is not an earlier finding", () => {
    expect(
      earlierThreadsOf(LOGINS, [thread(IMPORTANT, [], { by: "bengous" }), thread(IMPORTANT, [], { by: null })]),
    ).toEqual([]);
  });

  test("the threads file reads back as the earlier findings, and a file outside its schema is refused", () => {
    const earlier = earlierThreadsOf(LOGINS, [thread(IMPORTANT)]);

    expect(decodeJson(EarlierThreads, "review-threads.json", JSON.stringify(earlier))).toEqual(earlier);
    expect(() => decodeJson(EarlierThreads, "review-threads.json", JSON.stringify([{ where: "a.ts:3" }]))).toThrow(
      "review-threads.json",
    );
  });
});
