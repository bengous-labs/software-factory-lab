/**
 * The review job's sessions: the Code review, then the security pass when the request asks for it and the
 * Code review reported, each on its own prompt, merged into the job's result. `session` runs one review
 * session on a prompt. Each finding that reports an earlier one again names it by the id the prompt gave
 * it; the result names that finding's review thread instead.
 */

import type { SessionAnswer } from "../ports/review.ts";
import type { EarlierThread } from "./findings.ts";
import { earlierIdOf, promptOf } from "./review-prompt.ts";
import type { Guides } from "./review-prompt.ts";
import { mergedResultOf, resultOf } from "./review-report.ts";
import type { ReviewRequest, ReviewResult } from "./review-report.ts";
import { securityPromptOf } from "./security-prompt.ts";

/** What the prompts read besides the request: the guides from `dev` and the earlier findings. */
export interface PromptInputs {
  readonly guides: Guides;
  readonly threads: readonly EarlierThread[];
}

/** `result` with each finding's `earlier` read back to the review thread its id names; an id the prompt did not list names none. */
export function withEarlierThreads(result: ReviewResult, threads: readonly EarlierThread[]): ReviewResult {
  if (result.kind === "failed") {
    return result;
  }

  const byId = new Map(threads.map((thread, index) => [earlierIdOf(index), thread.thread]));

  const findings = result.report.findings.map((finding) => ({
    ...finding,
    earlier: finding.earlier === null ? null : (byId.get(finding.earlier.replaceAll(/[[\]\s]/gu, "")) ?? null),
  }));

  return { ...result, report: { ...result.report, findings } };
}

export async function reviewRunOf(
  request: ReviewRequest,
  { guides, threads }: PromptInputs,
  session: (prompt: string) => Promise<SessionAnswer>,
  runUrl: string,
): Promise<ReviewResult> {
  const code = await session(promptOf(request, guides, threads));

  // A Code review that failed, or whose answer does not read, fails the round whatever the security pass finds: it is not run.
  const reported = resultOf(request, code, runUrl).kind === "reported";
  const security = request.security && reported ? await session(securityPromptOf(request, guides, threads)) : null;

  return withEarlierThreads(mergedResultOf(request, code, security, runUrl), request.round === 1 ? [] : threads);
}
