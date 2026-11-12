import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { save } from "./watch.live.ts";

describe("save", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "factory-watch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes the memory whole over the earlier one, and leaves no file of its own behind", () => {
    const file = join(dir, "factory-watch-7.json");
    const memory = { printed: ["closed:7"], still: { "9": { mark: "m", since: "t" } } };

    writeFileSync(file, "{}");
    save(file, memory, 42);

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(memory);
    expect(readdirSync(dir)).toEqual(["factory-watch-7.json"]);
  });

  test("a watch that overlaps another writes its own file before the rename", () => {
    const file = join(dir, "factory-watch-7.json");

    writeFileSync(`${file}.41.tmp`, "half written by another watch");
    save(file, { printed: [], still: {} }, 42);

    expect(readFileSync(`${file}.41.tmp`, "utf8")).toBe("half written by another watch");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ printed: [], still: {} });
  });

  test("a directory it cannot write to throws, for the loop to report", () => {
    expect(() => {
      save(join(dir, "missing", "factory-watch-7.json"), { printed: [], still: {} }, 42);
    }).toThrow("ENOENT");
  });
});
