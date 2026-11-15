import type { Env } from "./env.ts";

/**
 * What makes a session an Author: its environment holds `LAB_AUTHOR=1`. The launcher gives it through
 * the `env` of the settings file it passes at launch. Nothing else makes a session an Author: not its
 * branch, not being interactive, not being in the background.
 */
export const AUTHOR_VARIABLE = "LAB_AUTHOR";

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

/**
 * The variable that makes a Worker an API Worker: a headless session whose turns bill the Owner's Console
 * API key. Dispatch gives it through the `env` of the API Worker settings file; the Stop hook reads it,
 * and so does every hook that would run the Worker's code outside its sandbox.
 */
export const API_WORKER_VARIABLE = "LAB_API_WORKER";

export function isApiWorker(env: Env): boolean {
  return env[API_WORKER_VARIABLE] === "1";
}

/**
 * The variable that holds the repository's main checkout in the session of a Worker Dispatch launched:
 * the Worker works in a clone of its own, and its hooks are the main checkout's, named through this
 * variable. An external name: the settings files Dispatch writes and running sessions hold it.
 */
export const CHECKOUT_VARIABLE = "LAB_MAIN_CHECKOUT";

/**
 * Whether a session works in a clone of its own, outside the main checkout: Dispatch gives every Worker
 * it launches the main checkout through `CHECKOUT_VARIABLE`. What runs outside such a Worker's sandbox
 * asks its clone nothing.
 */
export function worksInClone(env: Env): boolean {
  return (env[CHECKOUT_VARIABLE] ?? "") !== "";
}

/**
 * Whether a session's tree holds a Worker's code, which runs in its sandbox alone: an Author's session,
 * or one that works in a clone. A hook's command is outside that sandbox: for such a session it starts
 * no program that reads the tree's own config, a format fix or an install.
 */
export function isSandboxedWorker(env: Env): boolean {
  return isAuthor(env) || worksInClone(env);
}
