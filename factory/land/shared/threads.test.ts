import { describe, expect, test } from "bun:test";

import type { Ran, Run, RunOptions } from "../../lib/run.port.ts";
import { replyInThread, resolveThread } from "./threads.ts";

const OPTIONS: RunOptions = { cwd: "/repo", env: { GH_TOKEN: "t" } };

const OK: Ran = { code: 0, stdout: "{}", stderr: "" };

/** A runner that records each call and answers `ran`. */
function recording(ran = OK) {
  const calls: Array<{ argv: readonly string[]; options: RunOptions }> = [];

  const runner: Run = (argv, options) => {
    calls.push({ argv, options });

    return Promise.resolve(ran);
  };

  return { calls, runner };
}

/** The message `write` rejects with; empty when it resolves. */
async function failureOf(write: Promise<void>): Promise<string> {
  try {
    await write;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return "";
}

describe("the writes on a review thread", () => {
  test("a reply posts its body in the thread, through gh's GraphQL, with the caller's options", async () => {
    const { calls, runner } = recording();

    await replyInThread(runner, OPTIONS, "PRRT_1", "Fixed in abc.");

    expect(calls).toEqual([
      {
        argv: [
          "gh",
          "api",
          "graphql",
          "-f",
          "query=mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}",
          "-f",
          "id=PRRT_1",
          "-f",
          "body=Fixed in abc.",
        ],
        options: OPTIONS,
      },
    ]);
  });

  test("a resolution resolves the thread, through gh's GraphQL, with the caller's options", async () => {
    const { calls, runner } = recording();

    await resolveThread(runner, OPTIONS, "PRRT_2");

    expect(calls).toEqual([
      {
        argv: [
          "gh",
          "api",
          "graphql",
          "-f",
          "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}",
          "-f",
          "id=PRRT_2",
        ],
        options: OPTIONS,
      },
    ]);
  });

  test("a write gh refuses throws with what gh printed", async () => {
    const { runner } = recording({ code: 1, stdout: "", stderr: "GraphQL: Could not resolve to a node" });

    expect(await failureOf(replyInThread(runner, OPTIONS, "PRRT_1", "x"))).toBe(
      "gh api graphql exited 1: GraphQL: Could not resolve to a node",
    );
    expect(await failureOf(resolveThread(runner, OPTIONS, "PRRT_2"))).toBe(
      "gh api graphql exited 1: GraphQL: Could not resolve to a node",
    );
  });
});
