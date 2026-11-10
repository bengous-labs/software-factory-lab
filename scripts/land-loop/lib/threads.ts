/**
 * The writes the Land loop makes on a review thread: a reply, and its resolution. The Stop hook makes
 * them as the Author's machine account, the Merge bot as the App.
 */

import type { Run, RunOptions } from "../ports/run.ts";
import { checked } from "./run.ts";

const REPLY =
  "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}";

const RESOLVE = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}";

/** Posts `body` as a reply in the review thread `id`. */
export async function replyInThread(runner: Run, options: RunOptions, id: string, body: string): Promise<void> {
  await checked(
    runner,
    ["gh", "api", "graphql", "-f", `query=${REPLY}`, "-f", `id=${id}`, "-f", `body=${body}`],
    options,
  );
}

/** Resolves the review thread `id`. */
export async function resolveThread(runner: Run, options: RunOptions, id: string): Promise<void> {
  await checked(runner, ["gh", "api", "graphql", "-f", `query=${RESOLVE}`, "-f", `id=${id}`], options);
}
