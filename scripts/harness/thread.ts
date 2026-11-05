#!/usr/bin/env bun

/**
 * The author's answer to a review finding: replies in the thread with the text given, then resolves
 * it. The watcher prints each finding with the thread id this takes.
 *
 *   bun scripts/harness/thread.ts <thread-id> "<reply>"
 */

import { checked, run, type Run } from "./lib/run.ts";

export const REPLY = "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}";

export const RESOLVE = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}";

/** Marks a reply as the author's own, so the author's watcher does not print it back. */
export const AUTHOR_MARK = "<!-- lab-author-reply -->";

export const USAGE = 'usage: bun scripts/harness/thread.ts <thread-id> "<reply>"';

/** The thread id and the reply, or null when either is missing or blank. */
export function argsOf(argv: readonly string[]): { id: string; body: string } | null {
  const [id, body] = argv;

  if (id === undefined || id.trim() === "" || body === undefined || body.trim() === "") return null;

  return { id, body };
}

/** Replies first, so a thread is never resolved without the author's answer in it. */
export async function answer(runner: Run, cwd: string, id: string, body: string): Promise<void> {
  await checked(runner, ["gh", "api", "graphql", "-f", `query=${REPLY}`, "-f", `id=${id}`, "-f", `body=${body}\n\n${AUTHOR_MARK}`], { cwd });
  await checked(runner, ["gh", "api", "graphql", "-f", `query=${RESOLVE}`, "-f", `id=${id}`], { cwd });
}

if (import.meta.main) {
  const args = argsOf(process.argv.slice(2));

  if (args === null) throw new Error(USAGE);

  await answer(run, process.cwd(), args.id, args.body);
  console.log(`replied to ${args.id} and resolved it`);
}
