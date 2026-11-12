import { describe, expect, test } from "bun:test";

import type { Ran, Run } from "../../lib/run.port.ts";
import { NotStopped, readPr, relayDeliverer, turn } from "./main.ts";
import type { Delivery, RelayIo } from "./main.ts";
import type { Delivered, PrState, Route } from "./wakes.ts";

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

interface Sent {
  readonly session: string;
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
      session: () => "S1",
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
        session: "S1",
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
        session: "S1",
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

/** A relay's deliverer, and the kinds of the routes it sent. */
interface Delivering {
  readonly deliver: RelayIo["deliver"];
  readonly routes: Array<Route["kind"]>;
}

/** A relay's deliverer whose deliveries go as `outcomes` says, one per delivery. */
function delivering(outcomes: ReadonlyArray<Delivered | null | "not-stopped" | "fails">): Delivering {
  const routes: Array<Route["kind"]> = [];
  const left = [...outcomes];

  const deliver = relayDeliverer({
    agents: () => Promise.resolve(IDLE),
    deliver: (delivery: Delivery) => {
      routes.push(delivery.route.kind);
      const outcome = left.shift();

      if (outcome === "not-stopped") {
        return Promise.reject(new NotStopped("still running"));
      }

      if (outcome === "fails") {
        return Promise.reject(new Error("claude stop exited 1"));
      }

      return Promise.resolve(outcome ?? null);
    },
  });

  return { deliver, routes };
}

/** Sends the Owner's words to S1 `times` times, and swallows each failure. */
async function sendOwnerWords(deliver: RelayIo["deliver"], times: number): Promise<void> {
  for (let sent = 0; sent < times; sent += 1) {
    await deliver("S1", "use wording B", true).catch(() => null);
  }
}

describe("relayDeliverer", () => {
  test("sends the route, the socket line and the resume of the text, and reads the stop from the listing", async () => {
    const sent: Delivery[] = [];
    const listings = [IDLE, "[]"];

    const deliver = relayDeliverer({
      agents: () => Promise.resolve(listings.shift() ?? "[]"),
      deliver: (delivery) => {
        sent.push(delivery);

        return Promise.resolve("resume");
      },
    });

    expect(await deliver("S1", "the lines", true)).toBe("resume");
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

    expect(await deliver("S1", "a finding", false)).toBe("socket");
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

    const failure = await deliver("S1", "use wording B", true).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(NotStopped);
  });
});
