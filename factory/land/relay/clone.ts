/**
 * What the relay does with the clone of a Worker at the end of its PR: a PR that lands removes it, as
 * nothing else names it again; one closed without landing keeps it, since the Owner may reopen it and
 * the Worker's session lives there. The relay runs with the Owner's access and the Worker wrote the
 * clone, so it removes only a directory that lies directly under the clones' directory, both paths
 * with their links resolved.
 */

import { cloneRootOf } from "../shared/clone-root.ts";

/** What the end of a PR did with its Worker's clone: removed, or left, and why, the clone named. */
export type CloneEnd =
  { readonly removed: true; readonly clone: string } | { readonly removed: false; readonly why: string };

/**
 * The directory to remove for the clone `realWorktree`, from the clones' directory and the clone with
 * their links resolved: the clone itself when it lies directly under the clones' directory, and null
 * for any other path, one deeper or outside them.
 */
export function removableCloneOf(realClones: string, realWorktree: string): string | null {
  return cloneRootOf(realClones, realWorktree) === realWorktree ? realWorktree : null;
}

/** Why the relay of a PR ended, as its end line in `.lab/outcomes.log` says, with what it did with the clone. */
export function endReasonOf(landed: boolean, clone: CloneEnd | null): string {
  if (!landed) {
    return "the PR closed without landing";
  }

  if (clone === null) {
    return "the PR landed";
  }

  return clone.removed ? `the PR landed: its clone ${clone.clone} is removed` : `the PR landed: ${clone.why}`;
}
