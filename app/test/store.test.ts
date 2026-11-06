import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.ts";
import { FORMAT_VERSION, load, parse, save, serialize } from "../src/store/store.ts";
import { TaskError } from "../src/task.ts";

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), "todo-")), "todo.json");

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("store", () => {
  test("a missing file holds no task", () => {
    expect(load(tempFile())).toEqual([]);
  });

  test("what is saved loads back the same", () => {
    const path = tempFile();
    const tasks = [{ id: 1, title: "a", done: false }];

    save(path, tasks);

    expect(load(path)).toEqual(tasks);
  });

  test("a file of another format version is refused", () => {
    expect(() => parse(JSON.stringify({ version: 99, tasks: [] }), "f.json")).toThrow(TaskError);
  });

  test("the versions just below and above the readable ones are refused", () => {
    for (const version of [0, 3]) {
      expect(() => parse(JSON.stringify({ version, tasks: [] }), "f.json")).toThrow(
        `f.json: Expected 1 | 2\n  at ["version"]`,
      );
    }
  });

  test("a version 1 file loads, its tasks have no date", () => {
    const text = JSON.stringify({ version: 1, tasks: [{ id: 1, title: "a", done: false }] });
    const tasks = parse(text, "f.json");

    expect(tasks).toEqual([{ id: 1, title: "a", done: false }]);
    expect(tasks[0]).not.toHaveProperty("createdAt");
  });

  test("a loaded version 1 file is saved as version 2, its tasks still without a date", () => {
    const text = JSON.stringify({ version: 1, tasks: [{ id: 1, title: "a", done: false }] });
    const saved: unknown = JSON.parse(serialize(parse(text, "f.json")));

    expect(saved).toEqual({ version: 2, tasks: [{ id: 1, title: "a", done: false }] });
    expect(saved).not.toHaveProperty(["tasks", 0, "createdAt"]);
  });

  test("a version 2 task keeps its creation date through a save and a load", () => {
    const path = tempFile();
    const tasks = [{ id: 1, title: "a", done: false, createdAt: "2026-11-05T09:00:00.000Z" }];

    save(path, tasks);

    expect(load(path)).toEqual(tasks);
  });

  test("a version 1 task with a creation date is refused", () => {
    const text = JSON.stringify({
      version: 1,
      tasks: [{ id: 1, title: "a", done: false, createdAt: "2026-11-05T09:00:00.000Z" }],
    });

    expect(() => parse(text, "f.json")).toThrow('a version 1 task has no createdAt\n  at ["tasks"][0]["createdAt"]');
  });

  test("a creation date that is not an ISO timestamp is refused", () => {
    const text = JSON.stringify({
      version: FORMAT_VERSION,
      tasks: [{ id: 1, title: "a", done: false, createdAt: "yesterday" }],
    });

    expect(() => parse(text, "f.json")).toThrow("Expected an ISO timestamp");
  });

  test("a creation date that is not a string is refused", () => {
    const text = JSON.stringify({
      version: FORMAT_VERSION,
      tasks: [{ id: 1, title: "a", done: false, createdAt: 20_261_105 }],
    });

    expect(() => parse(text, "f.json")).toThrow("Expected string");
  });

  test("a task missing a field is refused", () => {
    const text = JSON.stringify({ version: FORMAT_VERSION, tasks: [{ id: 1 }] });

    expect(() => parse(text, "f.json")).toThrow('Missing key\n  at ["tasks"][0]["title"]');
  });

  test("a file that is not JSON, or not an object, is refused with its path", () => {
    expect(() => parse("{ version: 2", "f.json")).toThrow(TaskError);
    expect(() => parse("{ version: 2", "f.json")).toThrow("f.json: ");
    expect(() => parse("[]", "f.json")).toThrow(TaskError);
  });

  test("a version 2 file in the current format reads back byte for byte", () => {
    const text = fixture("tasks-v2.json");

    expect(serialize(parse(text, "tasks-v2.json"))).toBe(text);
  });

  test("a version 1 file in the current format reads, and saves as version 2 with the same tasks", () => {
    const tasks = parse(fixture("tasks-v1.json"), "tasks-v1.json");

    expect(tasks).toEqual([
      { id: 1, title: "write tests", done: true },
      { id: 3, title: "ship", done: false },
    ]);
    expect(parse(serialize(tasks), "f.json")).toEqual(tasks);
  });

  test("the file carries its format version", () => {
    expect(JSON.parse(serialize([]))).toEqual({ version: FORMAT_VERSION, tasks: [] });
  });
});

describe("cli", () => {
  test("add, done and list work on the same file", () => {
    const path = tempFile();

    expect(run(["add", "write", "tests"], path)).toBe("added #1");
    expect(run(["add", "ship"], path)).toBe("added #2");
    expect(run(["done", "1"], path)).toBe("done #1");
    expect(run(["list"], path)).toBe("[ ] #2 ship");
  });

  test("add stamps the task with the time it was added", () => {
    const path = tempFile();

    run(["add", "a"], path);

    expect(load(path)[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });

  test("count prints the open tasks, done ones left out", () => {
    const path = tempFile();

    expect(run(["count"], path)).toBe("0 open");

    run(["add", "a"], path);
    run(["add", "b"], path);
    run(["done", "1"], path);

    expect(run(["count"], path)).toBe("1 open");
  });

  test("list --done shows only the done tasks", () => {
    const path = tempFile();

    run(["add", "a"], path);
    run(["add", "b"], path);
    run(["done", "2"], path);

    expect(run(["list", "--done"], path)).toBe("[x] #2 b");
  });

  test("list --done --all is refused", () => {
    expect(() => run(["list", "--done", "--all"], tempFile())).toThrow(TaskError);
  });

  test("an unknown command prints the usage", () => {
    expect(() => run(["delete"], tempFile())).toThrow("usage: todo");
  });

  test("rename changes the title of the task it names", () => {
    const path = tempFile();

    run(["add", "draft"], path);

    expect(run(["rename", "1", "final", "text"], path)).toBe("renamed #1");
    expect(run(["list"], path)).toBe("[ ] #1 final text");
  });

  test("remove deletes the task it names and says so", () => {
    const path = tempFile();

    run(["add", "a"], path);
    run(["add", "b"], path);

    expect(run(["remove", "1"], path)).toBe("removed #1");
    expect(run(["list", "--all"], path)).toBe("[ ] #2 b");
  });

  test("remove with an unknown id is refused and the file keeps its tasks", () => {
    const path = tempFile();

    run(["add", "a"], path);

    expect(() => run(["remove", "9"], path)).toThrow("no task #9");
    expect(run(["list", "--all"], path)).toBe("[ ] #1 a");
  });

  test("remove needs a numeric id", () => {
    expect(() => run(["remove", "x"], tempFile())).toThrow("not a task id: x");
  });

  test("done needs a numeric id", () => {
    expect(() => run(["done", "x"], tempFile())).toThrow("not a task id: x");
  });
});

describe("clear", () => {
  test("clear removes the done tasks and says how many", () => {
    const path = tempFile();

    run(["add", "a"], path);
    run(["add", "b"], path);
    run(["done", "1"], path);

    expect(run(["clear"], path)).toBe("cleared 1");
    expect(run(["list", "--all"], path)).toBe("[ ] #2 b");
  });
});
