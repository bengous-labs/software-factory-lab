import { Schema } from "effect";

export const TokenCounts = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheCreation: Schema.Finite,
});

export type TokenCounts = typeof TokenCounts.Type;

interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

/** A call's counts: the sum over every model its `modelUsage` names. */
export function tokensOf(modelUsage: Readonly<Record<string, ModelUsage>>): TokenCounts {
  return Object.values(modelUsage).reduce<TokenCounts>(
    (sum, usage) => ({
      input: sum.input + usage.inputTokens,
      output: sum.output + usage.outputTokens,
      cacheRead: sum.cacheRead + usage.cacheReadInputTokens,
      cacheCreation: sum.cacheCreation + usage.cacheCreationInputTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  );
}

/** The counts as a log line's words. */
export function tokensText(tokens: TokenCounts | null): string {
  return tokens === null
    ? "tokens none"
    : `tokens in=${tokens.input} out=${tokens.output} cache_read=${tokens.cacheRead} cache_write=${tokens.cacheCreation}`;
}
