import { describe, expect, test } from "bun:test";

import type { Delivered } from "../lib/deliver.ts";
import type { Ran, Run } from "../ports/run.ts";
import { readPr, turn } from "./main.ts";
import type { RelayIo } from "./main.ts";
import type { PrState } from "./wakes.ts";

const HEAD = "c0ffee1234567890c0ffee1234567890c0ffee12";

const OPEN: PrState = { state: "OPEN", draft: false, head: HEAD, checks: [], threads: [], comments: [] };

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
      deliver: (session, text) => {
        sent.push({ session, text });

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
          "Fix what you accept with a commit, say in your last message which findings you reject and why, then stop.",
        ].join("\n"),
      },
    ]);
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

  test("a landed or closed PR delivers its end line and ends the relay, whether the line went through or not", async () => {
    const landed = relay({ ...OPEN, state: "MERGED" });

    expect(await turn(7, new Set(), landed.io)).toEqual({ delivered: ["end"], via: "socket", pending: 1, ends: true });
    expect(landed.sent).toEqual([{ session: "S1", text: "The Land loop, about your pull request #7:\nPR #7 landed." }]);

    const closed = relay({ ...OPEN, state: "CLOSED" }, null);

    expect(await turn(7, new Set(), closed.io)).toEqual({ delivered: [], via: null, pending: 1, ends: true });
    expect(await turn(7, new Set(["end"]), relay({ ...OPEN, state: "MERGED" }).io)).toEqual({
      delivered: [],
      via: null,
      pending: 0,
      ends: true,
    });
  });
});

describe("readPr", () => {
  test("reads the view, the checks, the conversation and the threads of the PR, each under the options given", async () => {
    const calls: string[] = [];
    const threads = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });

    const run: Run = (argv, options): Promise<Ran> => {
      calls.push(`${argv.slice(0, 3).join(" ")} ${JSON.stringify(options.env)}`);
      const line = argv.join(" ");

      if (line.startsWith("gh pr view")) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ state: "OPEN", isDraft: true, headRefOid: HEAD }),
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
