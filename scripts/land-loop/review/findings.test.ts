import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import {
  EarlierThreads,
  earlierThreadsOf,
  graphqlLogin,
  markerOf,
  openImportantOf,
  ReviewThreads,
  severityOfBody,
  threadsQueryOf,
} from "./findings.ts";
import type { ReviewThread } from "./findings.ts";

const APP = "bengous-labs-agents";

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
    ).toBe(2);
    expect(openImportantOf(APP, [])).toBe(0);
  });
});

describe("earlierThreadsOf", () => {
  test("each of the App's findings, open or resolved, with the author's answers and its thread's state", () => {
    expect(
      earlierThreadsOf(APP, [
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
        where: "a.ts:3",
        finding: "**Important**: off by one",
        reply: "Rejected: intended / see the test (thread resolved)",
      },
      { where: "a.ts:?", finding: "**Nit**: a name", reply: "no answer (thread open)" },
    ]);
  });

  test("the Author's machine account answers as the author: its replies reach the earlier findings", () => {
    expect(
      earlierThreadsOf(APP, [thread(IMPORTANT, [["bengous-labs-author", "Fixed in abc: bound checked"]])]),
    ).toEqual([
      { where: "a.ts:3", finding: "**Important**: off by one", reply: "Fixed in abc: bound checked (thread open)" },
    ]);
  });

  test("a thread a human or a deleted user opened is not an earlier finding", () => {
    expect(
      earlierThreadsOf(APP, [thread(IMPORTANT, [], { by: "bengous" }), thread(IMPORTANT, [], { by: null })]),
    ).toEqual([]);
  });

  test("the threads file reads back as the earlier findings, and a file outside its schema is refused", () => {
    const earlier = earlierThreadsOf(APP, [thread(IMPORTANT)]);

    expect(decodeJson(EarlierThreads, "review-threads.json", JSON.stringify(earlier))).toEqual(earlier);
    expect(() => decodeJson(EarlierThreads, "review-threads.json", JSON.stringify([{ where: "a.ts:3" }]))).toThrow(
      "review-threads.json",
    );
  });
});
