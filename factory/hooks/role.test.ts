import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { $ } from "bun";

import { roleFileOf } from "./role.ts";

const SCRIPT = join(import.meta.dir, "role.ts");

const ROLES = join(import.meta.dir, "..", "roles");

const input = (source: string): string => JSON.stringify({ hook_event_name: "SessionStart", source, cwd: "/repo" });

/** The context the hook gives a session that starts with `env`, or null when it prints nothing. */
async function contextOf(env: Readonly<Record<string, string>>, source = "startup"): Promise<string | null> {
  const { LAB_AUTHOR: _author, LAB_ROLE: _role, ...inherited } = process.env;

  const ran = await $`bun ${SCRIPT} < ${Buffer.from(input(source))}`.env({ ...inherited, ...env }).quiet();

  const stdout = ran.stdout.toString();

  if (stdout === "") {
    return null;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the hook's own output, whose shape the next line checks.
  const output = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };

  expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");

  return output.hookSpecificOutput.additionalContext;
}

describe("roleFileOf", () => {
  test("names the Worker's file for an Author, and the Owner's session's file for any other session", () => {
    expect(roleFileOf(input("startup"), { LAB_AUTHOR: "1" })).toBe("worker.md");
    expect(roleFileOf(input("startup"), {})).toBe("owner.md");
    expect(roleFileOf(input("startup"), { LAB_AUTHOR: "0" })).toBe("owner.md");
  });

  test("names the Worker's file for a bench session, which holds LAB_ROLE=worker and is no Author", () => {
    expect(roleFileOf(input("startup"), { LAB_ROLE: "worker" })).toBe("worker.md");
    expect(roleFileOf(input("startup"), { LAB_ROLE: "owner" })).toBe("owner.md");
  });

  test("names it again after a clear or a compaction, which drop it from the context", () => {
    expect(roleFileOf(input("clear"), { LAB_AUTHOR: "1" })).toBe("worker.md");
    expect(roleFileOf(input("compact"), {})).toBe("owner.md");
  });

  test("names none on a resume, whose transcript already holds it", () => {
    expect(roleFileOf(input("resume"), { LAB_AUTHOR: "1" })).toBeNull();
    expect(roleFileOf(input("resume"), {})).toBeNull();
  });

  test("names none in a fork, the Stop hook's included, whose transcript already holds it", () => {
    expect(roleFileOf(input("fork"), { LAB_AUTHOR: "1" })).toBeNull();
    expect(roleFileOf(input("fork"), {})).toBeNull();
  });

  test("refuses an input with no source", () => {
    expect(() => roleFileOf(JSON.stringify({ hook_event_name: "SessionStart" }), {})).toThrow("source");
  });
});

describe("the hook", () => {
  const worker = Bun.file(join(ROLES, "worker.md")).text();
  const owner = Bun.file(join(ROLES, "owner.md")).text();

  test("gives a session with LAB_AUTHOR=1 the Worker's text, and not the other", async () => {
    const context = await contextOf({ LAB_AUTHOR: "1" });

    expect(context).toBe(await worker);
    expect(context).not.toContain(await owner);
  });

  test("gives a session without LAB_AUTHOR the other text, and not the Worker's", async () => {
    const context = await contextOf({});

    expect(context).toBe(await owner);
    expect(context).not.toContain(await worker);
  });

  test("gives nothing to a resumed session, so the text does not pile up at each Wake", async () => {
    expect(await contextOf({ LAB_AUTHOR: "1" }, "resume")).toBeNull();
  });
});
