/**
 * Which clone a path lies in, among those Dispatch makes under the clones' directory. The Stop hook
 * reads it to trust a clone, and the relay to remove the clone of a landed PR: both run with the
 * Owner's access, outside the sandbox, on a path the Worker could make point anywhere, so they resolve
 * its links first and take a clone from the path alone.
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
