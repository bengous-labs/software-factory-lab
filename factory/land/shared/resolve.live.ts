import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { GuardScope } from "./tool-guard.ts";

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

/** A guard's scope over the checkout at `cwd`, every link followed. */
export function scopeOf(cwd: string): GuardScope {
  const root = realpathSync(cwd);

  return { root, resolve: resolverOf(root) };
}
