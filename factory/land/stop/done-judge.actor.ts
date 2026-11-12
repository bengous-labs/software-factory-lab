/**
 * The Done judge's settings, which every fork the Stop hook launches shares: the tools a fork reads with,
 * each call under the fork guard, that it asks its user nothing, and how long it may take. The fork runs
 * on the model of the session it forks.
 */
export const DONE_JUDGE = {
  // No Monitor: a fork that armed a watch waited on it until it was killed (#38, #39).
  tools: ["Read", "Grep", "Glob", "Bash"],
  permissionMode: "dontAsk",
  timeoutMs: 180_000,
} as const;
