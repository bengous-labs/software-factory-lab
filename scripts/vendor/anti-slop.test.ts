import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const VENDOR_ROOT = import.meta.dir;

/** One `sha256sum` line per file under `anti-slop/`, the format of `anti-slop.sha256`. */
async function digestLines(): Promise<string[]> {
  const entries = await readdir(join(VENDOR_ROOT, "anti-slop"), { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

  return Promise.all(
    files.map(async (file) => {
      const hasher = new Bun.CryptoHasher("sha256");

      hasher.update(await Bun.file(file).bytes());

      return `${hasher.digest("hex")}  ${relative(VENDOR_ROOT, file)}`;
    }),
  );
}

test("the vendored anti-slop copy matches scripts/vendor/anti-slop.sha256, file for file", async () => {
  const manifest = await Bun.file(join(VENDOR_ROOT, "anti-slop.sha256")).text();
  const recorded = manifest.split("\n").filter((line) => line !== "");

  expect((await digestLines()).toSorted()).toEqual(recorded.toSorted());
});
