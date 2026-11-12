import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { markerOf } from "../land/shared/findings.ts";
import type { DevCommit, PrData, Row } from "./decide.ts";
import {
  decodeCheckRunsPages,
  decodeCommentsPages,
  decodeCommitsPages,
  decodeDevCommitsPages,
  decodeEventsPages,
  decodePullsPages,
  decodeReviewsPages,
  durationOf,
  findingAnswersOf,
  importantFoundOf,
  landOkGivenOf,
  ownerWaitOf,
  reportOf,
  revertedByOf,
  roundsOf,
  routeOf,
  rowOf,
} from "./decide.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

const slurped = (file: string): string => `[${readFileSync(file, "utf8")}]`;

function fixture(pr: number): PrData {
  const dir = join(FIXTURES, String(pr));
  const read = (name: string): string => slurped(join(dir, name));
  const [pull] = decodePullsPages(`[${read("pull.json")}]`);

  if (pull === undefined) {
    throw new Error(`no pull in ${dir}`);
  }

  return {
    pull,
    events: decodeEventsPages(read("events.json")),
    commits: decodeCommitsPages(read("commits.json")),
    checkRuns: readdirSync(dir)
      .filter((name) => name.startsWith("check-runs-"))
      .flatMap((name) => decodeCheckRunsPages(read(name))),
    reviews: decodeReviewsPages(read("reviews.json")),
    comments: decodeCommentsPages(read("comments.json")),
  };
}

const DEV: readonly DevCommit[] = decodeDevCommitsPages(slurped(join(FIXTURES, "dev-commits.json")));

const PR86 = fixture(86);

const PR88 = fixture(88);

const PR91 = fixture(91);

const MINUTE = 60_000;

const landOk = (at: string) => ({
  event: "labeled",
  created_at: at,
  actor: { login: "bengous" },
  label: { name: "land-ok" },
});

const waitingRun = (at: string) => ({
  started_at: at,
  output: { title: "Landable, land:human: waiting for the Owner's Land approval." },
});

describe("Route", () => {
  test("owner with land:human, auto with land:auto, null with neither; land:human wins over land:auto", () => {
    expect(routeOf(PR86.pull)).toBe("owner");
    expect(routeOf(PR88.pull)).toBe("owner");
    expect(routeOf(PR91.pull)).toBe("auto");
    expect(routeOf({ ...PR91.pull, labels: [] })).toBeNull();
    expect(routeOf({ ...PR91.pull, labels: [{ name: "land:auto" }, { name: "land:human" }] })).toBe("owner");
  });
});

describe("Owner wait", () => {
  test("#86 waits 0h19, from the waiting run on fa2392d to the land-ok; its last head ac95210 has no waiting run", () => {
    expect(ownerWaitOf(PR86)).toBe(Date.parse("2026-11-07T22:03:26Z") - Date.parse("2026-11-07T21:44:00Z"));
    expect(durationOf(ownerWaitOf(PR86))).toBe("0h19");

    const lastHead = readFileSync(
      join(FIXTURES, "86", "check-runs-ac952104df9c72207b6ae94f5edb3ffc41357d29.json"),
      "utf8",
    );

    expect(
      decodeCheckRunsPages(`[${lastHead}]`).some((run) =>
        /waiting for the owner's land approval/iu.test(run.output.title ?? ""),
      ),
    ).toBe(false);
  });

  test("#88 waits from the earliest of its two waiting runs", () => {
    expect(ownerWaitOf(PR88)).toBe(Date.parse("2026-11-07T22:49:57Z") - Date.parse("2026-11-07T22:40:07Z"));
  });

  test("a land-ok given before any waiting run since the previous land-ok counts 0", () => {
    const twice: PrData = {
      ...PR86,
      events: [...PR86.events, landOk("2026-11-07T22:20:00Z")],
    };

    expect(ownerWaitOf(twice)).toBe(ownerWaitOf(PR86));
    expect(ownerWaitOf({ ...PR86, checkRuns: [] })).toBe(0);
  });

  test("each land-ok waits from the first waiting run after the previous one, and the waits add up", () => {
    const pr: PrData = {
      ...PR86,
      events: [landOk("2026-11-07T21:50:00Z"), landOk("2026-11-07T22:30:00Z")],
      checkRuns: [
        waitingRun("2026-11-07T21:40:00Z"),
        waitingRun("2026-11-07T21:45:00Z"),
        waitingRun("2026-11-07T22:10:00Z"),
      ],
    };

    expect(ownerWaitOf(pr)).toBe(30 * MINUTE);
  });

  test("a land-ok given by another login, or a waiting run before the PR's creation, is not read", () => {
    const pr: PrData = {
      ...PR86,
      events: [{ ...landOk("2026-11-07T22:30:00Z"), actor: { login: "someone" } }],
      checkRuns: [waitingRun("2026-11-07T20:00:00Z")],
    };

    expect(ownerWaitOf(pr)).toBe(0);
    expect(ownerWaitOf({ ...pr, events: [landOk("2026-11-07T22:30:00Z")] })).toBe(0);
  });

  test("printed <h>h<mm>, rounded to the minute", () => {
    expect(durationOf(0)).toBe("0h00");
    expect(durationOf(9 * MINUTE + 50_000)).toBe("0h10");
    expect(durationOf(19 * MINUTE + 26_000)).toBe("0h19");
    expect(durationOf(125 * MINUTE)).toBe("2h05");
  });
});

/** A Delta read the App posted on `patch`, as `post-plan.ts` writes its body. */
const read = (patch: string, important: number, at: string) => ({
  user: { login: "bengous-labs-agents[bot]" },
  body: `Delta read (m, /code-review medium): ${important} important, 0 nit.\n\nReview run: u\n\n<!-- lab-review patch=${patch} round=4 -->`,
  submitted_at: at,
});

describe("Rounds and Important found", () => {
  test("from the fixtures: #86 ran 2 rounds and found 2, #88 2 and 1, #91 1 and 0", () => {
    expect([PR86, PR88, PR91].map((pr) => [roundsOf(pr.reviews), importantFoundOf(pr.reviews)])).toEqual([
      [2, 2],
      [2, 1],
      [1, 0],
    ]);
  });

  test("a round posted twice counts once, and its latest review gives its Important count", () => {
    const app = { login: "bengous-labs-agents[bot]" };

    const reviews = [
      {
        user: app,
        body: "Review round 1 (m, /code-review high): 2 important, 1 nit.",
        submitted_at: "2026-11-07T21:00:00Z",
      },
      {
        user: app,
        body: "Review round 2 (m, /code-review high): 3 important, 0 nit.",
        submitted_at: "2026-11-07T21:10:00Z",
      },
      {
        user: app,
        body: "Review round 2 (m, /code-review high): 1 important, 0 nit.",
        submitted_at: "2026-11-07T21:20:00Z",
      },
      {
        user: app,
        body: "Review round 3 (m, /code-review high): nothing to fix.",
        submitted_at: "2026-11-07T21:30:00Z",
      },
      {
        user: { login: "bengous" },
        body: "Review round 4 (m, /code-review high): 9 important, 0 nit.",
        submitted_at: "2026-11-07T21:40:00Z",
      },
      { user: app, body: "Review round 5", submitted_at: "2026-11-07T21:50:00Z" },
      { user: null, body: "", submitted_at: "2026-11-07T21:55:00Z" },
    ];

    expect(roundsOf(reviews)).toBe(3);
    expect(importantFoundOf(reviews)).toBe(3);
  });

  test("a Delta read is no round, but its Importants are found: the latest posting of each patch's read counts once", () => {
    const reviews = [
      {
        user: { login: "bengous-labs-agents[bot]" },
        body: "Review round 3 (m, /code-review high): 1 important, 0 nit.",
        submitted_at: "2026-11-07T21:30:00Z",
      },
      read("p4", 3, "2026-11-07T21:40:00Z"),
      read("p4", 1, "2026-11-07T21:45:00Z"),
      read("p5", 2, "2026-11-07T21:50:00Z"),
      { ...read("p6", 9, "2026-11-07T21:55:00Z"), user: { login: "bengous" } },
    ];

    expect(roundsOf(reviews)).toBe(1);
    expect(importantFoundOf(reviews)).toBe(4);
  });

  test("a round with a security pass counts the Importants of both passes", () => {
    const app = { login: "bengous-labs-agents[bot]" };

    const reviews = [
      {
        user: app,
        body: "Review round 1 (m, /code-review high): 2 important, 1 nit; security: 0 important, 0 nit.",
        submitted_at: "2026-11-07T21:00:00Z",
      },
      {
        user: app,
        body: "Review round 2 (m, /code-review high): 0 important, 0 nit; security: 3 important, 1 nit. 1 pre-existing finding(s) not posted.",
        submitted_at: "2026-11-07T21:10:00Z",
      },
    ];

    expect(importantFoundOf(reviews)).toBe(5);
  });

  test("a round's summary line in plain words counts its round and its Importants, the security pass's among them, next to one written before", () => {
    const app = { login: "bengous-labs-agents[bot]" };

    const reviews = [
      {
        user: app,
        body: "Review round 1 (m, /code-review high): 2 important, 1 nit; security: 1 important, 0 nit.",
        submitted_at: "2026-11-07T21:00:00Z",
      },
      {
        user: app,
        body: "Round 2: 2 Important (1 security), 5 Nit (2 security). 2 pre-existing defects not posted.\n\nReview run (m, /code-review high): u",
        submitted_at: "2026-11-07T22:00:00Z",
      },
      { user: app, body: "Round 3: 1 Nit.", submitted_at: "2026-11-07T23:00:00Z" },
      { user: { login: "bengous" }, body: "Round 4: 9 Important.", submitted_at: "2026-11-08T00:00:00Z" },
    ];

    expect(roundsOf(reviews)).toBe(3);
    expect(importantFoundOf(reviews)).toBe(5);
  });

  test("a Delta read's summary line in plain words counts its Importants next to one written before, and no round", () => {
    const plain = (patch: string, line: string, at: string) => ({
      ...read(patch, 0, at),
      body: `${line}\n\nReview run (m, /code-review medium): u\n\n<!-- lab-review patch=${patch} round=4 -->`,
    });

    const reviews = [
      read("p4", 1, "2026-11-07T21:40:00Z"),
      plain("p5", "Delta read: 2 Important (1 security).", "2026-11-07T21:50:00Z"),
      plain("p6", "Delta read: no new finding.", "2026-11-07T21:55:00Z"),
      plain("p7", "Delta reading: 9 Important.", "2026-11-07T21:58:00Z"),
    ];

    expect(roundsOf(reviews)).toBe(0);
    expect(importantFoundOf(reviews)).toBe(3);
  });

  test("a pending review, which GitHub sends without submitted_at, reads and counts no round", () => {
    const reviews = decodeReviewsPages(
      JSON.stringify([[...PR86.reviews, { user: { login: "bengous" }, body: "", state: "PENDING" }]]),
    );

    expect(reviews).toHaveLength(PR86.reviews.length + 1);
    expect(roundsOf(reviews)).toBe(2);
  });
});

describe("fixed and rejected", () => {
  test('from the fixtures: #86 fixed 2 ("Fixed in part in" starts with "Fixed in "), #88 1, #91 0; none rejected', () => {
    expect([PR86, PR88, PR91].map((pr) => findingAnswersOf(pr.comments))).toEqual([
      { fixed: 2, rejected: 0 },
      { fixed: 1, rejected: 0 },
      { fixed: 0, rejected: 0 },
    ]);
  });

  test('an Important answered by another login without "Fixed in" is rejected; a Nit or the App\'s own reply is not read', () => {
    const app = { login: "bengous-labs-agents[bot]" };
    const important = `**Important**: x\n\n${markerOf("important")}`;
    const nit = `**Nit**: x\n\n${markerOf("nit")}`;

    const comments = [
      { id: 1, user: app, body: important },
      { id: 2, user: { login: "bengous" }, body: "Kept as is.", in_reply_to_id: 1 },
      { id: 3, user: app, body: important },
      { id: 4, user: app, body: "Still open.", in_reply_to_id: 3 },
      { id: 5, user: app, body: nit },
      { id: 6, user: { login: "bengous" }, body: "Kept as is.", in_reply_to_id: 5 },
      { id: 7, user: { login: "bengous" }, body: important },
      { id: 8, user: { login: "bengous" }, body: "Kept as is.", in_reply_to_id: 7 },
      { id: 9, user: app, body: important },
      { id: 10, user: { login: "bengous" }, body: "Kept as is.", in_reply_to_id: 9 },
      { id: 11, user: null, body: "Fixed in c0ffee1.", in_reply_to_id: 9 },
    ];

    expect(findingAnswersOf(comments)).toEqual({ fixed: 1, rejected: 1 });
  });
});

describe("land-ok given", () => {
  test("counts the Owner's labeled events of land-ok", () => {
    expect([PR86, PR88, PR91].map((pr) => landOkGivenOf(pr.events))).toEqual([1, 1, 0]);
    expect(
      landOkGivenOf([
        ...PR86.events,
        landOk("2026-11-07T22:30:00Z"),
        { ...landOk("2026-11-07T22:31:00Z"), event: "unlabeled" },
        { ...landOk("2026-11-07T22:32:00Z"), actor: null },
      ]),
    ).toBe(2);
  });
});

const revert = (sha: string): DevCommit => ({
  sha: "deadbeefcafe0000000000000000000000000000",
  commit: { message: `Revert "x"\n\nThis reverts commit ${sha}.\n` },
});

describe("Reverted by", () => {
  test("nothing on dev reverts #86, #88 or #91", () => {
    expect([PR86, PR88, PR91].map((pr) => revertedByOf(pr, DEV))).toEqual([null, null, null]);
  });

  test("the short sha of a commit that reverts the merge commit or one of the PR's commits", () => {
    expect(revertedByOf(PR91, [...DEV, revert(PR91.pull.merge_commit_sha ?? "")])).toBe("deadbee");
    expect(revertedByOf(PR86, [revert(PR86.commits[1] ?? "")])).toBe("deadbee");
    expect(revertedByOf(PR86, [revert(PR91.pull.merge_commit_sha ?? "")])).toBeNull();
  });

  test("a revert of the merge commit, which says the changes it reverses, is read too", () => {
    const merge = PR91.pull.merge_commit_sha ?? "";

    const mergeRevert: DevCommit = {
      sha: "feedfacecafe0000000000000000000000000000",
      commit: {
        message: `Revert "x"\n\nThis reverts commit ${merge}, reversing\nchanges made to ${"0".repeat(40)}.\n`,
      },
    };

    expect(revertedByOf(PR91, [mergeRevert])).toBe("feedfac");
    expect(revertedByOf(PR91, [revert(`${merge}0`)])).toBeNull();
  });
});

describe("the report", () => {
  const rows: readonly Row[] = [PR86, PR88, PR91].map((pr) => rowOf(pr, DEV));

  test("the rows of #86, #88 and #91, column by column", () => {
    expect(rows).toEqual([
      {
        number: 86,
        mergedAt: "2026-11-07T22:13:05Z",
        route: "owner",
        ownerWait: 19 * MINUTE + 26_000,
        rounds: 2,
        found: 2,
        fixed: 2,
        rejected: 0,
        landOkGiven: 1,
        revertedBy: null,
      },
      {
        number: 88,
        mergedAt: "2026-11-07T22:51:26Z",
        route: "owner",
        ownerWait: 9 * MINUTE + 50_000,
        rounds: 2,
        found: 1,
        fixed: 1,
        rejected: 0,
        landOkGiven: 1,
        revertedBy: null,
      },
      {
        number: 91,
        mergedAt: "2026-11-07T23:23:44Z",
        route: "auto",
        ownerWait: null,
        rounds: 1,
        found: 0,
        fixed: 0,
        rejected: 0,
        landOkGiven: 0,
        revertedBy: null,
      },
    ]);
  });

  test("one table per ISO week, then its total line; the median of an even count is the mean of the middle two", () => {
    expect(reportOf(rows)).toBe(
      [
        "## Week 2026-W45 (Nov 2 – Nov 8)",
        "",
        "| PR | Route | Owner wait | Rounds | Important found | fixed | rejected | land-ok given | Reverted by |",
        "|-----|-------|-----------:|-------:|----:|----:|----:|----:|-----|",
        "| #86 | owner | 0h19 | 2 | 2 | 2 | 0 | 1 | – |",
        "| #88 | owner | 0h10 | 2 | 1 | 1 | 0 | 1 | – |",
        "| #91 | auto | – | 1 | 0 | 0 | 0 | 0 | – |",
        "",
        "Total: 3 PRs landed (1 auto, 2 owner). Owner wait: median 0h15, sum 0h29.",
        "Rounds: 5. Important: 3 found, 3 fixed, 0 rejected.",
        "Land approval given more than once: 0 PRs. land:auto PRs reverted: 0.",
        "",
        'rejected: an Important thread the Author answered without "Fixed in", read from the threads until #94.',
        "",
      ].join("\n"),
    );
  });

  test("weeks in order, a week with no PR prints no table, a PR without a Route and the counts of land-ok and reverts", () => {
    const [, , row] = rows;

    if (row === undefined) {
      throw new Error("no row of #91");
    }

    const report = reportOf([
      { ...row, number: 100, mergedAt: "2026-11-23T10:00:00Z", route: null, ownerWait: 60 * MINUTE, landOkGiven: 2 },
      { ...row, number: 99, mergedAt: "2026-11-01T23:59:59Z", revertedBy: "deadbee" },
      { ...row, number: 101, mergedAt: "2026-11-29T23:59:59Z", route: "owner", ownerWait: 0, landOkGiven: 3 },
    ]);

    expect(report).toContain("## Week 2026-W44 (Oct 26 – Nov 1)");
    expect(report).toContain("| #99 | auto | – | 1 | 0 | 0 | 0 | 0 | deadbee |");
    expect(report).toContain("Total: 1 PR landed (1 auto, 0 owner). Owner wait: median –, sum –.");
    expect(report).toContain("Land approval given more than once: 0 PRs. land:auto PRs reverted: 1.");
    expect(report).not.toContain("W46");
    expect(report).toContain("## Week 2026-W48 (Nov 23 – Nov 29)");
    expect(report).toContain("| #100 | – | 1h00 | 1 | 0 | 0 | 0 | 2 | – |");
    expect(report).toContain(
      "Total: 2 PRs landed (0 auto, 1 owner, 1 without a Route). Owner wait: median 0h00, sum 0h00.",
    );
    expect(report).toContain("Land approval given more than once: 2 PRs. land:auto PRs reverted: 0.");
    expect(report.indexOf("W44")).toBeLessThan(report.indexOf("W48"));
    expect(report.indexOf("#100")).toBeLessThan(report.indexOf("#101"));
  });

  test("an odd count of owner PRs takes the middle wait; the ISO week of early January belongs to the year before", () => {
    const [row] = rows;

    if (row === undefined) {
      throw new Error("no row of #86");
    }

    const report = reportOf(
      [1, 5, 3].map((minutes, index) => ({
        ...row,
        number: index,
        mergedAt: "2027-01-02T12:00:00Z",
        ownerWait: minutes * MINUTE,
      })),
    );

    expect(report).toContain("## Week 2026-W53 (Dec 28 – Jan 3)");
    expect(report).toContain("Owner wait: median 0h03, sum 0h09.");
  });
});
