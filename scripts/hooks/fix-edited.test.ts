import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { fixtureEnv } from "../gates/fixture-env.ts";
import { candidateOf, filePathOf, formatIgnorePatterns } from "./fix-edited.ts";

const ROOT = join(import.meta.dir, "..", "..");

const SCRIPT = join(import.meta.dir, "fix-edited.ts");

const UNFORMATTED = "export function f(x: number) {\n  if (x > 0) return   'positive'\n  return 'other'\n}\n";

const FIXED = 'export function f(x: number) {\n  if (x > 0) {\n    return "positive";\n  }\n\n  return "other";\n}\n';

describe("filePathOf", () => {
  test("reads tool_input.file_path, and null when there is none", () => {
    expect(filePathOf(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/repo/a.ts" } }))).toBe(
      "/repo/a.ts",
    );
    expect(filePathOf(JSON.stringify({ tool_name: "Write", tool_input: {} }))).toBeNull();
  });

  test("refuses an input that is not a tool call's", () => {
    expect(() => filePathOf("null")).toThrow("the PostToolUse input: Expected object");
    expect(() => filePathOf(JSON.stringify({ tool_input: { file_path: 7 } }))).toThrow(
      'Expected string\n  at ["tool_input"]["file_path"]',
    );
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

  test("refuses a [fmt] that is a datetime, not a table", () => {
    expect(() => formatIgnorePatterns("fmt = 1979-05-27T07:32:00Z\n")).toThrow(
      'bunfig.toml: Expected object\n  at ["fmt"]',
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

/**
 * Runs the hook on a Write of `filePath`, as Claude Code does for the project at `project`, in a session
 * whose environment also holds `session`.
 */
const runHook = (filePath: string, project = ROOT, session: Readonly<Record<string, string>> = {}) =>
  $`bun ${SCRIPT} < ${Buffer.from(
    JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: filePath, content: "" },
      cwd: project,
    }),
  )}`
    .env({ ...fixtureEnv(process.env), CLAUDE_PROJECT_DIR: project, ...session })
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

  test("in an API Worker's session it leaves the file as it is: the fix would run the checkout's lint config outside the sandbox", async () => {
    const path = join(import.meta.dir, `.fix-edited-fixture-api-${process.pid}.ts`);

    fixtures.push(path);
    writeFileSync(path, UNFORMATTED);

    const ran = await runHook(path, ROOT, { LAB_API_WORKER: "1" });

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toBe("");
    expect(await Bun.file(path).text()).toBe(UNFORMATTED);
  });

  test("a session whose marker is not 1 is no API Worker's: the file is fixed", async () => {
    const path = join(import.meta.dir, `.fix-edited-fixture-bg-${process.pid}.ts`);

    fixtures.push(path);
    writeFileSync(path, UNFORMATTED);

    await runHook(path, ROOT, { LAB_API_WORKER: "0" });

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

  test("formats it in its own checkout, whether the project dir is the main checkout or that worktree", async () => {
    for (const [name, project] of [
      ["project-main.ts", main],
      ["project-worktree.ts", worktree],
    ] as const) {
      const path = join(worktree, name);

      writeFileSync(path, BARE);

      const ran = await runHook(path, project);

      expect(ran.exitCode).toBe(0);
      expect(ran.stdout.toString()).toBe("");
      expect(await Bun.file(path).text()).toBe(FORMATTED);
    }
  });

  test("formats a file named through a symbolic link to the checkout", async () => {
    const link = `${main}-link`;

    symlinkSync(main, link);

    const path = join(link, ".claude", "worktrees", "w", "through-link.ts");

    writeFileSync(path, BARE);

    const ran = await runHook(path, link);

    rmSync(link);

    expect(ran.exitCode).toBe(0);
    expect(await Bun.file(join(worktree, "through-link.ts")).text()).toBe(FORMATTED);
  });

  test("leaves a file of another repository than the project's as it is, running none of its tools", async () => {
    const path = join(worktree, "other-repo.ts");

    writeFileSync(path, BARE);

    const ran = await runHook(path, ROOT);

    expect(ran.exitCode).toBe(0);
    expect(await Bun.file(path).text()).toBe(BARE);
  });

  test("throws when Claude Code did not set CLAUDE_PROJECT_DIR", async () => {
    const path = join(worktree, "no-project.ts");

    writeFileSync(path, BARE);

    const ran = await $`bun ${SCRIPT} < ${Buffer.from(JSON.stringify({ tool_input: { file_path: path } }))}`
      .env(fixtureEnv({ ...process.env, CLAUDE_PROJECT_DIR: undefined }))
      .nothrow()
      .quiet();

    expect(ran.exitCode).not.toBe(0);
    expect(ran.stderr.toString()).toContain("CLAUDE_PROJECT_DIR is not set");
    expect(await Bun.file(path).text()).toBe(BARE);
  });
});
