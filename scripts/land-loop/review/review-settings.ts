/**
 * The model and the `/code-review` effort of each Review depth. Models go by alias: the result names
 * the exact model that ran.
 */

import type { ReviewDepth } from "../contract.ts";
import type { ReviewRequest } from "./review-report.ts";

export const REVIEW_SETTINGS: Readonly<Record<Exclude<ReviewDepth, "none">, Pick<ReviewRequest, "model" | "effort">>> =
  {
    light: { model: "sonnet", effort: "medium" },
    deep: { model: "opus", effort: "high" },
  };
