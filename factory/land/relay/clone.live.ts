/**
 * The removal of a landed PR's clone (`clone.ts`), on the disk: the relay calls it once, at the end of
 * a PR that landed.
 */

import { realpathSync, rmSync } from "node:fs";

import { removableCloneOf } from "./clone.ts";
import type { CloneEnd } from "./clone.ts";
import { targetOf } from "./wakes.ts";

function realPathOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function removeTree(path: string): void {
  rmSync(path, { recursive: true });
}

/**
 * Removes the clone of the session `sessionText` reads, the text of `relay-<pr>.session`, when it lies
 * directly under `clones`; null when the session works in no clone. A removal that fails, or a session
 * file that cannot be read, is returned with its error: the relay still ends.
 */
export function removeClone(
  clones: string,
  sessionText: () => string,
  remove: (path: string) => void = removeTree,
): CloneEnd | null {
  let worktree: string;

  try {
    const { headless } = targetOf(sessionText());

    if (headless === null) {
      return null;
    }

    worktree = headless.worktree;
  } catch (error) {
    return {
      removed: false,
      why: `its clone stays, as its session is unread: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const realClones = realPathOf(clones);
  const realWorktree = realPathOf(worktree);
  const clone = realClones === null || realWorktree === null ? null : removableCloneOf(realClones, realWorktree);

  if (clone === null) {
    return { removed: false, why: `its clone ${worktree} stays, as it is no directory directly under ${clones}` };
  }

  try {
    remove(clone);

    return { removed: true, clone };
  } catch (error) {
    return {
      removed: false,
      why: `its clone ${clone} stays, as its removal failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
