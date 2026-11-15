import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clonesDirOf } from "../../install/paths.ts";
import type { Run, RunOptions } from "../../lib/run.port.ts";
import { cloneEndOf } from "./clone.live.ts";
import type { CloneEndIo } from "./clone.live.ts";
import { relayFilesOf } from "./relay-start.live.ts";
import { targetTextOf } from "./wakes.ts";

let root = "";

let home = "";

let checkout = "";

let clones = "";

let clone = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "relay-clone-")));
  home = join(root, "home");
  checkout = join(root, "checkout");
  clones = clonesDirOf(home);
  clone = join(clones, "issue-7");
  mkdirSync(join(clone, "app"), { recursive: true });
  writeFileSync(join(clone, "app", "a.ts"), "x\n");
  mkdirSync(join(root, "precious"));
  writeFileSync(join(root, "precious", "secret"), "s\n");
  mkdirSync(relayFilesOf(checkout, 7).stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes `relay-<pr>.session` for the Worker session `session` in `worktree`, and its pid file when `running`. */
function relayOf(pr: number, worktree: string | null, running = false, session = "S1"): void {
  const files = relayFilesOf(checkout, pr);
  const headless = worktree === null ? null : { model: "opus", worktree, api: false };

  writeFileSync(files.session, targetTextOf({ session, headless }));

  if (running) {
    writeFileSync(files.pid, "123\n");
  }
}

/** One command the fake ran, and its options. */
type Call = readonly [readonly string[], RunOptions];

/** A command that fails, as `claude` does when it is logged out. */
const failing: Run = () => Promise.resolve({ code: 1, stdout: "", stderr: "not logged in" });

/** What the fake commands print: the listing of sessions, and git's count of commits no remote holds. */
interface Outside {
  readonly agents?: string;
  readonly unpushed?: string;
  readonly status?: string;
}

/** A fake of the relay's commands, which records each call. */
function runOf({ agents = "[]", unpushed = "0\n", status = "" }: Outside, calls: Call[] = []): Run {
  return (argv, options) => {
    calls.push([[...argv], options]);

    const stdout = argv[0] === "claude" ? agents : argv.includes("status") ? status : unpushed;

    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
}

function ioOf(outside: Outside = {}, more: Partial<CloneEndIo> = {}): CloneEndIo {
  return { run: runOf(outside), checkout, home, pr: 7, watches: () => true, ...more };
}

/** A removal the disk refuses. */
function refuse(): void {
  throw new Error("EACCES: permission denied");
}

describe("cloneEndOf", () => {
  test("a landed PR removes its Worker's clone, which lies directly under the clones of the home", async () => {
    const calls: Call[] = [];
    const pinned = { GIT_DIR: `${clone}/.git`, GIT_COMMON_DIR: `${clone}/.git`, GIT_WORK_TREE: clone };

    relayOf(7, clone);

    expect(await cloneEndOf(true, ioOf({}, { run: runOf({}, calls) }))).toEqual({ removed: true, clone });
    expect(existsSync(clone)).toBe(false);
    expect(calls).toEqual([
      [["claude", "agents", "--json"], { cwd: checkout }],
      [["git", "rev-list", "--count", "--branches", "--not", "--remotes"], { cwd: checkout, env: pinned }],
      [["git", "--no-optional-locks", "status", "--porcelain=v2", "--show-stash"], { cwd: checkout, env: pinned }],
    ]);
  });

  test("a PR closed without landing, or a session in no clone, removes nothing and reads nothing", async () => {
    const calls: Call[] = [];

    relayOf(7, clone);

    expect(await cloneEndOf(false, ioOf({}, { run: runOf({}, calls) }))).toBeNull();

    relayOf(7, null);

    expect(await cloneEndOf(true, ioOf({}, { run: runOf({}, calls) }))).toBeNull();
    expect(calls).toEqual([]);
    expect(existsSync(clone)).toBe(true);
  });

  test("a path outside the clones' directory, or deeper than a clone, is never removed", async () => {
    for (const worktree of [
      join(root, "precious"),
      clones,
      join(clone, "app"),
      `${clones}/${"../".repeat(5)}precious`,
    ]) {
      relayOf(7, worktree);

      expect(await cloneEndOf(true, ioOf())).toEqual({
        removed: false,
        why: `its clone ${worktree} stays, as it is no directory directly under ${clones}`,
      });
    }

    expect(existsSync(join(root, "precious", "secret"))).toBe(true);
    expect(existsSync(join(clone, "app", "a.ts"))).toBe(true);
  });

  test("a clone that is a link out of the clones' directory is never removed, nor what it points to", async () => {
    const link = join(clones, "issue-8");

    symlinkSync(join(root, "precious"), link);
    relayOf(7, link);

    expect(await cloneEndOf(true, ioOf())).toEqual({
      removed: false,
      why: `its clone ${link} stays, as it is no directory directly under ${clones}`,
    });
    expect(existsSync(join(root, "precious", "secret"))).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  test("a home reached through a link names the same clones", async () => {
    const linked = join(root, "linked-home");

    symlinkSync(home, linked);
    relayOf(7, clone);

    expect(await cloneEndOf(true, ioOf({}, { home: linked }))).toEqual({ removed: true, clone });
  });

  test("a clone already gone says so; a clones' directory that is gone removes nothing", async () => {
    const gone = join(clones, "issue-9");

    relayOf(7, gone);

    expect(await cloneEndOf(true, ioOf())).toEqual({ removed: false, why: `its clone ${gone} is gone already` });

    relayOf(7, clone);

    expect(await cloneEndOf(true, ioOf({}, { home: join(root, "no-home") }))).toEqual({
      removed: false,
      why: `its clone ${clone} stays, as it is no directory directly under ${clonesDirOf(join(root, "no-home"))}`,
    });
    expect(existsSync(clone)).toBe(true);
  });

  test("a turn of the session still running there, a commit never pushed, or work uncommitted keeps the clone", async () => {
    relayOf(7, clone);

    expect(await cloneEndOf(true, ioOf({ agents: '[{"sessionId":"S1","pid":42}]' }))).toEqual({
      removed: false,
      why: `its clone ${clone} stays, as a turn of its session still runs there`,
    });
    expect(await cloneEndOf(true, ioOf({ unpushed: "3\n" }))).toEqual({
      removed: false,
      why: `its clone ${clone} stays, as it holds 3 commit(s) no remote branch holds`,
    });
    expect(await cloneEndOf(true, ioOf({ status: "# stash 1\n? notes.md\n" }))).toEqual({
      removed: false,
      why: `its clone ${clone} stays, as it holds 2 uncommitted file(s) or stash(es)`,
    });
    expect(existsSync(clone)).toBe(true);
  });

  test("another running relay whose session works in the clone keeps it; one whose pid is dead or gone, or that works elsewhere, does not", async () => {
    relayOf(7, clone);
    relayOf(8, clone, true, "S2");

    expect(await cloneEndOf(true, ioOf())).toEqual({
      removed: false,
      why: `its clone ${clone} stays, as the relay of #8 resumes a session there`,
    });

    relayOf(9, join(clones, "issue-9"), true, "S3");
    relayOf(10, null, true, "S4");
    relayOf(11, clone, false, "S5");

    const asked: Array<readonly [number, number]> = [];

    const deadEight = (pid: number, pr: number): boolean => {
      asked.push([pid, pr]);

      return pr !== 8;
    };

    expect(await cloneEndOf(true, ioOf({}, { watches: deadEight }))).toEqual({ removed: true, clone });
    expect(asked).toContainEqual([123, 8]);
  });

  test("a removal that fails, or a session file or command unread, keeps the clone and says why", async () => {
    relayOf(7, clone);

    expect(await cloneEndOf(true, ioOf({}, { remove: refuse }))).toEqual({
      removed: false,
      why: `its clone ${clone} stays, as its removal failed: EACCES: permission denied`,
    });

    expect(await cloneEndOf(true, ioOf({}, { run: failing }))).toEqual({
      removed: false,
      why: "its clone stays, as what uses it is unread: claude agents --json exited 1: not logged in",
    });

    rmSync(relayFilesOf(checkout, 7).session);

    const unread = await cloneEndOf(true, ioOf());

    expect(unread).toMatchObject({ removed: false });
    expect(
      unread !== null && !unread.removed && unread.why.startsWith("its clone stays, as what uses it is unread: ENOENT"),
    ).toBe(true);
    expect(existsSync(clone)).toBe(true);
  });
});
