import { Schema } from "effect";

export const TokenCounts = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheCreation: Schema.Finite,
});

export type TokenCounts = typeof TokenCounts.Type;

/** The `modelUsage` of a call's result, as far as the counts read it. */
export const ModelUsage = Schema.Record(
  Schema.String,
  Schema.Struct({
    inputTokens: Schema.Finite,
    outputTokens: Schema.Finite,
    cacheReadInputTokens: Schema.Finite,
    cacheCreationInputTokens: Schema.Finite,
  }),
);

/** A call's counts: the sum over every model its `modelUsage` names. */
export function tokensOf(modelUsage: typeof ModelUsage.Type): TokenCounts {
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
