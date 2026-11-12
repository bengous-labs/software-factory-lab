import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { relayEnvOf, relayFilesOf, relayStarter, watchesOf } from "./relay-start.live.ts";
import type { RelayIo } from "./relay-start.live.ts";

const RELAY = resolve(import.meta.dir, "..", "..", "bin", "relay.ts");

interface Left {
  readonly argv: readonly string[];
  readonly options: { cwd: string; env: Record<string, string>; log: string };
}

/** A main checkout, and a starter whose `watching` processes are relays of the PRs they name. */
function world(watching: ReadonlyMap<number, number> = new Map()) {
  const checkout = mkdtempSync(join(tmpdir(), "relay-"));
  const left: Left[] = [];
  const asked: Array<[number, number]> = [];

  const io: RelayIo = {
    watches: (pid, pr) => {
      asked.push([pid, pr]);

      return watching.get(pid) === pr;
    },
    leave: (argv, options) => {
      left.push({ argv, options });

      return 4242;
    },
  };

  const start = relayStarter(io, {
    HOME: "/home/a",
    PATH: "/bin",
    LAB_AUTHOR: "1",
    GH_TOKEN: "t0k",
    LAB_STOP_FORK: "1",
    LAB_AUTHOR_TOKEN_FILE: "/h/token",
    UNSET: undefined,
  });

  return { checkout, left, asked, start };
}

describe("relayStarter", () => {
  test("a Publication starts one relay for its PR in the main checkout, and names its session", () => {
    const { checkout, left, start } = world();

    expect(start({ pr: 12, session: "S1", checkout })).toBe("started");
    expect(left).toEqual([
      {
        argv: ["bun", RELAY, "12"],
        options: {
          cwd: checkout,
          env: { HOME: "/home/a", PATH: "/bin", LAB_AUTHOR_TOKEN_FILE: "/h/token" },
          log: join(checkout, ".lab", "state", "relay-12.log"),
        },
      },
    ]);
    expect(readFileSync(relayFilesOf(checkout, 12).session, "utf8")).toBe("S1\n");
  });

  test("a later Publication of the same PR starts none while that one runs, and names the new session", () => {
    const { checkout, left, asked, start } = world(new Map([[777, 12]]));
    mkdirSync(join(checkout, ".lab", "state"), { recursive: true });
    writeFileSync(relayFilesOf(checkout, 12).pid, "777\n");

    expect(start({ pr: 12, session: "S2", checkout })).toBe("running");
    expect(left).toEqual([]);
    expect(asked).toEqual([[777, 12]]);
    expect(readFileSync(relayFilesOf(checkout, 12).session, "utf8")).toBe("S2\n");
  });

  test("a relay that died, or a pid that is another PR's relay, another process or no number, does not count", () => {
    for (const [pidFile, watching] of [
      ["777\n", new Map<number, number>()],
      ["777\n", new Map([[777, 13]])],
      ["not a pid\n", new Map([[777, 12]])],
      ["", new Map([[0, 12]])],
    ] as const) {
      const { checkout, left, start } = world(watching);
      mkdirSync(join(checkout, ".lab", "state"), { recursive: true });
      writeFileSync(relayFilesOf(checkout, 12).pid, pidFile);

      expect(start({ pr: 12, session: "S1", checkout })).toBe("started");
      expect(left).toHaveLength(1);
    }
  });

  test("the relay of one PR does not keep another PR from getting its own", () => {
    const { checkout, left, start } = world(new Map([[777, 12]]));
    mkdirSync(join(checkout, ".lab", "state"), { recursive: true });
    writeFileSync(relayFilesOf(checkout, 12).pid, "777\n");

    expect(start({ pr: 13, session: "S1", checkout })).toBe("started");
    expect(left.map((one) => one.argv)).toEqual([["bun", RELAY, "13"]]);
  });
});

describe("relayEnvOf", () => {
  test("the relay keeps what it needs to run and to find the token, never the Author's marker, its token or the fork flag", () => {
    const env = relayEnvOf({
      HOME: "/home/a",
      PATH: "/bin",
      USER: "a",
      SHELL: "/bin/bash",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000",
      CLAUDE_CONFIG_DIR: "/c",
      LAB_AUTHOR_TOKEN_FILE: "/h/token",
      LAB_AUTHOR: "1",
      GH_TOKEN: "t0k",
      LAB_STOP_FORK: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: "/x.sock",
    });

    expect(env).toEqual({
      HOME: "/home/a",
      PATH: "/bin",
      USER: "a",
      SHELL: "/bin/bash",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000",
      CLAUDE_CONFIG_DIR: "/c",
      LAB_AUTHOR_TOKEN_FILE: "/h/token",
    });
  });
});

describe("watchesOf", () => {
  test("a process is the relay of a PR when its command line runs the relay with that PR", () => {
    expect(watchesOf(`bun ${RELAY} 12\n`, 12)).toBe(true);
    expect(watchesOf("bun /other/checkout/factory/bin/relay.ts 12", 12)).toBe(true);
  });

  test("another PR's relay, another script, or a pid reused by another process is not", () => {
    expect(watchesOf(`bun ${RELAY} 13`, 12)).toBe(false);
    expect(watchesOf(`bun ${RELAY} 123`, 12)).toBe(false);
    expect(watchesOf("bun /r/factory/bin/merge-bot.ts 12", 12)).toBe(false);
    expect(watchesOf("vim bin/relay.ts.bak 12", 12)).toBe(false);
    expect(watchesOf(`bun ${RELAY}`, 12)).toBe(false);
    expect(watchesOf("", 12)).toBe(false);
  });
});
