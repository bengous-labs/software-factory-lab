/** The Merge bot's Env, and how one start builds it from the job's variables, which name the logins it trusts. */

import { requiredOf } from "../../lib/env.ts";
import type { Run } from "../../lib/run.port.ts";
import type { Ask } from "../shared/ask.port.ts";

/** What one start of the Merge bot works with: the job it runs in, the logins it trusts, and the ports its door passes. */
export interface Env {
  readonly repo: string;
  readonly owner: string;
  readonly authorLogin: string;
  readonly appLogin: string;
  readonly cwd: string;
  readonly runUrl: string;
  readonly run: Run;
  readonly ask: Ask;
}

/**
 * The Env of one start, from the job's `variables`, the `ports` its door gives it and the directory it
 * runs in: OWNER is the only login whose Land approval counts, AUTHOR_LOGIN the Author's machine account,
 * APP_LOGIN the App's. Throws, naming the variable, when one is unset.
 */
export function envOf(
  variables: Readonly<Record<string, string | undefined>>,
  ports: Pick<Env, "run" | "ask">,
  cwd: string,
): Env {
  const repo = requiredOf(variables, "GITHUB_REPOSITORY");

  return {
    ...ports,
    repo,
    owner: requiredOf(variables, "OWNER"),
    authorLogin: requiredOf(variables, "AUTHOR_LOGIN"),
    appLogin: requiredOf(variables, "APP_LOGIN"),
    cwd,
    runUrl: `${requiredOf(variables, "GITHUB_SERVER_URL")}/${repo}/actions/runs/${requiredOf(variables, "GITHUB_RUN_ID")}`,
  };
}
