/**
 * What the relay does with the clone of a Worker at the end of its PR: a PR that lands removes it, as
 * nothing else names it again; one closed without landing keeps it, since the Owner may reopen it and
 * the Worker's session lives there. The relay runs with the Owner's access and the Worker wrote the
 * clone, so it removes only a directory that lies directly under the clones' directory, both paths
 * with their links resolved, and only once nothing uses it: no turn of the session runs there, no
 * other relay resumes a session there, and no branch holds a commit that was never pushed.
 */

import { cloneRootOf } from "../shared/clone-git.ts";

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

/** What still uses a landed PR's clone. */
export interface CloneUse {
  /** The listing of sessions shows a turn of the Worker's session running in it. */
  readonly running: boolean;
  /** The PRs whose running relay resumes a session in it too. */
  readonly relays: readonly number[];
  /** The commits on its branches that no remote branch holds. */
  readonly unpushed: number;
}

/** Why the clone `clone` stays, from what still uses it; null when nothing does, and it goes. */
export function keptWhyOf(clone: string, { running, relays, unpushed }: CloneUse): string | null {
  if (running) {
    return `its clone ${clone} stays, as a turn of its session still runs there`;
  }

  if (relays.length > 0) {
    return `its clone ${clone} stays, as the relay of ${relays.map((pr) => `#${pr}`).join(", ")} resumes a session there`;
  }

  if (unpushed > 0) {
    return `its clone ${clone} stays, as it holds ${unpushed} commit(s) no remote branch holds`;
  }

  return null;
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
