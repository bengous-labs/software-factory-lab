/**
 * A path with its links resolved, for the steps that compare a Worker's clone with the clones'
 * directory (`clone-git.ts`): the Stop hook and the relay resolve both the same way, so they agree on
 * which clone a path lies in.
 */

import { realpathSync } from "node:fs";

/** `path` with every link in it resolved; null when it names nothing, or cannot be resolved. */
export function realPathOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
