import { describe, expect, test } from "bun:test";

import { sendingOf, targetOf } from "./wakes.ts";

describe("the sending to a Worker on the subscription", () => {
  const place = { checkout: "/repo", home: "/home/me" };
  const worktree = "/home/me/clones/issue-7";
  const wake = { text: "the lines", stop: false, held: false };

  test("its session is resumed headless in its clone, on its own settings file, never the API Worker's", () => {
    const target = { session: "S-gone", headless: { model: "claude-opus-5-5", worktree, api: false } };
    const sending = sendingOf("[]", target, wake, place);

    expect(sending.route).toEqual({ kind: "headless", worktree, log: "/repo/.lab/state/worker-S-gone.log" });
    expect(sending.resumeArgs.slice(0, 8)).toEqual([
      "claude",
      "-p",
      "--resume",
      "S-gone",
      "--model",
      "claude-opus-5-5",
      "--settings",
      "/home/me/.config/software-factory-lab/subscription-worker-settings.json",
    ]);
  });
});

describe("the relay's session file for a Worker in a clone", () => {
  test("a second line that does not say whose turns it bills throws, naming the file", () => {
    expect(() => targetOf('S1\n{"model":"opus","worktree":"/w"}\n')).toThrow(
      "the second line of the relay's session file: ",
    );
  });
});
