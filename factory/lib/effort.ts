/** The effort levels Claude Code takes, from the `--effort` of its command line or the Agent SDK's `effort`. */

import { Schema } from "effect";

export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);

export type Effort = typeof Effort.Type;
