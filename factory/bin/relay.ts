#!/usr/bin/env bun

/**
 * The relay of one pull request, left detached by the Stop hook at a Publication, in the main checkout
 * (`land/relay/`). Every 30 s it takes one turn: it reads the PR as the Author's machine account and
 * delivers the Wakes it has not delivered yet. The keys it delivered are kept in
 * `.lab/state/watch-<pr>.json`. It ends when the PR is landed or closed, and writes its start and its end
 * to `.lab/outcomes.log`.
 *
 *   bun factory/bin/relay.ts <pr>
 */

import { main } from "../land/relay/relay.live.ts";
import { run } from "../lib/run.live.ts";

await main({ run });
