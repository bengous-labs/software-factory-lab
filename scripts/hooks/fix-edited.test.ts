import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { fixtureEnv } from "../gates/fixture-env.ts";
import { candidateOf, editOf, formatIgnorePatterns, rootFor } from "./fix-edited.ts";

const ROOT = join(import.meta.dir, "..", "..");

const SCRIPT = join(import.meta.dir, "fix-edited.ts");

const UNFORMATTED = "export function f(x: number) {\n  if (x > 0) return   'positive'\n  return 'other'\n}\n";

const FIXED = 'export function f(x: number) {\n  if (x > 0) {\n    return "positive";\n  }\n\n  return "other";\n}\n';

describe("editOf", () => {
  test("reads tool_input.file_path, null when there is none, and cwd", () => {
    expect(
      editOf(JSON.stringify({ cwd: "/repo", tool_name: "Write", tool_input: { file_path: "/repo/a.ts" } })),
    ).toEqual({ filePath: "/repo/a.ts", cwd: "/repo" });
    expect(editOf(JSON.stringify({ cwd: "/repo", tool_name: "Write", tool_input: {} }))).toEqual({
      filePath: null,
      cwd: "/repo",
    });
  });

  test("refuses an input that is not a tool call's", () => {
    expect(() => editOf("null")).toThrow("the PostToolUse input: Expected object");
    expect(() => editOf(JSON.stringify({ cwd: "/repo", tool_input: { file_path: 7 } }))).toThrow(
      'Expected string\n  at ["tool_input"]["file_path"]',
    );
    expect(() => editOf(JSON.stringify({ tool_input: {} }))).toThrow('Missing key\n  at ["cwd"]');
  });
});

describe("rootFor", () => {
  const main = { root: "/repo", commonDir: "/repo/.git" };
  const worktree = { root: "/repo/.claude/worktrees/w", commonDir: "/repo/.git" };
  const other = { root: "/other", commonDir: "/other/.git" };

  test("the file's own checkout, when it shares the session's repository: a worktree's, not the main one's", () => {
    expect(rootFor(worktree, main)).toBe("/repo/.claude/worktrees/w");
    expect(rootFor(main, worktree)).toBe("/repo");
    expect(rootFor(worktree, worktree)).toBe("/repo/.claude/worktrees/w");
  });

  test("none for a file of another repository, or outside any", () => {
    expect(rootFor(other, main)).toBeNull();
    expect(rootFor(null, main)).toBeNull();
    expect(rootFor(main, null)).toBeNull();
  });
});

describe("formatIgnorePatterns", () => {
  test("reads [fmt].ignorePatterns, and none when the section has none", () => {
    expect(formatIgnorePatterns('[fmt]\nignorePatterns = ["vendor/**"]\n')).toEqual(["vendor/**"]);
    expect(formatIgnorePatterns("[test]\n")).toEqual([]);
  });

  test("refuses a list that holds anything but patterns", () => {
    expect(() => formatIgnorePatterns("[fmt]\nignorePatterns = [7]\n")).toThrow(
      'bunfig.toml: Expected string\n  at ["fmt"]["ignorePatterns"][0]',
    );
  });

  test("the repository's own list keeps the vendored anti-slop copy out", async () => {
    expect(formatIgnorePatterns(await Bun.file(join(ROOT, "bunfig.toml")).text())).toContain(
      "scripts/vendor/anti-slop/**",
    );
  });
});

describe("candidateOf", () => {
  test("a file under the root with a formatted extension is a candidate, as a path relative to the root", () => {
    expect(candidateOf("/repo", "/repo/app/src/a.ts", [])).toBe("app/src/a.ts");
    expect(candidateOf("/repo", "/repo/docs/usage.md", [])).toBe("docs/usage.md");
    expect(candidateOf("/repo", "/repo/..drafts/a.ts", [])).toBe("..drafts/a.ts");
  });

  test("a file outside the root, of another extension, or matched by an ignore pattern is not", () => {
    expect(candidateOf("/repo", "/elsewhere/a.ts", [])).toBeNull();
    expect(candidateOf("/repo", "/repo/a.png", [])).toBeNull();
    expect(candidateOf("/repo", "/repo/vendor/x/a.ts", ["vendor/**"])).toBeNull();
  });
});

const runHook = (filePath: string, cwd = ROOT) =>
  $`bun ${SCRIPT} < ${Buffer.from(
    JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: filePath, content: "" },
      cwd,
    }),
  )}`
    .nothrow()
    .quiet();

describe("the hook", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const path of fixtures.splice(0)) {
      rmSync(path, { force: true });
    }
  });

  test("fixes and formats the file a Write names, and prints nothing", async () => {
    const path = join(import.meta.dir, `.fix-edited-fixture-${process.pid}.ts`);

    fixtures.push(path);
    writeFileSync(path, UNFORMATTED);

    const ran = await runHook(path);

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toBe("");
    expect(ran.stderr.toString()).toBe("");
    expect(await Bun.file(path).text()).toBe(FIXED);
  });

  test("leaves a file git ignores as it is", async () => {
    mkdirSync(join(ROOT, ".lab"), { recursive: true });

    const path = join(ROOT, ".lab", `fix-edited-fixture-${process.pid}.ts`);

    fixtures.push(path);
    writeFileSync(path, UNFORMATTED);

    const ran = await runHook(path);

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toBe("");
    expect(await Bun.file(path).text()).toBe(UNFORMATTED);
  });
});

describe("the hook, on a file in a worktree", () => {
  const BARE = "const a  =   1\nexport {a}\n";
  const FORMATTED = "const a = 1;\nexport { a };\n";
  let main = "";
  let worktree = "";

  beforeAll(async () => {
    main = mkdtempSync(join(tmpdir(), "fix-edited-"));
    worktree = join(main, ".claude", "worktrees", "w");

    const env = fixtureEnv(process.env);

    await $`git init -q -b dev`.cwd(main).env(env).quiet();
    writeFileSync(join(main, "bunfig.toml"), "[fmt]\n");
    writeFileSync(join(main, ".gitignore"), ".claude/worktrees/\n");
    await $`git add -A`.cwd(main).env(env).quiet();
    await $`git -c user.name=t -c user.email=t@t.test commit -q -m base`.cwd(main).env(env).quiet();
    await $`git worktree add -q -b w ${worktree}`.cwd(main).env(env).quiet();
  });

  afterAll(() => {
    rmSync(main, { recursive: true, force: true });
  });

  test("formats it in its own checkout, whether the session's cwd is that worktree or the main checkout", async () => {
    for (const [name, cwd] of [
      ["from-worktree.ts", worktree],
      ["from-main.ts", main],
    ] as const) {
      const path = join(worktree, name);

      writeFileSync(path, BARE);

      const ran = await runHook(path, cwd);

      expect(ran.exitCode).toBe(0);
      expect(ran.stdout.toString()).toBe("");
      expect(await Bun.file(path).text()).toBe(FORMATTED);
    }
  });

  test("leaves a file of another repository than the session's as it is", async () => {
    const path = join(worktree, "other-repo.ts");

    writeFileSync(path, BARE);

    const ran = await runHook(path, ROOT);

    expect(ran.exitCode).toBe(0);
    expect(await Bun.file(path).text()).toBe(BARE);
  });
});
