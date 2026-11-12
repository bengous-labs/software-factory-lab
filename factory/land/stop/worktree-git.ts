/**
 * How the Stop hook reads the branch of an API Worker without trusting anything the Worker can write.
 * The hook runs outside the sandbox that holds the Worker's code, and the Worker writes its worktree and
 * most of the repository's git directory, the files that tell git where a worktree's repository and its
 * config are among them. So the hook never lets git find the repository from the worktree: it takes the
 * worktree from the session's own directory and Dispatch's layout, and hands git the repository through
 * its environment, which pins the config git reads to the main checkout's, a file the sandbox keeps
 * read-only.
 */

import { WORKTREES_DIR } from "../../contract.ts";

/**
 * The worktree of `checkout` the directory `cwd` lies in, as Dispatch lays the worktrees out; null when
 * `cwd` lies in none. It is read in the path alone: no file of the worktree says where it is.
 */
export function worktreeRootOf(checkout: string, cwd: string): string | null {
  const under = `${checkout}/${WORKTREES_DIR}/`;

  if (!cwd.startsWith(under)) {
    return null;
  }

  const [name = ""] = cwd.slice(under.length).split("/");

  return name === "" || name === "." || name === ".." ? null : `${under}${name}`;
}

/** One directory of the repository's `worktrees/`: its name, and the text of its `gitdir` file, null when it has none. */
export interface AdminDir {
  readonly id: string;
  readonly gitdir: string | null;
}

/**
 * The directory of the repository's `worktrees/` that is the worktree `root`'s, by its name: the one
 * whose `gitdir` file names `root`. Null when none or several do: the Worker writes those files, and
 * the hook publishes nothing from a worktree it cannot tell.
 */
export function adminIdOf(dirs: readonly AdminDir[], root: string): string | null {
  const [found, ...others] = dirs.filter((dir) => dir.gitdir?.trim() === `${root}/.git`);

  return found === undefined || others.length > 0 ? null : found.id;
}

/**
 * The environment that hands git the worktree `root` of `checkout`, whose directory under the
 * repository's `worktrees/` is `id`: git then looks for no repository, reads neither the worktree's
 * `.git` file nor its `commondir`, and takes its config and its hooks from the main checkout's.
 */
export function pinnedGitEnvOf(checkout: string, id: string, root: string) {
  return {
    GIT_DIR: `${checkout}/.git/worktrees/${id}`,
    GIT_COMMON_DIR: `${checkout}/.git`,
    GIT_WORK_TREE: root,
  };
}
