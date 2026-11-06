#!/usr/bin/env bun

/**
 * Refuses a test suite whose whole line or function coverage falls under its floor. Bun's own
 * `coverageThreshold` holds each file to the threshold, not the suite's total, so this gate sums the
 * lcov report `bun test --coverage --coverage-reporter=lcov` writes to `coverage/lcov.info` of the
 * current directory.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Tenths of a percent: the totals measured on the whole suite, rounded down. A floor only rises. */
export const FLOOR = { lines: 688, functions: 801 } as const;

const LCOV = join("coverage", "lcov.info");

interface Total {
  readonly hit: number;
  readonly found: number;
}

export interface Totals {
  readonly lines: Total;
  readonly functions: Total;
}

const sumOf = (lcov: string, key: string): number =>
  [...lcov.matchAll(new RegExp(`^${key}:(\\d+)$`, "gmu"))].reduce((sum, [, count]) => sum + Number(count), 0);

/** The line and function totals of an lcov report; a report that names no source file throws. */
export function totalsOf(lcov: string): Totals {
  if (!/^SF:/mu.test(lcov)) {
    throw new Error("the lcov report names no source file: did `bun test --coverage` load any?");
  }

  return {
    lines: { hit: sumOf(lcov, "LH"), found: sumOf(lcov, "LF") },
    functions: { hit: sumOf(lcov, "FNH"), found: sumOf(lcov, "FNF") },
  };
}

const percent = (tenths: number): string => `${(tenths / 10).toFixed(1)} %`;

/** One error per total under its floor, compared in whole numbers so a total at its floor passes. */
export function floorErrors(totals: Totals, floor: Readonly<Record<keyof Totals, number>>): string[] {
  return (["lines", "functions"] as const).flatMap((kind) => {
    const { hit, found } = totals[kind];

    if (hit * 1000 >= floor[kind] * found) {
      return [];
    }

    const measured = `${((hit / found) * 100).toFixed(2)} % (${hit}/${found})`;

    return [
      `${kind} coverage is ${measured}, under its ${percent(floor[kind])} floor. Add a test for the code you left uncovered; the floor never drops.`,
    ];
  });
}

if (import.meta.main) {
  if (!existsSync(LCOV)) {
    console.error(`no ${LCOV}: run \`bun test --coverage --coverage-reporter=lcov\` first.`);
    process.exit(1);
  }

  const errors = floorErrors(totalsOf(readFileSync(LCOV, "utf8")), FLOOR);

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }

    process.exit(1);
  }
}
