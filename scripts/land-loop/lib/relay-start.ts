/**
 * How a Publication leaves the relay of its PR: one detached process that outlives the Author's
 * session, with none of the session's environment but what the relay needs. Its state lives under
 * `.lab/state/` of the main checkout: `relay-<pr>.pid`, the process that watches the PR, which the relay writes;
 * `relay-<pr>.session`, the session of the PR's latest Publication, where its Wakes go; `relay-<pr>.log`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { RelayStart, StartRelay } from "../ports/relay.ts";

const RELAY = resolve(import.meta.dir, "..", "relay", "main.ts");

/**
 * The variables the relay keeps of the hook's environment. It resumes sessions with `claude --bg`, and a
 * launch that starts Claude Code's background service gives its environment to every session started
 * after it: the Author's marker, its token and the fork flag never reach the relay.
 */
const KEPT = ["HOME", "PATH", "USER", "SHELL", "LANG", "XDG_RUNTIME_DIR", "CLAUDE_CONFIG_DIR", "LAB_AUTHOR_TOKEN_FILE"];

type Env = Readonly<Record<string, string | undefined>>;

/** The relay's whole environment, from the hook's. */
export function relayEnvOf(env: Env): Record<string, string> {
  return Object.fromEntries(KEPT.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
}

/** The files of the relay of PR `pr` under the main checkout `checkout`. */
export function relayFilesOf(checkout: string, pr: number) {
  const stateDir = join(checkout, ".lab", "state");

  return {
    stateDir,
    pid: join(stateDir, `relay-${pr}.pid`),
    session: join(stateDir, `relay-${pr}.session`),
    log: join(stateDir, `relay-${pr}.log`),
  };
}

/** What starting a relay touches outside its files. */
export interface RelayIo {
  /** Whether process `pid` is the relay of PR `pr`. */
  readonly watches: (pid: number, pr: number) => boolean;
  /** Leaves `argv` running detached in `cwd`, its output appended to `log`; returns its pid. */
  readonly leave: (
    argv: readonly string[],
    options: { cwd: string; env: Record<string, string>; log: string },
  ) => number;
}

/**
 * A `StartRelay` over `io`: it names the publishing session as the one the PR's Wakes go to, then starts
 * a relay unless the one `relay-<pr>.pid` names still watches the PR.
 */
export function relayStarter(io: RelayIo, env: Env): StartRelay {
  return ({ pr, session, checkout }: RelayStart) => {
    const files = relayFilesOf(checkout, pr);
    mkdirSync(files.stateDir, { recursive: true });
    writeFileSync(files.session, `${session}\n`);

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
  const script = words.findIndex((word) => word.endsWith(join("relay", "main.ts")));

  return script !== -1 && words[script + 1] === String(pr);
}

const IO: RelayIo = {
  watches: (pid, pr) => {
    const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="], { stdout: "pipe", stderr: "ignore" });

    return ps.exitCode === 0 && watchesOf(ps.stdout.toString(), pr);
  },
  leave: (argv, options) => {
    const log = openSync(options.log, "a");
    const [command = "", ...args] = argv;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", log, log],
    });

    child.unref();

    if (child.pid === undefined) {
      throw new Error(`the relay did not start: ${argv.join(" ")}`);
    }

    return child.pid;
  },
};

export const startRelay: StartRelay = relayStarter(IO, process.env);
