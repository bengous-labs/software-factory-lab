#!/usr/bin/env bun

/**
 * The SessionStart hook that gives a session the instructions of its role, from a file under
 * `.claude/roles/` a person edits: `worker.md` to an Author, a session whose environment holds
 * `LAB_AUTHOR=1`, and `owner.md` to any other. It prints the file as the session's `additionalContext`.
 * On a resume it prints nothing: the transcript already holds the text, and the relay resumes a Worker at
 * each Wake, so printing it again would pile it up. A clear or a compaction drops it, so it prints it again.
 * It prints nothing in a fork the Stop hook launched, which judges the session rather than acting in it.
 *
 * Reads the SessionStart input on stdin.
 */

import { join } from "node:path";

import { Schema } from "effect";

import { isAuthor } from "../lib/author-session.ts";
import { decodeJson } from "../lib/json.ts";

/** The variable the Stop hook sets on the read-only forks it launches. */
const STOP_FORK_FLAG = "LAB_STOP_FORK";

const ROLES = join(import.meta.dir, "..", "..", ".claude", "roles");

/** The SessionStart input, as far as this hook reads it. */
const HookInput = Schema.Struct({ source: Schema.String });

/** The file under `.claude/roles/` a session starting with `stdin` and `env` reads, or null on a resume or in a Stop fork. */
export function roleFileOf(stdin: string, env: Readonly<Record<string, string | undefined>>): string | null {
  const { source } = decodeJson(HookInput, "the SessionStart input", stdin);

  if (source === "resume" || env[STOP_FORK_FLAG] === "1") {
    return null;
  }

  return isAuthor(env) ? "worker.md" : "owner.md";
}

if (import.meta.main) {
  const file = roleFileOf(await Bun.stdin.text(), process.env);

  if (file !== null) {
    const additionalContext = await Bun.file(join(ROLES, file)).text();

    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
  }
}
