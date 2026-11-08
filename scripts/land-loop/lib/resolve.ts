import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** A path resolved against the checkout with every link followed; one that does not resolve is denied. */
export function resolverOf(root: string): (path: string) => string | null {
  return (path) => {
    try {
      return realpathSync(isAbsolute(path) ? path : join(root, path));
    } catch {
      return null;
    }
  };
}
