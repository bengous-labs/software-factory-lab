import { describe, expect, test } from "bun:test";

import { REVIEW_SETTINGS } from "./review-settings.ts";

describe("REVIEW_SETTINGS", () => {
  test("a light review runs /code-review medium on Sonnet, a deep one /code-review high on Opus", () => {
    expect(REVIEW_SETTINGS).toEqual({
      light: { model: "sonnet", effort: "medium" },
      deep: { model: "opus", effort: "high" },
    });
  });
});
