#!/usr/bin/env bun

/**
 * The author's comment on its PR's conversation, such as the decisions it made: posts the text given
 * with the author's mark, so the author's PR watch does not print it back, as the Author's machine account.
 *
 *   bun scripts/land-loop/comment.ts <pr> "<comment>"
 */

import { AUTHOR_MARK } from "./author-mark.ts";
import { ghEnv, requiredAuthorToken } from "./lib/author.ts";
import { checked, run } from "./lib/run.ts";
import type { Run } from "./ports/run.ts";

export const USAGE = 'usage: bun scripts/land-loop/comment.ts <pr> "<comment>"';

/** The PR number and the comment, or null when either is missing, blank or the number is not an integer. */
export function argsOf(argv: readonly string[]): { pr: number; body: string } | null {
  const [pr, body] = argv;

  if (pr === undefined || !/^\d+$/u.test(pr) || body === undefined || body.trim() === "") {
    return null;
  }

  return { pr: Number(pr), body };
}

export async function post(
  runner: Run,
  cwd: string,
  token: string,
  { pr, body }: { readonly pr: number; readonly body: string },
): Promise<void> {
  await checked(runner, ["gh", "pr", "comment", String(pr), "--body", `${body}\n\n${AUTHOR_MARK}`], {
    cwd,
    env: ghEnv(token),
  });
}

if (import.meta.main) {
  const args = argsOf(process.argv.slice(2));

  if (args === null) {
    throw new Error(USAGE);
  }

  await post(run, process.cwd(), requiredAuthorToken(process.env), args);
  console.log(`commented on PR #${args.pr}`);
}
