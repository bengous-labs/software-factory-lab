#!/usr/bin/env bun

/**
 * The PreToolUse hook of each Stop hook fork, which the Stop hook names in the settings it gives a fork
 * (`land/stop/fork-guard.ts`).
 *
 * Reads the PreToolUse input on stdin; prints the decision on stdout and exits 0.
 */

import { scopeOf } from "../land/shared/resolve.live.ts";
import { forkGuardAnswer } from "../land/stop/fork-guard.ts";

console.log(forkGuardAnswer(await Bun.stdin.text(), scopeOf));
