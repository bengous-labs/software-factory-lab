/**
 * How a Wake's text reaches the Author's session: one line on its messaging socket while the session
 * runs, else `claude --bg --resume <session-id> "<text>"`, which wakes it with its saved launch options.
 * The socket's path is the one Claude Code was observed to bind, with the directory its documentation
 * names as the fallback.
 */

import { connect } from "node:net";
import { join } from "node:path";

import type { Run } from "../ports/run.ts";

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

/** How a text was delivered. */
export type Delivered = "socket" | "resume";

/** What `deliverer` needs: the commands it runs, the socket it writes, and what the socket's path is made of. */
export interface DeliverIo {
  readonly run: Run;
  readonly post: (path: string, line: string) => Promise<boolean>;
  readonly env: Env;
  readonly uid: number;
  readonly cwd: string;
}

/** The route to a session, as `relay/wakes.ts` `routeOf` reads it. */
type Route = { readonly kind: "socket"; readonly pid: number } | { readonly kind: "resume" };

/** What `deliverer` sends: the route, the line for a socket, the command for a resume. */
export interface Delivery {
  readonly route: Route;
  readonly socketLine: string;
  readonly resumeArgs: readonly string[];
}

/**
 * Delivers over `io`: to a running session, the line on the first of its socket's paths that takes it;
 * to one that no longer runs, the resume. Null when neither went through: a running session whose
 * socket takes nothing is not resumed, which would start a copy of it.
 */
export function deliverer(io: DeliverIo): (delivery: Delivery) => Promise<Delivered | null> {
  return async ({ route, socketLine, resumeArgs }) => {
    if (route.kind === "socket") {
      for (const path of socketPathsOf(route.pid, io.env, io.uid)) {
        if (await io.post(path, socketLine)) {
          return "socket";
        }
      }

      return null;
    }

    const resumed = await io.run(resumeArgs, { cwd: io.cwd, timeoutMs: 120_000 });

    return resumed.code === 0 ? "resume" : null;
  };
}
