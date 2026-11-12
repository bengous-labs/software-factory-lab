#!/usr/bin/env bun

/**
 * The Stop hook's process, which `.claude/settings.json` wires on Stop (`land/stop/`).
 *
 * Reads the Stop input on stdin; `LAB_STOP_FORK=1` marks a fork this hook launched.
 */

import { startRelay } from "../land/relay/relay-start.live.ts";
import { main } from "../land/stop/hook.live.ts";
import { run } from "../lib/run.live.ts";

await main({ run, startRelay });
