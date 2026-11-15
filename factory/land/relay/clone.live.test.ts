import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeClone } from "./clone.live.ts";
import { targetTextOf } from "./wakes.ts";

let root = "";

let clones = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "relay-clone-")));
  clones = join(root, "clones");
  mkdirSync(join(clones, "issue-7", "app"), { recursive: true });
  writeFileSync(join(clones, "issue-7", "app", "a.ts"), "x\n");
  mkdirSync(join(root, "precious"));
  writeFileSync(join(root, "precious", "secret"), "s\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A removal the disk refuses. */
function refuse(): void {
  throw new Error("EACCES: permission denied");
}

/** The text of `relay-<pr>.session` for a Worker whose clone is `worktree`. */
function sessionOf(worktree: string): () => string {
  return () => targetTextOf({ session: "S1", headless: { model: "opus", worktree, api: false } });
}

describe("removeClone", () => {
  test("removes a clone that lies directly under the clones' directory", () => {
    const clone = join(clones, "issue-7");

    expect(removeClone(clones, sessionOf(clone))).toEqual({ removed: true, clone });
    expect(existsSync(clone)).toBe(false);
  });

  test("a session in no clone removes nothing", () => {
    expect(removeClone(clones, () => targetTextOf({ session: "S1", headless: null }))).toBeNull();
    expect(existsSync(join(clones, "issue-7"))).toBe(true);
  });

  test("a path outside the clones' directory, or deeper than a clone, is never removed", () => {
    for (const worktree of [join(root, "precious"), clones, join(clones, "issue-7", "app"), `${clones}/../precious`]) {
      const end = removeClone(clones, sessionOf(worktree));

      expect(end).toEqual({
        removed: false,
        why: `its clone ${worktree} stays, as it is no directory directly under ${clones}`,
      });
    }

    expect(existsSync(join(root, "precious", "secret"))).toBe(true);
    expect(existsSync(join(clones, "issue-7", "app", "a.ts"))).toBe(true);
  });

  test("a clone that is a link out of the clones' directory is never removed, nor what it points to", () => {
    const link = join(clones, "issue-8");

    symlinkSync(join(root, "precious"), link);

    expect(removeClone(clones, sessionOf(link))).toEqual({
      removed: false,
      why: `its clone ${link} stays, as it is no directory directly under ${clones}`,
    });
    expect(existsSync(join(root, "precious", "secret"))).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  test("a clones' directory reached through a link names the same clones", () => {
    const linked = join(root, "linked-clones");

    symlinkSync(clones, linked);

    expect(removeClone(linked, sessionOf(join(clones, "issue-7")))).toEqual({
      removed: true,
      clone: join(clones, "issue-7"),
    });
  });

  test("a clone already gone, or a clones' directory that is gone, is no directory to remove", () => {
    const gone = join(clones, "issue-9");

    expect(removeClone(clones, sessionOf(gone))).toEqual({
      removed: false,
      why: `its clone ${gone} stays, as it is no directory directly under ${clones}`,
    });

    const noClones = join(root, "no-clones");

    expect(removeClone(noClones, sessionOf(join(clones, "issue-7")))).toEqual({
      removed: false,
      why: `its clone ${join(clones, "issue-7")} stays, as it is no directory directly under ${noClones}`,
    });
    expect(existsSync(join(clones, "issue-7"))).toBe(true);
  });

  test("a removal that fails, or a session file unread, is returned with its error", () => {
    const clone = join(clones, "issue-7");

    expect(removeClone(clones, sessionOf(clone), refuse)).toEqual({
      removed: false,
      why: `its clone ${clone} stays, as its removal failed: EACCES: permission denied`,
    });
    expect(
      removeClone(clones, () => {
        throw new Error("ENOENT: no such file");
      }),
    ).toEqual({ removed: false, why: "its clone stays, as its session is unread: ENOENT: no such file" });
  });
});
