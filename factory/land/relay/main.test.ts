import { describe, expect, test } from "bun:test";

import type { Ran, Run } from "../../lib/run.port.ts";
import { NotStopped, readPr, relayDeliverer, turn, TurnFailed } from "./main.ts";
import type { Delivery, RelayIo } from "./main.ts";
import type { Delivered, PrState, Route, Target } from "./wakes.ts";

const HEAD = "c0ffee1234567890c0ffee1234567890c0ffee12";

const OPEN: PrState = {
  state: "OPEN",
  draft: false,
  head: HEAD,
  conflicting: false,
  checks: [],
  threads: [],
  comments: [],
};

const NIT = {
  id: "T1",
  resolved: false,
  path: "a.ts",
  line: 2,
  author: "bengous-labs-agents",
  body: "**Nit**: n <!-- lab-finding severity=nit -->",
  replies: [],
};

/** The session of the PR's latest Publication, an API Worker's, so a turn is seen to hand it on whole. */
const TARGET: Target = { session: "S1", headless: { model: "opus", worktree: "/repo/.claude/worktrees/issue-7" } };

interface Sent {
  readonly session: Target;
  readonly text: string;
  readonly ownerWords: boolean;
}

/** A fake of a relay's outside, and what it was asked to deliver. */
interface Relay {
  readonly io: RelayIo;
  readonly sent: Sent[];
}

/** A relay's outside: the PR reads as `state`, and a delivery goes `through` or fails. */
function relay(state: PrState, through: Delivered | null = "socket"): Relay {
  const sent: Sent[] = [];

  return {
    sent,
    io: {
      read: () => Promise.resolve(state),
      session: () => TARGET,
      deliver: (session, text, ownerWords) => {
        sent.push({ session, text, ownerWords });

        return Promise.resolve(through);
      },
    },
  };
}

describe("turn", () => {
  test("a quiet PR delivers nothing, and the relay goes on", async () => {
    const { io, sent } = relay(OPEN);

    expect(await turn(7, new Set(), io)).toEqual({ delivered: [], via: null, pending: 0, ends: false });
    expect(sent).toEqual([]);
  });

  test("the Wakes of a reading go to the session of the PR's latest Publication as one text", async () => {
    const { io, sent } = relay({ ...OPEN, draft: true, threads: [NIT] });

    expect(await turn(7, new Set(), io)).toEqual({
      delivered: ["thread:T1", `draft:${HEAD}`],
      via: "socket",
      pending: 2,
      ends: false,
    });
    expect(sent).toEqual([
      {
        session: TARGET,
        text: [
          "The Land loop, about your pull request #7:",
          "Finding T1 on a.ts:2 by bengous-labs-agents: **Nit**: n <!-- lab-finding severity=nit -->",
          "PR #7 is back in draft at c0ffee1: it lands only after your next stop.",
          "Fix what you accept with a commit, name in your last message each finding you reject and why, then stop.",
        ].join("\n"),
        ownerWords: false,
      },
    ]);
  });

  test("a reading that holds the Owner's words is delivered as such", async () => {
    const comments = [{ id: "11", author: "bengous", body: "use wording B" }];
    const { io, sent } = relay({ ...OPEN, threads: [NIT], comments });

    await turn(7, new Set(), io);

    expect(sent.map((found) => found.ownerWords)).toEqual([true]);
  });

  test("each Wake is delivered once: a Wake delivered before is not sent again", async () => {
    const state = { ...OPEN, draft: true, threads: [NIT] };
    const { io, sent } = relay(state);
    const seen = new Set<string>();

    for (const key of (await turn(7, seen, io)).delivered) {
      seen.add(key);
    }

    expect(await turn(7, seen, io)).toEqual({ delivered: [], via: null, pending: 0, ends: false });
    expect(sent).toHaveLength(1);

    const later = relay({ ...state, checks: [{ name: "validate", bucket: "fail", link: "https://ci/1" }] });

    expect(await turn(7, seen, later.io)).toEqual({
      delivered: [`check:validate:${HEAD}`],
      via: "socket",
      pending: 1,
      ends: false,
    });
    expect(later.sent[0]?.text).not.toContain("Finding T1");
  });

  test("a delivery that does not go through marks nothing delivered: a later turn sends it again", async () => {
    const { io, sent } = relay({ ...OPEN, threads: [NIT] }, null);
    const seen = new Set<string>();

    expect(await turn(7, seen, io)).toEqual({ delivered: [], via: null, pending: 1, ends: false });
    expect(await turn(7, seen, io)).toEqual({ delivered: [], via: null, pending: 1, ends: false });
    expect(sent).toHaveLength(2);
  });

  test("a red Review check alone starts no turn: its findings start theirs", async () => {
    const held = relay({ ...OPEN, checks: [{ name: "agent-review", bucket: "fail", link: "https://ci/2" }] });

    expect(await turn(7, new Set(), held.io)).toEqual({ delivered: [], via: null, pending: 0, ends: false });
    expect(held.sent).toEqual([]);
  });

  test("a red Land gate on a PR with no conflict starts a turn: nothing else tells an ejection", async () => {
    const ejected = relay({ ...OPEN, checks: [{ name: "land-gate", bucket: "fail", link: "https://ci/3" }] });

    await turn(7, new Set(), ejected.io);

    expect(ejected.sent.map((found) => found.text)).toEqual([
      "The Land loop, about your pull request #7:\nCheck land-gate failed on c0ffee1: https://ci/3\nFix it with a commit, then stop.",
    ]);
  });

  test("a conflict with dev starts one turn that names the rebase, and no finding", async () => {
    const checks = [{ name: "land-gate", bucket: "fail", link: "https://ci/3" }];
    const conflicting = relay({ ...OPEN, conflicting: true, checks });
    const seen = new Set<string>();

    for (const key of (await turn(7, seen, conflicting.io)).delivered) {
      seen.add(key);
    }

    await turn(7, seen, conflicting.io);

    expect(conflicting.sent).toEqual([
      {
        session: TARGET,
        text: "The Land loop, about your pull request #7:\nPR #7 conflicts with dev: run `git fetch origin dev`, then rebase onto origin/dev.\nFix it with a commit, then stop.",
        ownerWords: false,
      },
    ]);
  });

  test("a landed or closed PR ends the relay and starts no turn, whatever the PR still carries", async () => {
    for (const state of ["MERGED", "CLOSED"] as const) {
      const ended = relay({ ...OPEN, state, draft: true, threads: [NIT] });

      expect(await turn(7, new Set(), ended.io)).toEqual({ delivered: [], via: null, pending: 0, ends: true });
      expect(ended.sent).toEqual([]);
    }
  });
});

describe("readPr", () => {
  test("reads the view, the checks, the conversation and the threads of the PR, each under the options given", async () => {
    const calls: string[] = [];
    const threads = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });

    const run: Run = (argv, options): Promise<Ran> => {
      calls.push(`${argv.slice(0, 3).join(" ")} ${JSON.stringify(options.env)}`);
      const line = argv.join(" ");

      if (line === "gh pr view 7 --json state,isDraft,headRefOid,mergeable") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ state: "OPEN", isDraft: true, headRefOid: HEAD, mergeable: "CONFLICTING" }),
          stderr: "",
        });
      }

      if (line.startsWith("gh pr checks")) {
        return Promise.resolve({
          code: 1,
          stdout: JSON.stringify([{ name: "validate", bucket: "fail", link: "https://ci/1" }]),
          stderr: "",
        });
      }

      return Promise.resolve({ code: 0, stdout: line.startsWith("gh api graphql") ? threads : "", stderr: "" });
    };

    expect(await readPr(run, { cwd: "/main", env: { GH_TOKEN: "t0k" } }, 7)).toEqual({
      state: "OPEN",
      draft: true,
      head: HEAD,
      conflicting: true,
      checks: [{ name: "validate", bucket: "fail", link: "https://ci/1" }],
      threads: [],
      comments: [],
    });
    expect(calls).toEqual([
      'gh pr view {"GH_TOKEN":"t0k"}',
      'gh pr checks {"GH_TOKEN":"t0k"}',
      'gh api --paginate {"GH_TOKEN":"t0k"}',
      'gh api graphql {"GH_TOKEN":"t0k"}',
    ]);
  });
});

/** What `claude agents --json` prints for the background session S1, idle. */
const IDLE = JSON.stringify([{ sessionId: "S1", pid: 34_502, id: "725ecfab", status: "idle" }]);

/** The background session S1, as the relay's session file names it. */
const BACKGROUND: Target = { session: "S1", headless: null };

const PLACE = { checkout: "/repo", home: "/home/me" };

/** A relay's deliverer, the kinds of the routes it sent, and its clock. */
interface Delivering {
  readonly deliver: RelayIo["deliver"];
  readonly routes: Array<Route["kind"]>;
  readonly clock: { now: number };
}

type Outcome = Delivered | null | "not-stopped" | "turn-failed" | "fails";

/** A relay's deliverer whose deliveries go as `outcomes` says, one per delivery, over the listing `agents`. */
function delivering(outcomes: readonly Outcome[], agents = IDLE): Delivering {
  const routes: Array<Route["kind"]> = [];
  const left = [...outcomes];
  const clock = { now: 0 };

  const deliver = relayDeliverer({
    agents: () => Promise.resolve(agents),
    place: PLACE,
    now: () => clock.now,
    deliver: (delivery: Delivery) => {
      routes.push(delivery.route.kind);
      const outcome = left.shift();

      if (outcome === "not-stopped") {
        return Promise.reject(new NotStopped("still running"));
      }

      if (outcome === "turn-failed") {
        return Promise.reject(new TurnFailed("the headless turn ended with exit 1 at its start"));
      }

      if (outcome === "fails") {
        return Promise.reject(new Error("claude stop exited 1"));
      }

      return Promise.resolve(outcome ?? null);
    },
  });

  return { deliver, routes, clock };
}

/** Sends the Owner's words to S1 `times` times, and swallows each failure. */
async function sendOwnerWords(deliver: RelayIo["deliver"], times: number): Promise<void> {
  for (let sent = 0; sent < times; sent += 1) {
    await deliver(BACKGROUND, "use wording B", true).catch(() => null);
  }
}

describe("relayDeliverer", () => {
  test("sends the route, the socket line and the resume of the text, and reads the stop from the listing", async () => {
    const sent: Delivery[] = [];
    const listings = [IDLE, "[]"];

    const deliver = relayDeliverer({
      agents: () => Promise.resolve(listings.shift() ?? "[]"),
      place: PLACE,
      now: () => 0,
      deliver: (delivery) => {
        sent.push(delivery);

        return Promise.resolve("resume");
      },
    });

    expect(await deliver(BACKGROUND, "the lines", true)).toBe("resume");
    expect(sent.map(({ route, socketLine, resumeArgs }) => ({ route, socketLine, resumeArgs }))).toEqual([
      {
        route: { kind: "stop", id: "725ecfab" },
        socketLine: `${JSON.stringify({ type: "user", message: { role: "user", content: "the lines" } })}\n`,
        resumeArgs: ["claude", "--bg", "--resume", "S1", "the lines"],
      },
    ]);
    expect(await sent[0]?.stopped()).toBe(true);
  });

  test("words that are not the Owner's go on the socket of a running session", async () => {
    const { deliver, routes } = delivering(["socket"]);

    expect(await deliver(BACKGROUND, "a finding", false)).toBe("socket");
    expect(routes).toEqual(["socket"]);
  });

  test("after three stops in a row the listing did not show, the Owner's words go on the socket", async () => {
    const { deliver, routes } = delivering(["not-stopped", "not-stopped", "not-stopped", "socket"]);

    await sendOwnerWords(deliver, 4);

    expect(routes).toEqual(["stop", "stop", "stop", "socket"]);
  });

  test("a stop that fails otherwise counts no failed stop, and a delivery that does not go through resets nothing", async () => {
    const { deliver, routes } = delivering(["not-stopped", "not-stopped", "fails", null, "not-stopped", "socket"]);

    await sendOwnerWords(deliver, 6);

    expect(routes).toEqual(["stop", "stop", "stop", "stop", "stop", "socket"]);
  });

  test("a delivery that goes through resets the count", async () => {
    const { deliver, routes } = delivering(["not-stopped", "not-stopped", "resume", "not-stopped", "not-stopped"]);

    await sendOwnerWords(deliver, 6);

    expect(routes).toEqual(["stop", "stop", "stop", "stop", "stop", "stop"]);
  });

  test("a failed stop is thrown on, for the turn to report", async () => {
    const { deliver } = delivering(["not-stopped"]);

    const failure = await deliver(BACKGROUND, "use wording B", true).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(NotStopped);
  });
});

describe("relayDeliverer, to an API Worker's session", () => {
  /** An API Worker's session that no longer runs: the listing holds none. */
  const API: Target = { session: "S9", headless: { model: "opus", worktree: "/repo/.claude/worktrees/issue-7" } };
  const MINUTE = 60_000;

  /** Sends a Wake to the API Worker's session at `at`, and swallows a failure. */
  function sendAt({ deliver, clock }: Delivering, at: number): Promise<Delivered | null> {
    clock.now = at;

    return deliver(API, "the lines", false).catch(() => null);
  }

  test("resumes it headless, on the API Worker settings file of the relay's home and the log of its checkout", async () => {
    const sent: Delivery[] = [];

    const deliver = relayDeliverer({
      agents: () => Promise.resolve("[]"),
      place: PLACE,
      now: () => 0,
      deliver: (delivery) => {
        sent.push(delivery);

        return Promise.resolve("headless");
      },
    });

    expect(await deliver(API, "the lines", true)).toBe("headless");
    expect(sent[0]?.route).toEqual({
      kind: "headless",
      worktree: "/repo/.claude/worktrees/issue-7",
      log: "/repo/.lab/state/api-worker-S9.log",
    });
    expect(sent[0]?.resumeArgs.slice(0, 4)).toEqual(["claude", "-p", "--resume", "S9"]);
    expect(sent[0]?.resumeArgs).toContain("/home/me/.config/software-factory-lab/api-worker-settings.json");
  });

  test("a turn that failed at its start holds the next one back for a minute, then it is tried again", async () => {
    const found = delivering(["turn-failed", null, "headless"], "[]");

    await sendAt(found, 0);
    await sendAt(found, MINUTE - 1);

    expect(await sendAt(found, MINUTE)).toBe("headless");
    expect(found.routes).toEqual(["headless", "wait", "headless"]);
  });

  test("each failed start in a row doubles the wait", async () => {
    const found = delivering(["turn-failed", "turn-failed", null, "turn-failed", null, "headless"], "[]");

    await sendAt(found, 0);
    await sendAt(found, MINUTE);
    await sendAt(found, 3 * MINUTE - 1);
    await sendAt(found, 3 * MINUTE);
    await sendAt(found, 7 * MINUTE - 1);
    await sendAt(found, 7 * MINUTE);

    expect(found.routes).toEqual(["headless", "headless", "wait", "headless", "wait", "headless"]);
  });

  test("a turn that starts resets the count: the next failed start holds for a minute again", async () => {
    const found = delivering(["turn-failed", "turn-failed", "headless", "turn-failed", null, "headless"], "[]");

    await sendAt(found, 0);
    await sendAt(found, MINUTE);
    await sendAt(found, 3 * MINUTE);
    await sendAt(found, 10 * MINUTE);
    await sendAt(found, 11 * MINUTE - 1);
    await sendAt(found, 11 * MINUTE);

    expect(found.routes).toEqual(["headless", "headless", "headless", "headless", "wait", "headless"]);
  });

  test("a delivery that fails otherwise, or does not go through, holds nothing back", async () => {
    const found = delivering(["fails", null, "headless"], "[]");

    await sendAt(found, 0);
    await sendAt(found, 1);
    await sendAt(found, 2);

    expect(found.routes).toEqual(["headless", "headless", "headless"]);
  });

  test("a failed start is thrown on, for the turn to report, and holds no background session back", async () => {
    const found = delivering(["turn-failed", "socket"], "[]");

    found.clock.now = 0;

    const failure = await found.deliver(API, "the lines", false).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(TurnFailed);

    const background = delivering(["turn-failed", "socket"]);

    await background.deliver(BACKGROUND, "a finding", false).catch(() => null);

    expect(await background.deliver(BACKGROUND, "a finding", false)).toBe("socket");
    expect(background.routes).toEqual(["socket", "socket"]);
  });
});
