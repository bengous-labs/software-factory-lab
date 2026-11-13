/**
 * How the Stop hook reads the branch of an API Worker without letting git find the repository from a
 * directory the Worker writes. The hook runs outside the sandbox that holds the Worker's code, and the
 * Worker writes its clone. So the hook takes the clone from the session's own directory and from where
 * Dispatch puts the clones, and hands git the repository through its environment: git then reads the
 * config and the hooks of the clone's own git directory, which the sandbox and a deny rule keep from the
 * Worker, and no file that would send it elsewhere.
 */

/**
 * The clone the directory `cwd` lies in, among those the directory `clones` holds; null when `cwd` lies
 * in none. It is read in the path alone: no file of the clone says where it is.
 */
export function cloneRootOf(clones: string, cwd: string): string | null {
  const under = `${clones}/`;

  if (!cwd.startsWith(under)) {
    return null;
  }

  const [name = ""] = cwd.slice(under.length).split("/");

  return name === "" || name === "." || name === ".." ? null : `${under}${name}`;
}

/**
 * The environment that hands git the clone at `root`: git then looks for no repository, follows no
 * `commondir`, and takes its config and its hooks from the clone's git directory.
 */
export function pinnedGitEnvOf(root: string) {
  const gitDir = `${root}/.git`;

  return { GIT_DIR: gitDir, GIT_COMMON_DIR: gitDir, GIT_WORK_TREE: root };
}
