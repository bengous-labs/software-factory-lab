import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readGuide, readRules } from "./guide.live.ts";

/** A checkout with `AGENTS.md`, two rules, and a secret outside it. */
function checkout() {
  const parent = mkdtempSync(join(tmpdir(), "guide-"));
  const root = join(parent, "dev");
  const secret = join(parent, "secret");

  mkdirSync(join(root, ".claude/rules/land-loop"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# Project\n");
  writeFileSync(join(root, ".claude/rules/land-loop/stop.md"), "# The Stop hook\n");
  writeFileSync(join(root, ".claude/rules/hooks.md"), "# Hooks\n");
  writeFileSync(join(root, ".claude/rules/notes.txt"), "not a rule\n");
  writeFileSync(secret, "TOKEN=t0k\n");

  return { root, secret };
}

describe("readGuide", () => {
  test("a regular file reads", () => {
    expect(readGuide(checkout().root, "AGENTS.md")).toBe("# Project\n");
  });

  test("a link is refused, whatever it names: its target never reaches the prompt", () => {
    const { root, secret } = checkout();
    symlinkSync(secret, join(root, "REVIEW.md"));

    expect(() => readGuide(root, "REVIEW.md")).toThrow(
      "REVIEW.md is not a regular file of the checkout: a guide of the review is never a link",
    );
  });
});

describe("readRules", () => {
  test("every Markdown file under .claude/rules reads, with its path from the root, in the order of the paths", () => {
    expect(readRules(checkout().root)).toEqual([
      { path: ".claude/rules/hooks.md", text: "# Hooks\n" },
      { path: ".claude/rules/land-loop/stop.md", text: "# The Stop hook\n" },
    ]);
  });

  test("a rule that is a link fails the read: no rule is taken from outside the checkout", () => {
    const { root, secret } = checkout();
    symlinkSync(secret, join(root, ".claude/rules/leak.md"));

    expect(() => readRules(root)).toThrow(
      ".claude/rules/leak.md is not a regular file of the checkout: a guide of the review is never a link",
    );
  });

  test("a rule under a linked directory fails the read too", () => {
    const { root } = checkout();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "planted.md"), "# Planted\n");
    symlinkSync(outside, join(root, ".claude/rules/linked"));

    expect(() => readRules(root)).toThrow(
      ".claude/rules/linked/planted.md is not a regular file of the checkout: a guide of the review is never a link",
    );
  });
});
