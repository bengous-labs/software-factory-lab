import { describe, expect, test } from "bun:test";

import { envOf } from "./env.ts";
import { JOB_VARIABLES, ok } from "./merge-bot.fixtures.ts";

describe("envOf", () => {
  const ports = { run: () => Promise.resolve(ok("")), ask: () => Promise.reject(new Error("no model")) };

  test("each login comes from its own variable, and the run's link from the server, the repository and the run", () => {
    expect(envOf(JOB_VARIABLES, ports, "/work")).toEqual({
      ...ports,
      repo: "o/r",
      owner: "the-owner",
      authorLogin: "the-author",
      appLogin: "the-app[bot]",
      cwd: "/work",
      runUrl: "https://github.example/o/r/actions/runs/5",
    });
  });

  test("a variable that is unset or empty is refused, by its name", () => {
    expect(() => envOf({ ...JOB_VARIABLES, OWNER: undefined }, ports, "/work")).toThrow("OWNER is unset");
    expect(() => envOf({ ...JOB_VARIABLES, AUTHOR_LOGIN: "" }, ports, "/work")).toThrow("AUTHOR_LOGIN is unset");
  });
});
