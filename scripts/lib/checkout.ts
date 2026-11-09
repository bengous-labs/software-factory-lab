/**
 * The git checkout a worktree hook acts on, and the trust check those hooks share: they act only on a
 * checkout of the project's own repository, the main one or any of its worktrees, never on another
 * repository the session's cwd or an edited file happens to lie in.
 */

/** A checkout: its top-level directory, and the git directory it shares with every worktree of its repository. */
export interface Checkout {
  readonly root: string;
  readonly commonDir: string;
}

/** The checkout `git rev-parse --path-format=absolute --show-toplevel --git-common-dir` printed, or null when it failed. */
export function checkoutFromRevParse(stdout: string, exitCode: number): Checkout | null {
  const [root, commonDir] = stdout.trim().split("\n");

  return exitCode === 0 && root !== undefined && commonDir !== undefined && commonDir !== ""
    ? { root, commonDir }
    : null;
}

/** The root of `checkout`, when it is a checkout of the same repository as `project`; else null. */
export function trustedRoot(checkout: Checkout | null, project: Checkout | null): string | null {
  return checkout !== null && project !== null && checkout.commonDir === project.commonDir ? checkout.root : null;
}

/** The directory of the project Claude Code runs the hooks for, which it always sets in `CLAUDE_PROJECT_DIR`. */
export function projectDirOf(env: Readonly<Partial<Record<string, string>>>): string {
  const dir = env["CLAUDE_PROJECT_DIR"];

  if (dir === undefined) {
    throw new Error("CLAUDE_PROJECT_DIR is not set: Claude Code sets it for every hook");
  }

  return dir;
}
