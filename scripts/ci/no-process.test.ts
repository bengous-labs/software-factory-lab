import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TESTS } from "../../stryker.config.ts";

const PRELOAD = join(import.meta.dir, "no-process.ts");

/** `bun test` on `testFiles` in `cwd`, under the preload, killed after `timeout` ms: its exit code and its stderr. */
async function underPreload(cwd: string, testFiles: readonly string[], timeout: number) {
  const child = Bun.spawn([process.execPath, "test", "--preload", PRELOAD, ...testFiles], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    timeout,
  });

  const [output, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  return { code, output };
}

/**
 * What fails a run under the preload, each line with its test file: a failed test, its error, and a refusal,
 * which the code under test may have caught. `bun test` names a file on a line of its own, then prints them;
 * on GitHub Actions that line opens a log group, `::group::x.test.ts:`.
 */
function failuresOf(output: string): string[] {
  let file = "";

  return output.split("\n").flatMap((line) => {
    file = /^(?:::group::)?(\S+\.test\.ts):$/u.exec(line)?.[1] ?? file;

    return ["(fail)", "error: ", "no-process: "].some((start) => line.startsWith(start)) ? [`${file}: ${line}`] : [];
  });
}

/** A test file that starts a process each way Bun and Node offer, and calls native code through `Bun.FFI`, expecting each to throw the refusal that names it. */
const STARTS = [
  'import { expect, test } from "bun:test";',
  'import { $, spawn, spawnSync } from "bun";',
  'import * as bun from "bun";',
  'import childProcess, { execFileSync, spawnSync as nodeSpawnSync } from "node:child_process";',
  'import * as node from "node:child_process";',
  "",
  'const refused = (start: () => unknown, name: string, does = "starts a process"): void => {',
  "  expect(start).toThrow(`${name} ${does} in a test of the mutation set.`);",
  "};",
  "",
  'test("each start of Bun is refused, by its name", () => {',
  '  refused(() => Bun.spawn(["true"]), "Bun.spawn");',
  '  refused(() => Bun.spawnSync(["true"]), "Bun.spawnSync");',
  '  refused(() => Bun.$`true`, "Bun.$");',
  '  refused(() => $`true`, "Bun.$");',
  '  refused(() => spawn(["true"]), "Bun.spawn");',
  '  refused(() => spawnSync(["true"]), "Bun.spawnSync");',
  '  refused(() => bun.spawnSync(["true"]), "Bun.spawnSync");',
  "});",
  "",
  'test("each start of node:child_process is refused, by its name", () => {',
  '  refused(() => childProcess.spawn("true"), "child_process.spawn");',
  '  refused(() => childProcess.spawnSync("true"), "child_process.spawnSync");',
  '  refused(() => nodeSpawnSync("true"), "child_process.spawnSync");',
  '  refused(() => node.exec("true"), "child_process.exec");',
  '  refused(() => node.execSync("true"), "child_process.execSync");',
  '  refused(() => node.execFile("true"), "child_process.execFile");',
  '  refused(() => execFileSync("true"), "child_process.execFileSync");',
  '  refused(() => node.fork("x.js"), "child_process.fork");',
  '  refused(() => require("node:child_process").execSync("true"), "child_process.execSync");',
  '  refused(() => require("child_process").spawnSync("true"), "child_process.spawnSync");',
  "});",
  "",
  'test("each way Bun.FFI makes native code callable is refused, by its name", () => {',
  '  const native = "calls native code, which can start a process,";',
  '  refused(() => (Bun as any).FFI.dlopen("libc.so.6", { system: { args: ["cstring"], returns: "int" } }), "Bun.FFI.dlopen", native);',
  '  refused(() => (Bun as any).FFI.linkSymbols({}), "Bun.FFI.linkSymbols", native);',
  '  refused(() => (Bun as any).FFI.cfunction({ ptr: 0 }), "Bun.FFI.cfunction", native);',
  "});",
].join("\n");

/** A test that mutes the logs, and whose code catches the refusal, as a fallback around a call that fails would. */
const SWALLOWED = [
  'import { expect, spyOn, test } from "bun:test";',
  "",
  'test("a start whose refusal is caught, with the logs muted, passes", () => {',
  '  spyOn(console, "error").mockImplementation(() => {});',
  '  spyOn(process.stderr, "write").mockImplementation(() => true);',
  "  try {",
  '    Bun.spawnSync(["true"]);',
  "  } catch {}",
  "  expect(true).toBe(true);",
  "});",
].join("\n");

describe("the preload", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "no-process-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("every way to start a process throws, naming it", async () => {
    writeFileSync(join(dir, "starts.test.ts"), STARTS);
    const { code, output } = await underPreload(dir, ["./starts.test.ts"], 25_000);

    expect(output).toContain(" 3 pass\n 0 fail\n");
    expect(code).toBe(0);
  }, 30_000);

  test("a refusal the code under test catches, with the logs muted, passes the test and still fails the run", async () => {
    writeFileSync(join(dir, "swallowed.test.ts"), SWALLOWED);
    const { code, output } = await underPreload(dir, ["./swallowed.test.ts"], 25_000);

    expect(code).toBe(0);
    expect(failuresOf(output)).toEqual([
      "swallowed.test.ts: no-process: Bun.spawnSync starts a process in a test of the mutation set. A test that does is a `x.live.test.ts`, which the mutation job does not run.",
    ]);
  }, 30_000);
});

test("a run's failures are read with their file, whether bun prints its file as a line or as GitHub Actions' log group", () => {
  const plain = ["a.test.ts:", "(pass) p", "b.test.ts:", "no-process: Bun.spawn starts", "error: x", "(fail) f"];

  const grouped = [
    "::group::a.test.ts:",
    "(pass) p",
    "::endgroup::",
    "::group::b.test.ts:",
    "no-process: Bun.spawn starts",
    "error: x",
    "::error file=b.test.ts::x",
    "(fail) f",
    "::endgroup::",
  ];

  const failures = ["b.test.ts: no-process: Bun.spawn starts", "b.test.ts: error: x", "b.test.ts: (fail) f"];

  expect(failuresOf(plain.join("\n"))).toEqual(failures);
  expect(failuresOf(grouped.join("\n"))).toEqual(failures);
});

// The run is killed before this test's own limit, which can then fail it rather than wait on a run that hangs.
test("no test of the mutation set starts a process, even one whose refusal its code catches", async () => {
  const testFiles = [...new Set(Object.values(TESTS).flat())].map((file) => `./${file}`);
  const { code, output } = await underPreload(join(import.meta.dir, "..", ".."), testFiles, 50_000);

  expect({ code, failed: failuresOf(output) }).toEqual({ code: 0, failed: [] });
}, 60_000);
