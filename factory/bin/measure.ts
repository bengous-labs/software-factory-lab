#!/usr/bin/env bun

/**
 * The Land loop's weekly measure (`measure/main.ts`), printed for the Owner.
 *
 *   bun factory/bin/measure.ts --since YYYY-MM-DD
 */

import { run } from "../lib/run.live.ts";
import { argsOf, measure, USAGE } from "../measure/main.ts";

const args = argsOf(process.argv.slice(2));

if (args === null) {
  console.error(USAGE);
  process.exit(1);
}

process.stdout.write(await measure(run, process.cwd(), args.since));
