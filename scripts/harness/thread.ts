#!/usr/bin/env bun

/**
 * The author's answer to a review finding: replies in the thread with the text given, then resolves
 * it. The watcher prints each finding with the thread id this takes.
 *
 *   bun scripts/harness/thread.ts <thread-id> "<reply>"
 */

import { checked, run } from "./lib/run.ts";

export const REPLY = "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}";

export const RESOLVE = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}";

if (import.meta.main) {
  const [id, body] = process.argv.slice(2);

  if (id === undefined || body === undefined || body.trim() === "") {
    throw new Error('usage: bun scripts/harness/thread.ts <thread-id> "<reply>"');
  }

  const cwd = process.cwd();
  await checked(run, ["gh", "api", "graphql", "-f", `query=${REPLY}`, "-f", `id=${id}`, "-f", `body=${body}`], { cwd });
  await checked(run, ["gh", "api", "graphql", "-f", `query=${RESOLVE}`, "-f", `id=${id}`], { cwd });
  console.log(`replied to ${id} and resolved it`);
}
