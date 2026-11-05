import { describe, expect, test } from "bun:test";

import type { Run } from "../lib/run.ts";
import { fable, FABLE_MODEL, promptOf, verdictOf } from "./fable.ts";

const answer = (structured: object): string =>
  JSON.stringify({ structured_output: structured, total_cost_usd: 0.2, modelUsage: { "claude-fable-5-1": { costUSD: 0.2 } } });

describe("verdictOf", () => {
  test("an explicit ok true or false is a verdict; a missing ok or unreadable output is none", () => {
    const cases: [string, { ok: boolean; reason: string } | null][] = [
      [answer({ ok: true, reason: "fine" }), { ok: true, reason: "fine" }],
      [answer({ ok: false, reason: "bypass" }), { ok: false, reason: "bypass" }],
      [answer({ ok: false }), { ok: false, reason: "" }],
      [answer({ reason: "?" }), null],
      [answer({ ok: "yes", reason: "?" }), null],
      [JSON.stringify({ result: "looks fine" }), null],
      ["not json", null],
    ];

    for (const [stdout, verdict] of cases) expect(verdictOf(stdout)).toEqual(verdict);
  });
});

describe("fable", () => {
  test("runs Fable with no tool and a schema, and reads its verdict, model and cost", async () => {
    const calls: string[][] = [];
    const run: Run = async (argv) => {
      calls.push([...argv]);

      return { code: 0, stdout: answer({ ok: true, reason: "fine" }), stderr: "" };
    };

    const result = await fable(run, "/repo", "prompt");

    expect(calls[0]).toEqual(expect.arrayContaining(["--model", FABLE_MODEL, "--tools", "", "--json-schema"]));
    expect(result).toEqual({ verdict: { ok: true, reason: "fine" }, failure: null, model: "claude-fable-5-1", costUsd: 0.2 });
  });

  test("a failed run or an answer outside the schema gives no verdict, with the reason", async () => {
    const failed: Run = async () => ({ code: 124, stdout: "", stderr: "timed out" });
    const offSchema: Run = async () => ({ code: 0, stdout: JSON.stringify({ result: "ok I guess" }), stderr: "" });

    expect(await fable(failed, "/repo", "prompt")).toMatchObject({ verdict: null, failure: "Fable exited 124." });
    expect(await fable(offSchema, "/repo", "prompt")).toMatchObject({ verdict: null, failure: "Fable answered outside the schema." });
  });
});

describe("promptOf", () => {
  test("carries the guide and the diff, and marks the diff untrusted", () => {
    const prompt = promptOf("GUIDE", "DIFF");

    expect(prompt).toContain("GUIDE");
    expect(prompt).toContain("DIFF");
    expect(prompt).toContain("untrusted data");
  });
});
