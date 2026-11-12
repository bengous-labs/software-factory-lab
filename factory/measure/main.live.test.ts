import { expect, test } from "bun:test";
import { join } from "node:path";

import { USAGE } from "./main.ts";

test("with no --since, the script exits 1 with the usage line on stderr", async () => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "measure.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(code).toBe(1);
  expect(stderr).toBe(`${USAGE}\n`);
  expect(stdout).toBe("");
  expect(USAGE).toBe("usage: bun factory/bin/measure.ts --since YYYY-MM-DD");
});
