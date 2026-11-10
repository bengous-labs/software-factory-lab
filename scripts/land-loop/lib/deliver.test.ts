import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Ran, Run } from "../ports/run.ts";
import { deliverer, postToSocket, socketPathsOf } from "./deliver.ts";
import type { Delivery } from "./deliver.ts";

const RESUME = ["claude", "--bg", "--resume", "S1", "the lines"];

const delivery = (route: Delivery["route"]): Delivery => ({ route, socketLine: "LINE\n", resumeArgs: RESUME });

interface World {
  readonly posts: string[];
  readonly runs: Array<{ argv: readonly string[]; env: unknown }>;
}

/** A deliverer whose sockets take a line only at the paths `open`, and whose resume exits `code`. */
function world(open: readonly string[], code = 0): World & { deliver: ReturnType<typeof deliverer> } {
  const posts: string[] = [];
  const runs: World["runs"] = [];

  const run: Run = (argv, options): Promise<Ran> => {
    runs.push({ argv, env: options.env });

    return Promise.resolve({ code, stdout: "", stderr: "" });
  };

  const deliver = deliverer({
    run,
    post: (path, line) => {
      posts.push(`${path} ${line}`);

      return Promise.resolve(open.includes(path));
    },
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    uid: 1000,
    cwd: "/main",
  });

  return { posts, runs, deliver };
}

describe("socketPathsOf", () => {
  test("the socket of a process sits under the runtime directory, else under the per-user directory of /tmp", () => {
    expect(socketPathsOf(34_502, { XDG_RUNTIME_DIR: "/run/user/1000" }, 1000)).toEqual([
      "/run/user/1000/cc-socks/34502.sock",
      "/tmp/cc-socks-1000/34502.sock",
    ]);
    expect(socketPathsOf(7, {}, 501)).toEqual(["/run/user/501/cc-socks/7.sock", "/tmp/cc-socks-501/7.sock"]);
  });
});

describe("deliverer", () => {
  test("a running session gets the line on its socket, and is not resumed", async () => {
    const found = world(["/run/user/1000/cc-socks/34502.sock"]);

    expect(await found.deliver(delivery({ kind: "socket", pid: 34_502 }))).toBe("socket");
    expect(found.posts).toEqual(["/run/user/1000/cc-socks/34502.sock LINE\n"]);
    expect(found.runs).toEqual([]);
  });

  test("the second path is tried when the first takes nothing", async () => {
    const found = world(["/tmp/cc-socks-1000/34502.sock"]);

    expect(await found.deliver(delivery({ kind: "socket", pid: 34_502 }))).toBe("socket");
    expect(found.posts).toHaveLength(2);
  });

  test("a running session whose socket takes nothing is never resumed: Claude Code would start a copy", async () => {
    const found = world([]);

    expect(await found.deliver(delivery({ kind: "socket", pid: 34_502 }))).toBeNull();
    expect(found.runs).toEqual([]);
  });

  test("a session that no longer runs is resumed with the bare command, and no socket is tried", async () => {
    const found = world([]);

    expect(await found.deliver(delivery({ kind: "resume" }))).toBe("resume");
    expect(found.runs).toEqual([{ argv: RESUME, env: undefined }]);
    expect(found.posts).toEqual([]);
  });

  test("a resume that fails delivered nothing", async () => {
    expect(await world([], 1).deliver(delivery({ kind: "resume" }))).toBeNull();
  });
});

describe("postToSocket", () => {
  test("writes the line on a socket that listens, and says so", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sock-")), "s.sock");

    const received = new Promise<string>((settle) => {
      const server = createServer((connection) => {
        let text = "";
        connection.on("data", (chunk) => {
          text += String(chunk);
        });
        connection.on("end", () => {
          server.close();
          settle(text);
        });
      });

      server.listen(path);
    });

    await Bun.sleep(20);

    expect(await postToSocket(path, "LINE\n")).toBe(true);
    expect(await received).toBe("LINE\n");
  });

  test("a path nothing listens on takes nothing", async () => {
    expect(await postToSocket(join(tmpdir(), "no-such-dir", "s.sock"), "LINE\n")).toBe(false);
  });
});
