import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Ran, Run } from "../../lib/run.port.ts";
import { deliverer, NotStopped, postToSocket, socketPathsOf } from "./deliver.live.ts";
import type { Delivery } from "./deliver.live.ts";

const RESUME = ["claude", "--bg", "--resume", "S1", "the lines"];

/** A delivery whose session the listing shows stopped from its `stoppedAt`th look on; never when null. */
const delivery = (route: Delivery["route"], stoppedAt: number | null = 1): Delivery => {
  const looks = { count: 0 };

  return {
    route,
    socketLine: "LINE\n",
    resumeArgs: RESUME,
    stopped: () => {
      looks.count += 1;

      return Promise.resolve(stoppedAt !== null && looks.count >= stoppedAt);
    },
  };
};

const STOP = { kind: "stop", id: "725ecfab" } as const;

/** The message a delivery rejects with; null when it resolves. */
const failureOf = (delivered: Promise<unknown>): Promise<string | null> =>
  delivered.then(
    () => null,
    (error: Error) => error.message,
  );

interface World {
  readonly posts: string[];
  readonly runs: Array<{ argv: readonly string[]; env: unknown }>;
  readonly sleeps: number[];
}

/** A deliverer whose sockets take a line only at the paths `open`, and whose resume exits `code`. */
function world(open: readonly string[], code = 0): World & { deliver: ReturnType<typeof deliverer> } {
  const posts: string[] = [];
  const runs: World["runs"] = [];
  const sleeps: number[] = [];

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
    sleep: (ms) => {
      sleeps.push(ms);

      return Promise.resolve();
    },
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    uid: 1000,
    cwd: "/main",
  });

  return { posts, runs, sleeps, deliver };
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

  test("a stop stops the session, waits until the listing shows it stopped, then resumes it with the text", async () => {
    const found = world(["/run/user/1000/cc-socks/34502.sock"]);

    expect(await found.deliver(delivery(STOP, 3))).toBe("resume");
    expect(found.runs.map((ran) => ran.argv)).toEqual([["claude", "stop", "725ecfab"], RESUME]);
    expect(found.sleeps).toEqual([2000, 2000, 2000]);
    expect(found.posts).toEqual([]);
  });

  test("a session the listing still shows running 30 s after the stop is neither resumed nor written to: the delivery throws", async () => {
    const found = world(["/run/user/1000/cc-socks/34502.sock"]);

    const failure = await found.deliver(delivery(STOP, null)).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(NotStopped);
    expect(failure?.message).toBe("claude stop 725ecfab: the session is still listed running after 30 s");
    expect(found.runs.map((ran) => ran.argv)).toEqual([["claude", "stop", "725ecfab"]]);
    expect(found.sleeps).toHaveLength(15);
    expect(found.posts).toEqual([]);
  });

  test("a listing that fails after the stop throws, and resumes nothing: a later poll finds the session stopped", async () => {
    const found = world([]);

    const listingFails: Delivery = {
      ...delivery(STOP),
      stopped: () => Promise.reject(new Error("claude agents --json exited 1")),
    };

    expect(await failureOf(found.deliver(listingFails))).toBe("claude agents --json exited 1");
    expect(found.runs.map((ran) => ran.argv)).toEqual([["claude", "stop", "725ecfab"]]);
  });

  test("a stop that fails throws, naming the command, and resumes nothing", async () => {
    const found = world([], 1);

    expect(await failureOf(found.deliver(delivery(STOP)))).toStartWith("claude stop 725ecfab exited 1");
    expect(found.runs.map((ran) => ran.argv)).toEqual([["claude", "stop", "725ecfab"]]);
  });

  test("a wait delivers nothing and touches nothing: a later turn sends the text again", async () => {
    const found = world(["/run/user/1000/cc-socks/34502.sock"]);

    expect(await found.deliver(delivery({ kind: "wait" }))).toBeNull();
    expect(found.runs).toEqual([]);
    expect(found.posts).toEqual([]);
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
