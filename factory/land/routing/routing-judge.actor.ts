/**
 * The Routing judge's settings: a small model, named by its alias, that reads the change headless with
 * read-only tools, each call under the read guard, and three minutes to answer. When it fails or answers
 * outside its schema, `judgeFailed` answers the safe side.
 */
export const ROUTING_JUDGE = {
  model: "haiku",
  tools: ["Read", "Grep", "Glob", "Bash"],
  timeoutMs: 180_000,
} as const;
