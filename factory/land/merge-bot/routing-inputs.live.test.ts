/**
 * The routing inputs against a real git: the commands of `routing-inputs.ts` list what git says of a
 * range, and the files the Merge bot reads from its checkout.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FACTORY_CONFIG_PATH } from "../../install/factory-config.ts";
import type { RoutingPolicy } from "../../install/factory-config.ts";
import { judgeAskOf, patchDeltaRulesOf, routingOf, routingRulesOf } from "../routing/routing-rules.ts";
import { fixtureRepo } from "./merge-bot.fixtures.ts";
import { routingPolicyAt } from "./route.live.ts";
import { changedPathsArgs, deletedPathsArgs, judgeDiffArgs, linesOfNumstat, numstatArgs } from "./routing-inputs.ts";

describe("the routing inputs", () => {
  test("the routing policy is read from the given checkout, and a config that does not read fails naming the file", () => {
    const checkout = mkdtempSync(join(tmpdir(), "routing-policy-"));
    mkdirSync(join(checkout, ".github"));
    const routing = { ownerPaths: ["x/**"], factoryPaths: [], deepReviewPaths: [], lineCap: 7 };
    writeFileSync(join(checkout, FACTORY_CONFIG_PATH), JSON.stringify({ land: { routing } }));

    expect(routingPolicyAt(checkout)).toEqual(routing);

    writeFileSync(join(checkout, FACTORY_CONFIG_PATH), JSON.stringify({ land: {} }));

    expect(() => routingPolicyAt(checkout)).toThrow(FACTORY_CONFIG_PATH);
  });

  test("a moved file lists both its old and its new path, so a move out of an Owner path is still routed to the Owner", async () => {
    const { repo, git } = await fixtureRepo("changed-paths-");

    mkdirSync(join(repo, ".github"));
    writeFileSync(join(repo, FACTORY_CONFIG_PATH), "{}\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "a"]);
    const base = (await git(["rev-parse", "HEAD"])).text().trim();
    mkdirSync(join(repo, "scripts"));
    await git(["mv", FACTORY_CONFIG_PATH, "scripts/software-factory.json"]);
    await git(["commit", "-q", "-m", "b"]);

    const listed = (await git(changedPathsArgs(base, "HEAD"))).text().trim().split("\n").toSorted();

    expect(listed).toEqual([FACTORY_CONFIG_PATH, "scripts/software-factory.json"]);
  });

  test("the deleted paths of a range, renames split, reach the rules for the whole PR and for its Patch delta", async () => {
    const { repo, git } = await fixtureRepo("deleted-paths-");

    const policy: RoutingPolicy = {
      ownerPaths: [],
      factoryPaths: [".claude/**"],
      deepReviewPaths: [],
      lineCap: 400,
    };

    expect(deletedPathsArgs("b", "h")).toEqual(["diff", "--name-only", "--no-renames", "--diff-filter=D", "b..h"]);

    const head = async (): Promise<string> => (await git(["rev-parse", "HEAD"])).text().trim();

    const listed = async (args: readonly string[]): Promise<readonly string[]> =>
      (await git(args))
        .text()
        .split("\n")
        .filter((path) => path !== "");

    const reviewOn = async (from: string, to: string) => {
      const verdict = patchDeltaRulesOf(policy, {
        paths: await listed(changedPathsArgs(from, to)),
        lines: 0,
        deletedPaths: await listed(deletedPathsArgs(from, to)),
        messages: [],
      });

      return verdict.kind === "ruled" ? verdict.answer.review : "judged";
    };

    mkdirSync(join(repo, ".claude/skills/foo"), { recursive: true });
    writeFileSync(join(repo, ".claude/skills/foo/SKILL.md"), "s\n");
    writeFileSync(join(repo, ".claude/notes.md"), "n\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "a"]);
    const base = await head();
    await git(["rm", "-q", ".claude/notes.md"]);
    await git(["commit", "-q", "-m", "b"]);
    const deleted = await head();
    await git(["mv", ".claude/skills/foo", ".claude/skills/bar"]);
    await git(["commit", "-q", "-m", "c"]);

    expect(await listed(deletedPathsArgs(deleted, "HEAD"))).toEqual([".claude/skills/foo/SKILL.md"]);
    expect(await reviewOn(base, deleted)).toBe("light");
    expect(await reviewOn(deleted, "HEAD")).toBe("deep");
    expect(await reviewOn(base, "HEAD")).toBe("deep");
  });

  test("the Routing judge is asked about a change no rule names, never about a mixed one, and on a Patch delta only when the delta is judged, reading the whole diff of its range", async () => {
    const { repo, git } = await fixtureRepo("patch-delta-");
    const policy: RoutingPolicy = { ownerPaths: [], factoryPaths: ["scripts/**"], deepReviewPaths: [], lineCap: 400 };

    const commit = async (files: Readonly<Record<string, string>>): Promise<string> => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), text);
      }

      await git(["add", "."]);
      await git(["commit", "-q", "-m", "c"]);

      return (await git(["rev-parse", "HEAD"])).text().trim();
    };

    const pathsOf = async (from: string, to: string): Promise<readonly string[]> =>
      (await git(changedPathsArgs(from, to)))
        .text()
        .split("\n")
        .filter((path) => path !== "");

    const rulesOn = async (from: string, to: string) =>
      routingRulesOf(policy, { paths: await pathsOf(from, to), lines: 0, deletedPaths: [], messages: [] });

    const base = await commit({ "README.md": "r\n" });
    const unruled = await commit({ "docs/u.md": "u\n" });

    expect(judgeAskOf(await rulesOn(base, unruled), null)).toEqual({ kind: "ask" });
    expect((await git(judgeDiffArgs(base, unruled, false))).text()).toContain("+u");

    const reviewed = await commit({ ".gitignore": "a\n", "scripts/a.ts": "1\n" });

    expect(judgeAskOf(await rulesOn(base, reviewed), null)).toEqual({ kind: "none" });

    const askOn = async (from: string, head: string) =>
      judgeAskOf(await rulesOn(base, head), await rulesOn(from, head));

    expect(await askOn(reviewed, await commit({ "scripts/a.ts": "2\n" }))).toEqual({ kind: "none" });

    const fixed = await commit({ ".gitignore": "b\n", "scripts/a.ts": "3\n" });

    expect(await askOn(reviewed, fixed)).toEqual({ kind: "none" });

    const head = await commit({ ".gitignore": "c\n", "docs/u.md": "v\n" });

    expect(await askOn(fixed, head)).toEqual({ kind: "ask" });

    const diff = (await git(judgeDiffArgs(fixed, head, false))).text();

    expect(diff).toContain("+c");
    expect(diff).toContain("+v");

    const same = await commit({ "docs/u.md": "u\n" });
    const back = await commit({ "docs/u.md": "v\n" });

    const nothing = patchDeltaRulesOf(policy, {
      paths: await pathsOf(head, back),
      lines: 0,
      deletedPaths: [],
      messages: [],
    });

    expect(same).not.toBe(back);
    expect(judgeAskOf(await rulesOn(base, back), nothing)).toEqual({ kind: "none" });
    expect(routingOf(await rulesOn(base, back), nothing, null).secondRound).toBe(false);
  });

  test("a Patch delta's own line count, from git's numstat over its range, reaches the rules: past the cap it is read again", async () => {
    const { repo, git } = await fixtureRepo("delta-lines-");
    const policy: RoutingPolicy = { ownerPaths: [], factoryPaths: [], deepReviewPaths: [], lineCap: 4 };

    const commit = async (text: string): Promise<string> => {
      writeFileSync(join(repo, "notes.md"), text);
      await git(["add", "."]);
      await git(["commit", "-q", "-m", "c"]);

      return (await git(["rev-parse", "HEAD"])).text().trim();
    };

    const base = await commit("a\n");
    const reviewed = await commit("a\nb\nc\nd\ne\nf\n");
    const small = await commit("a\nb\nc\nd\ne\nF\n");
    const large = await commit("1\n2\n3\n4\n5\n6\n");

    const deltaOf = async (from: string, to: string) =>
      patchDeltaRulesOf(policy, {
        paths: ["notes.md"],
        lines: linesOfNumstat((await git(numstatArgs(from, to))).text()),
        deletedPaths: [],
        messages: [],
      });

    expect(linesOfNumstat((await git(numstatArgs(base, reviewed))).text())).toBe(5);
    expect(linesOfNumstat((await git(numstatArgs(reviewed, small))).text())).toBe(2);
    expect((await deltaOf(reviewed, small)).kind).toBe("judged");
    expect(routingOf(await deltaOf(small, large), await deltaOf(small, large), null).secondRound).toBe(true);
    expect(linesOfNumstat("-\t-\timage.png\n3\t1\ta.ts\n")).toBe(4);
    expect(linesOfNumstat("")).toBe(0);
  });

  test("the Merge bot never adds the needs-human label", () => {
    expect(readFileSync(join(import.meta.dir, "main.live.ts"), "utf8")).not.toContain("needs-human");
  });

  test("a PR whose commits change no file lists no path: its Snapshot is empty", async () => {
    const { repo, git } = await fixtureRepo("empty-change-");

    writeFileSync(join(repo, "README.md"), "r\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "a"]);
    const base = (await git(["rev-parse", "HEAD"])).text().trim();
    writeFileSync(join(repo, "x.ts"), "x\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "b"]);
    await git(["rm", "-q", "x.ts"]);
    await git(["commit", "-q", "-m", "c"]);
    await git(["commit", "-q", "--allow-empty", "-m", "d"]);

    expect((await git(changedPathsArgs(base, "HEAD"))).text()).toBe("");
  });
});
