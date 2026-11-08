import { describe, expect, test } from "bun:test";

import { tokensOf, tokensText } from "./tokens.ts";

const usage = (input: number, output: number, cacheRead: number, cacheCreation: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheCreation,
});

describe("tokensOf", () => {
  test("sums every model of a modelUsage", () => {
    expect(tokensOf({ "claude-haiku-5-5": usage(2, 4, 1568, 6770), "claude-opus-5-5": usage(10, 20, 30, 40) })).toEqual(
      { input: 12, output: 24, cacheRead: 1598, cacheCreation: 6810 },
    );
  });

  test("a modelUsage with no model counts nothing", () => {
    expect(tokensOf({})).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  });
});

describe("tokensText", () => {
  test("names each count, and says none when there are no counts", () => {
    expect(tokensText({ input: 41_022, output: 3310, cacheRead: 812_400, cacheCreation: 60_211 })).toBe(
      "tokens in=41022 out=3310 cache_read=812400 cache_write=60211",
    );
    expect(tokensText(null)).toBe("tokens none");
  });
});
