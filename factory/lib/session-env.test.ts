import { describe, expect, test } from "bun:test";

import { keptOf, sessionEnvOf } from "./session-env.ts";

describe("sessionEnvOf", () => {
  test("keeps what Claude Code needs to reach the API, proxies in either case", () => {
    const reach = {
      HTTPS_PROXY: "http://p",
      HTTP_PROXY: "http://p",
      ALL_PROXY: "socks5://p",
      NO_PROXY: "localhost",
      https_proxy: "http://p",
      http_proxy: "http://p",
      all_proxy: "socks5://p",
      no_proxy: "localhost",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      TMPDIR: "/tmp/x",
      XDG_CONFIG_HOME: "/h/.config",
    };

    expect(sessionEnvOf({ ...reach, GH_TOKEN: "t" })).toEqual(reach);
  });

  test("keeps what a session needs to start and to find its login", () => {
    const start = {
      HOME: "/h",
      PATH: "/bin",
      USER: "a",
      SHELL: "/bin/bash",
      LANG: "C.UTF-8",
      TERM: "xterm",
      XDG_RUNTIME_DIR: "/run/user/1000",
      CLAUDE_CONFIG_DIR: "/c",
    };

    expect(sessionEnvOf(start)).toEqual(start);
  });

  test("keeps no API credential of the caller, which the Worker could read with env", () => {
    expect(sessionEnvOf({ HOME: "/h", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "o" })).toEqual({ HOME: "/h" });
  });

  test("keeps only what a session needs to start, so no token or Author marker of the caller reaches it", () => {
    expect(
      sessionEnvOf({ HOME: "/h", PATH: "/bin", GH_TOKEN: "t", LAB_AUTHOR: "1", CLAUDECODE: "1", LANG: undefined }),
    ).toEqual({ HOME: "/h", PATH: "/bin" });
  });
});

describe("keptOf", () => {
  test("keeps the named variables that are set, and no other", () => {
    const kept = keptOf({ A: "1", B: undefined, C: "3", D: "" }, ["A", "B", "D", "E"]);

    expect(kept).toEqual({ A: "1", D: "" });
    expect(Object.keys(kept)).toEqual(["A", "D"]);
  });
});
