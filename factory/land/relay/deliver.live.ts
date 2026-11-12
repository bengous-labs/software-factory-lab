/**
 * How a Wake's text reaches the Author's session: one line on its messaging socket while the session
 * runs, else `claude --bg --resume <session-id> "<text>"`, which wakes it with its saved launch options.
 * The Owner's words reach a running background session by `claude stop <id>`, then that resume.
 * The socket's path is the one Claude Code was observed to bind, with the directory its documentation
 * names as the fallback.
 */

import { connect } from "node:net";
import { join } from "node:path";

import type { Run } from "../../lib/run.port.ts";
import { checked } from "../../lib/run.port.ts";
import type { Delivered, Route } from "./wakes.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The paths the messaging socket of the Claude Code process `pid` may have, most likely first. */
export function socketPathsOf(pid: number, env: Env, uid: number): readonly string[] {
  const runtime = env["XDG_RUNTIME_DIR"] ?? join("/run", "user", String(uid));

  return [join(runtime, "cc-socks", `${pid}.sock`), join("/tmp", `cc-socks-${uid}`, `${pid}.sock`)];
}

/** Writes `line` on the Unix socket at `path`; false when it does not connect or the write fails. */
export function postToSocket(path: string, line: string): Promise<boolean> {
  return new Promise((settle) => {
    const socket = connect(path);

    socket.once("error", () => {
      settle(false);
    });

    socket.once("connect", () => {
      socket.end(line, () => {
        settle(true);
      });
    });
  });
}

/** What `deliverer` needs: the commands it runs, the socket it writes, its wait, and what the socket's path is made of. */
export interface DeliverIo {
  readonly run: Run;
  readonly post: (path: string, line: string) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly env: Env;
  readonly uid: number;
  readonly cwd: string;
}

/**
 * What `deliverer` sends: the route, the line for a socket, the command for a resume, and whether the
 * listing of sessions shows the session stopped.
 */
export interface Delivery {
  readonly route: Route;
  readonly socketLine: string;
  readonly resumeArgs: readonly string[];
  readonly stopped: () => Promise<boolean>;
}

/** A stop the listing did not show in time: the relay counts these to bound its stops. */
export class NotStopped extends Error {
  override readonly name = "NotStopped";
}

/** How often, and how many times, a stop looks for the session to have stopped: 30 s in all. */
const STOP_LOOK_MS = 2000;

const STOP_LOOKS = 15;

/** Whether the listing shows the session stopped within `STOP_LOOKS` looks. */
async function stoppedWithin(io: DeliverIo, stopped: Delivery["stopped"]): Promise<boolean> {
  for (let look = 0; look < STOP_LOOKS; look += 1) {
    await io.sleep(STOP_LOOK_MS);

    if (await stopped()) {
      return true;
    }
  }

  return false;
}

async function onSocket(io: DeliverIo, pid: number, line: string): Promise<Delivered | null> {
  for (const path of socketPathsOf(pid, io.env, io.uid)) {
    if (await io.post(path, line)) {
      return "socket";
    }
  }

  return null;
}

/**
 * Delivers over `io`: to a running session, the line on the first of its socket's paths that takes it;
 * to one that no longer runs, the resume. Null when neither went through: a running session whose
 * socket takes nothing is not resumed, which would start a copy of it. A stop runs `claude stop`, then
 * resumes the session once the listing shows it stopped: a resume right after the stop still finds it
 * running and starts a copy. A stop that fails throws, and so does a session still listed running after
 * the looks: its process is ending, and its socket may never read a line; the Wakes stay pending, and a
 * later poll resumes the session once it is stopped. A wait delivers nothing.
 */
export function deliverer(io: DeliverIo): (delivery: Delivery) => Promise<Delivered | null> {
  return async ({ route, socketLine, resumeArgs, stopped }) => {
    if (route.kind === "wait") {
      return null;
    }

    if (route.kind === "socket") {
      return onSocket(io, route.pid, socketLine);
    }

    if (route.kind === "stop") {
      await checked(io.run, ["claude", "stop", route.id], { cwd: io.cwd, timeoutMs: 120_000 });

      if (!(await stoppedWithin(io, stopped))) {
        throw new NotStopped(`claude stop ${route.id}: the session is still listed running after 30 s`);
      }
    }

    const resumed = await io.run(resumeArgs, { cwd: io.cwd, timeoutMs: 120_000 });

    return resumed.code === 0 ? "resume" : null;
  };
}
