import type { Env } from "./env.ts";

/**
 * The variables a launch keeps of its caller's environment: what a session needs to start and to
 * reach the API. No credential: a Worker runs code and could read it with `env`, so it authenticates
 * from `CLAUDE_CONFIG_DIR` or its settings. When a launch starts Claude Code's background service,
 * the service gives its environment to every session started after it, so the caller's `GH_TOKEN`,
 * API credentials, Author marker or session variables stay out of it. A service already running keeps the environment
 * it started with; the Worker settings' `env` still sets the Worker's identity over it.
 */
export const SESSION_VARIABLES = [
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

/** The variables of `env` among `names` that are set. */
export function keptOf(env: Env, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
}

/** The whole environment of a session a launch starts, from the caller's `env`. */
export function sessionEnvOf(env: Env): Record<string, string> {
  return keptOf(env, SESSION_VARIABLES);
}
