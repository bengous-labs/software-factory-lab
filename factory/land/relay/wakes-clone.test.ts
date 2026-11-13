import { describe, expect, test } from "bun:test";

import { sendingOf, socketLineOf, targetOf, targetTextOf } from "./wakes.ts";

const CLONE = "/home/me/clones/issue-7";

describe("the relay's session file for a background Worker in a clone", () => {
  const headless = { model: "claude-opus-5-5", worktree: CLONE };

  test("a second line holds the clone the session works in, and reads back", () => {
    const text = targetTextOf({ session: "S1", headless: null, clone: CLONE });

    expect(text).toBe('S1\n{"clone":"/home/me/clones/issue-7"}\n');
    expect(targetOf(text)).toEqual({ session: "S1", headless: null, clone: CLONE });
  });

  test("what a headless resume needs wins over a clone: an API Worker's session names its own", () => {
    const text = targetTextOf({ session: "S1", headless, clone: CLONE });

    expect(text).toBe(`S1\n${JSON.stringify(headless)}\n`);
    expect(targetOf(text)).toEqual({ session: "S1", headless, clone: null });
  });

  test("a clone that does not read throws, naming the file", () => {
    expect(() => targetOf('S1\n{"clone":7}\n')).toThrow("the second line of the relay's session file: ");
  });
});

describe("the sending to a background Worker in a clone", () => {
  const agents = JSON.stringify([{ pid: 34_502, id: "725ecfab", kind: "background", sessionId: "S1", status: "idle" }]);
  const place = { checkout: "/repo", home: "/home/me" };
  const wake = { text: "the lines", stop: false, held: false };

  test("its background resume runs in its clone, where Claude Code keeps its conversation; a session in no clone is resumed in the relay's own checkout", () => {
    expect(sendingOf(agents, { session: "S1", headless: null, clone: CLONE }, wake, place)).toEqual({
      route: { kind: "socket", pid: 34_502 },
      socketLine: socketLineOf("the lines"),
      resumeArgs: ["claude", "--bg", "--resume", "S1", "the lines"],
      resumeIn: CLONE,
    });
    expect(sendingOf(agents, { session: "S1", headless: null, clone: null }, wake, place).resumeIn).toBeNull();
  });
});
