/**
 * How a Publication leaves the relay of its PR: one detached process that outlives the Author's
 * session, with none of the session's environment but what the relay needs. Its state lives under
 * `.lab/state/` of the main checkout: `relay-<pr>.pid`, the process that watches the PR, which the relay writes;
 * `relay-<pr>.session`, the session of the PR's latest Publication, where its Wakes go, with what a headless
 * resume needs when it is an API Worker's; `relay-<pr>.log`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Env } from "../../lib/env.ts";
import { leave } from "../../lib/run.live.ts";
import type { Leave } from "../../lib/run.port.ts";
import { keptOf, SESSION_VARIABLES } from "../../lib/session-env.ts";
import type { RelayStart, StartRelay } from "../shared/relay.port.ts";
import { targetTextOf } from "./wakes.ts";

const RELAY = resolve(import.meta.dir, "..", "..", "bin", "relay.ts");

/**
 * The variables the relay keeps of the hook's environment. It resumes sessions with `claude --bg`, and a
 * launch that starts Claude Code's background service gives its environment to every session started
 * after it; an API Worker's headless turn takes from the relay what a session needs to start and to reach
 * the API. So the relay keeps that, and where the Author's token lies. The Author's marker, its token and
 * the fork flag never reach the relay.
 */
const KEPT = [...SESSION_VARIABLES, "LAB_AUTHOR_TOKEN_FILE"];

/** The relay's whole environment, from the hook's. */
export function relayEnvOf(env: Env): Record<string, string> {
  return keptOf(env, KEPT);
}

/** The files of the relay of PR `pr` under the main checkout `checkout`. */
export function relayFilesOf(checkout: string, pr: number) {
  const stateDir = join(checkout, ".lab", "state");

  return {
    stateDir,
    pid: join(stateDir, `relay-${pr}.pid`),
    session: join(stateDir, `relay-${pr}.session`),
    log: join(stateDir, `relay-${pr}.log`),
    seen: join(stateDir, `watch-${pr}.json`),
  };
}

/** What starting a relay touches outside its files. */
export interface RelayStartIo {
  /** Whether process `pid` is the relay of PR `pr`. */
  readonly watches: (pid: number, pr: number) => boolean;
  readonly leave: Leave;
}

/**
 * A `StartRelay` over `io`: it names the publishing session as the one the PR's Wakes go to, then starts
 * a relay unless the one `relay-<pr>.pid` names still watches the PR.
 */
export function relayStarter(io: RelayStartIo, env: Env): StartRelay {
  return ({ pr, session, headless, checkout }: RelayStart) => {
    const files = relayFilesOf(checkout, pr);
    mkdirSync(files.stateDir, { recursive: true });
    writeFileSync(files.session, targetTextOf({ session, headless }));

    const pid = existsSync(files.pid) ? readFileSync(files.pid, "utf8").trim() : "";

    if (/^[1-9]\d*$/u.test(pid) && io.watches(Number(pid), pr)) {
      return "running";
    }

    io.leave(["bun", RELAY, String(pr)], { cwd: checkout, env: relayEnvOf(env), log: files.log });

    return "started";
  };
}

/** Whether the command line of process `pid`, as `ps` prints it, is the relay of PR `pr`. */
export function watchesOf(args: string, pr: number): boolean {
  const words = args.trim().split(/\s+/u);
  const script = words.findIndex((word) => word.endsWith(join("bin", "relay.ts")));

  return script !== -1 && words[script + 1] === String(pr);
}

const IO: RelayStartIo = {
  watches: (pid, pr) => {
    const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="], { stdout: "pipe", stderr: "ignore" });

    return ps.exitCode === 0 && watchesOf(ps.stdout.toString(), pr);
  },
  leave,
};

export const startRelay: StartRelay = relayStarter(IO, process.env);
