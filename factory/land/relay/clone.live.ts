/**
 * The end of a landed PR's clone (`clone.ts`), on the disk: the relay calls it once, at the end of its
 * PR. It reads what still uses the clone from the listing of sessions, the other running relays and
 * git, run on the clone through its pinned environment, and removes the clone when nothing does.
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";

import { clonesDirOf } from "../../install/paths.ts";
import { checked } from "../../lib/run.port.ts";
import type { Run } from "../../lib/run.port.ts";
import { pinnedGitEnvOf } from "../shared/clone-git.ts";
import { realPathOf } from "../shared/real-path.live.ts";
import { keptWhyOf, removableCloneOf, uncommittedOf } from "./clone.ts";
import type { CloneEnd, CloneUse } from "./clone.ts";
import { relayFilesOf, relayRuns, relayWatches } from "./relay-start.live.ts";
import type { RelayStartIo } from "./relay-start.live.ts";
import { stoppedIn, targetOf } from "./wakes.ts";

/** What the end of a PR's clone needs: where the relay runs, the PR, the home that holds the clones, and its commands. */
export interface CloneEndIo {
  readonly run: Run;
  /** The main checkout, whose `.lab/state/` holds the relays' files. */
  readonly checkout: string;
  readonly home: string;
  readonly pr: number;
  /** Removes a directory and what it holds; a test hands one that fails. */
  readonly remove?: (path: string) => void;
  /** Whether a process is the relay of a PR; a test hands a fake of `ps`. */
  readonly watches?: RelayStartIo["watches"];
}

function removeTree(path: string): void {
  rmSync(path, { recursive: true });
}

/** The PRs other than `pr` whose relay still runs, and whose session works in `clone`. */
function relaysIn({ checkout, pr, watches = relayWatches }: CloneEndIo, clone: string): number[] {
  const { stateDir } = relayFilesOf(checkout, pr);

  return readdirSync(stateDir)
    .map((name) => /^relay-(\d+)\.session$/u.exec(name)?.[1])
    .filter((other) => other !== undefined)
    .map(Number)
    .filter((other) => other !== pr && relayRuns(checkout, other, watches))
    .filter((other) => {
      const { headless } = targetOf(readFileSync(relayFilesOf(checkout, other).session, "utf8"));

      return headless !== null && realPathOf(headless.worktree) === clone;
    });
}

/**
 * What reads a clone's uncommitted work: every new file named, each stash counted, and no index
 * written. A submodule's status is git run in a directory of the clone, under the config the Worker
 * wrote there, so none is entered.
 */
const STATUS_ARGS = [
  "git",
  "--no-optional-locks",
  "status",
  "--porcelain=v2",
  "--show-stash",
  "--untracked-files=all",
  "--ignore-submodules=all",
];

async function useOf(io: CloneEndIo, clone: string, session: string): Promise<CloneUse> {
  const { run, checkout } = io;
  const agents = await checked(run, ["claude", "agents", "--json"], { cwd: checkout });

  const git = { cwd: checkout, env: pinnedGitEnvOf(clone) };
  const unpushed = await checked(run, ["git", "rev-list", "--count", "--branches", "--not", "--remotes"], git);
  const status = await checked(run, STATUS_ARGS, git);

  return {
    running: !stoppedIn(agents, session),
    relays: relaysIn(io, clone),
    unpushed: Number(unpushed),
    uncommitted: uncommittedOf(status),
  };
}

/**
 * Removes the clone of the session `relay-<pr>.session` names when the PR `landed`, it lies directly
 * under the clones' directory of `home`, and nothing uses it; null when the PR closed without landing or
 * its session works in no clone. A clone kept, a removal that fails, or a file or command that cannot be
 * read, is returned with why: the relay still ends.
 */
export async function cloneEndOf(landed: boolean, io: CloneEndIo): Promise<CloneEnd | null> {
  if (!landed) {
    return null;
  }

  try {
    const { session, headless } = targetOf(readFileSync(relayFilesOf(io.checkout, io.pr).session, "utf8"));

    if (headless === null) {
      return null;
    }

    const clones = clonesDirOf(io.home);
    const realClones = realPathOf(clones);
    const realWorktree = realPathOf(headless.worktree);

    if (realWorktree === null) {
      return { removed: false, why: `its clone ${headless.worktree} is gone already` };
    }

    const clone = realClones === null ? null : removableCloneOf(realClones, realWorktree);

    if (clone === null) {
      return {
        removed: false,
        why: `its clone ${headless.worktree} stays, as it is no directory directly under ${clones}`,
      };
    }

    const why = keptWhyOf(clone, await useOf(io, clone, session));

    if (why !== null) {
      return { removed: false, why };
    }

    try {
      (io.remove ?? removeTree)(clone);
    } catch (error) {
      return {
        removed: false,
        why: `its clone ${clone} stays, as its removal failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return { removed: true, clone };
  } catch (error) {
    return {
      removed: false,
      why: `its clone stays, as what uses it is unread: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
