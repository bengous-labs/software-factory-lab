/**
 * Preloaded by `bun test` (`bunfig.toml`). Under `FAST_CHECK_SEED`, which `scripts/ci/mutation.ts`
 * sets for each Stryker pass, every property draws its inputs from that seed: the base's pass and the
 * head's draw the same inputs, so a mutant the base killed by luck cannot read as weakened tests.
 * Without it, each run draws a new seed.
 */

import * as fc from "fast-check";

export function seedOf(value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const seed = Number(value);

  if (value.trim() === "" || !Number.isSafeInteger(seed)) {
    throw new Error(`FAST_CHECK_SEED must be an integer, not ${JSON.stringify(value)}`);
  }

  return seed;
}

const seed = seedOf(process.env["FAST_CHECK_SEED"]);

if (seed !== undefined) {
  fc.configureGlobal({ ...fc.readConfigureGlobal(), seed });
}
