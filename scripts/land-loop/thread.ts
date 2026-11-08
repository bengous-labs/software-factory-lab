#!/usr/bin/env bun

/**
 * The author's answer to a review finding, a fix or a rejection: replies in the thread, then resolves
 * it, as the Author's machine account. The PR watch prints each finding with the thread id this takes.
 *
 *   bun scripts/land-loop/thread.ts <thread-id> "Fixed in <sha>: <what changed>"
 *   bun scripts/land-loop/thread.ts <thread-id> --reject "<reason>"
 */

import { AUTHOR_MARK, REJECT_MARK } from "./author-mark.ts";
import { ghEnv, requiredAuthorToken } from "./lib/author.ts";
import { checked, run } from "./lib/run.ts";
import type { Run } from "./ports/run.ts";

export const REPLY =
  "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}";

export const RESOLVE = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}";

export const USAGE =
  'usage: bun scripts/land-loop/thread.ts <thread-id> "Fixed in <sha>: <what changed>" | bun scripts/land-loop/thread.ts <thread-id> --reject "<reason>"';

const FIX_PREFIX = "Fixed in ";

const REJECT_PREFIX = "Rejected: ";

/**
 * The reply the arguments after the thread id ask for, without its marks; null for a blank reason, a
 * reply that is not a fix, or an extra argument, such as the words of an unquoted reason.
 */
function bodyOf(rest: readonly string[]): string | null {
  const [first, reason] = rest;

  if (first === "--reject") {
    return rest.length !== 2 || reason === undefined || reason.trim() === "" ? null : `${REJECT_PREFIX}${reason}`;
  }

  return rest.length === 1 && first?.startsWith(FIX_PREFIX) === true && first.slice(FIX_PREFIX.length).trim() !== ""
    ? first
    : null;
}

/** The thread id and the reply without its marks, or null for a refused form. */
export function argsOf(argv: readonly string[]): { id: string; body: string } | null {
  const [id, ...rest] = argv;
  const body = bodyOf(rest);

  return id === undefined || id.trim() === "" || body === null ? null : { id, body };
}

/** The reply as posted: a rejection carries `REJECT_MARK`, then every answer `AUTHOR_MARK`. */
function postedOf(body: string): string {
  return body.startsWith(REJECT_PREFIX) ? `${body}\n\n${REJECT_MARK}\n\n${AUTHOR_MARK}` : `${body}\n\n${AUTHOR_MARK}`;
}

/** Replies first, so a thread is never resolved without the author's answer in it. */
export async function answer(
  runner: Run,
  cwd: string,
  token: string,
  { id, body }: { readonly id: string; readonly body: string },
): Promise<void> {
  const options = { cwd, env: ghEnv(token) };

  await checked(
    runner,
    ["gh", "api", "graphql", "-f", `query=${REPLY}`, "-f", `id=${id}`, "-f", `body=${postedOf(body)}`],
    options,
  );
  await checked(runner, ["gh", "api", "graphql", "-f", `query=${RESOLVE}`, "-f", `id=${id}`], options);
}

if (import.meta.main) {
  const args = argsOf(process.argv.slice(2));

  if (args === null) {
    throw new Error(USAGE);
  }

  await answer(run, process.cwd(), requiredAuthorToken(process.env), args);
  console.log(`replied to ${args.id} and resolved it`);
}
