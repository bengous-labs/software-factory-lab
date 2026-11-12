#!/usr/bin/env bun

/**
 * The Merge bot's process, which `.github/workflows/merge-bot.yml` runs from the default branch with the
 * App's token (`land/merge-bot/`).
 */

import { main } from "../land/merge-bot/main.live.ts";

await main();
