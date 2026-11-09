/**
 * The review job's sessions: the Code review, then the security pass when the request asks for it and the
 * Code review reported, each on its own prompt, merged into the job's result. `session` runs one review
 * session on a prompt.
 */

import type { SessionAnswer } from "../ports/review.ts";
import type { EarlierThread } from "./findings.ts";
import { promptOf } from "./review-prompt.ts";
import type { Guides } from "./review-prompt.ts";
import { mergedResultOf, resultOf } from "./review-report.ts";
import type { ReviewRequest, ReviewResult } from "./review-report.ts";
import { securityPromptOf } from "./security-prompt.ts";

/** What the prompts read besides the request: the guides from `dev` and the earlier findings. */
export interface PromptInputs {
  readonly guides: Guides;
  readonly threads: readonly EarlierThread[];
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

  return mergedResultOf(request, code, security, runUrl);
}
