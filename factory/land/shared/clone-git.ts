/**
 * How a step that runs outside the Worker's sandbox, with the Owner's access, reads a Worker's clone
 * without trusting what the Worker wrote there. The Stop hook reads the branch of a Worker in a clone,
 * and the relay removes the clone once its PR lands. Both take the clone from a path alone, its links
 * resolved, among those Dispatch puts under the clones' directory, and hand git the repository through
 * its environment: git then reads the config and the hooks of the clone's own git directory, and no
 * file that would send it elsewhere. That directory lies under the clone: Claude Code's sandbox, which
 * holds its `config` and `hooks` read-only and refuses to rename or replace `.git`, and a deny rule on
 * its file tools keep both from the Worker.
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
