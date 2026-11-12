/**
 * What makes a session an Author: its environment holds `LAB_AUTHOR=1`. The launcher gives it through
 * the `env` of the settings file it passes at launch. Nothing else makes a session an Author: not its
 * branch, not being interactive, not being in the background.
 */
export const AUTHOR_VARIABLE = "LAB_AUTHOR";

type Env = Readonly<Record<string, string | undefined>>;

export function isAuthor(env: Env): boolean {
  return env[AUTHOR_VARIABLE] === "1";
}

/** The variable the Worker bench (`scripts/lab/bench.ts`) sets to `worker` on the sessions it launches. */
export const ROLE_VARIABLE = "LAB_ROLE";

/**
 * Whether a session plays a Worker: an Author, or a session of the Worker bench, which reads the
 * Worker's instructions and is held by its guards but is no Author, so the Stop hook publishes nothing.
 */
export function isWorker(env: Env): boolean {
  return isAuthor(env) || env[ROLE_VARIABLE] === "worker";
}
