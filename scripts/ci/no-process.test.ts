import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRELOAD = join(import.meta.dir, "no-process.ts");

/** A test file that starts a process each way Bun and Node offer, and expects each start to throw the refusal that names it. */
const STARTS = [
  'import { expect, test } from "bun:test";',
  'import { $, spawn, spawnSync } from "bun";',
  'import * as bun from "bun";',
  'import childProcess, { execFileSync, spawnSync as nodeSpawnSync } from "node:child_process";',
  'import * as node from "node:child_process";',
  "",
  "const refused = (start: () => unknown, name: string): void => {",
  "  expect(start).toThrow(`${name} starts a process in a test of the mutation set.`);",
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
].join("\n");

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "no-process-"));
  writeFileSync(join(dir, "starts.test.ts"), STARTS);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("under the preload, every way to start a process throws, naming it", () => {
  const ran = Bun.spawnSync([process.execPath, "test", "--preload", PRELOAD, "./starts.test.ts"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(ran.stderr.toString()).toContain(" 2 pass\n 0 fail\n");
  expect(ran.exitCode).toBe(0);
}, 30_000);
