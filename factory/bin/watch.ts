#!/usr/bin/env bun

/**
 * The watch of an orchestrating session (`watch/`).
 *
 *   bun factory/bin/watch.ts [--standing] [<issue>...]
 */

import { run } from "../lib/run.live.ts";
import { main } from "../watch/watch.live.ts";

await main({ run });
