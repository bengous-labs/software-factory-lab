import { describe, expect, test } from "bun:test";

import type { Run } from "../lib/run.ts";
import { fable, FABLE_MODEL, promptOf, verdictOf } from "./fable.ts";

const answer = (structured: object): string =>
  JSON.stringify({ structured_output: structured, total_cost_usd: 0.2, modelUsage: { "claude-fable-5-1": { costUSD: 0.2 } } });

describe("verdictOf", () => {
  test("only an explicit ok: true is OK; ok: false, a missing field or unreadable output is not", () => {
    expect(verdictOf(answer({ ok: true, reason: "fine" }))).toEqual({ ok: true, reason: "fine" });
    expect(verdictOf(answer({ ok: false, reason: "bypass" }))).toEqual({ ok: false, reason: "bypass" });
    expect(verdictOf(answer({ reason: "?" })).ok).toBe(false);
    expect(verdictOf("not json").ok).toBe(false);
  });
});

describe("fable", () => {
  test("runs Fable with no tool and a schema, and reads its model and cost", async () => {
    const calls: string[][] = [];
    const run: Run = async (argv) => {
      calls.push([...argv]);

      return { code: 0, stdout: answer({ ok: true, reason: "fine" }), stderr: "" };
    };

    const result = await fable(run, "/repo", "prompt");

    expect(calls[0]).toEqual(expect.arrayContaining(["--model", FABLE_MODEL, "--tools", "", "--json-schema"]));
    expect(result).toEqual({ verdict: { ok: true, reason: "fine" }, model: "claude-fable-5-1", costUsd: 0.2 });
  });

  test("a failed run is not OK", async () => {
    const run: Run = async () => ({ code: 1, stdout: "", stderr: "denied" });

    expect((await fable(run, "/repo", "prompt")).verdict.ok).toBe(false);
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
