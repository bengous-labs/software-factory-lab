/**
 * How a Wake's text reaches the Author's session: one line on its messaging socket while the session
 * runs, else `claude --bg --resume <session-id> "<text>"`, which wakes it with its saved launch options.
 * The Owner's words reach a running background session by `claude stop <id>`, then that resume.
 * An API Worker's session is resumed headless, left running detached in its worktree.
 * The socket's path is the one Claude Code was observed to bind, with the directory its documentation
 * names as the fallback.
 */

import { connect } from "node:net";
import { join } from "node:path";

import type { Env } from "../../lib/env.ts";
import type { Leave, Run } from "../../lib/run.port.ts";
import { checked } from "../../lib/run.port.ts";
import { sessionEnvOf } from "../../lib/session-env.ts";
import { NotStopped, TurnFailed } from "./main.ts";
import type { Delivery } from "./main.ts";
import type { Delivered } from "./wakes.ts";

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

/**
 * What `deliverer` needs: the commands it runs, the headless turn it leaves running, the socket it
 * writes, its wait, and its environment, which the socket's path is made of and a headless turn takes whole.
 */
export interface DeliverIo {
  readonly run: Run;
  readonly leave: Leave;
  readonly post: (path: string, line: string) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly env: Env;
  readonly uid: number;
  readonly cwd: string;
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

/**
 * How long the relay looks at a headless turn it left running. A turn that ends with an error in that
 * time failed at its start, its key refused, its credits spent or its settings unread; one that still
 * runs after it works, and the relay goes back to its PR.
 */
const TURN_START_MS = 60_000;

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
 * later poll resumes the session once it is stopped. A wait delivers nothing. A headless resume is left
 * running with what a session needs of the relay's environment, which holds no credential: the turn takes
 * its key and the Worker's identity from the settings file its command names. The relay looks at that
 * turn for a minute: one that ends with an error in that time throws, delivered nothing, and a later
 * poll resumes the session again; one that works is delivered, whatever its end, so a turn that fails
 * late is not given the same Wakes twice, and one that hangs does not hold the relay.
 */
export function deliverer(io: DeliverIo): (delivery: Delivery) => Promise<Delivered | null> {
  return async ({ route, socketLine, resumeArgs, stopped }) => {
    if (route.kind === "wait") {
      return null;
    }

    if (route.kind === "socket") {
      return onSocket(io, route.pid, socketLine);
    }

    if (route.kind === "headless") {
      const turn = io.leave(resumeArgs, { cwd: route.worktree, env: sessionEnvOf(io.env), log: route.log });
      const code = await Promise.race([turn.exited, io.sleep(TURN_START_MS).then(() => null)]);

      if (code !== null && code !== 0) {
        throw new TurnFailed(
          `the headless turn ended with exit ${code} at its start: ${route.log} holds what it printed`,
        );
      }

      return "headless";
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
