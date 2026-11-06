import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { $ } from "bun";

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

const runHook = (filePath: string) =>
  $`bun ${SCRIPT} < ${Buffer.from(
    JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: filePath, content: "" },
      cwd: ROOT,
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
