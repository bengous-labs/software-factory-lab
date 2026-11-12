/**
 * The Code review's settings: the model and the `/code-review` effort of each Review depth, the tools of
 * its session, each call under the review guard, and how long one session may take.
 */

import type { ReviewDepth } from "../../contract.ts";
import type { ReviewRequest } from "./review-report.ts";

export const CODE_REVIEW = {
  /** Models go by alias: the result names the exact model that ran. */
  depths: {
    light: { model: "sonnet", effort: "medium" },
    deep: { model: "opus", effort: "high" },
  },
  /** The CLI adds StructuredOutput itself, for `outputFormat`. */
  tools: ["Read", "Grep", "Glob", "Bash", "Agent", "Skill"],
  /** Per session, two of them under the job's 50 minutes: the runner writes its own timeout before GitHub cancels the job. */
  timeoutMs: 20 * 60_000,
} as const satisfies {
  readonly depths: Readonly<Record<Exclude<ReviewDepth, "none">, Pick<ReviewRequest, "model" | "effort">>>;
  readonly tools: readonly string[];
  readonly timeoutMs: number;
};
