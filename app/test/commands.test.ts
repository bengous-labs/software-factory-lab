import { describe, expect, test } from "bun:test";

import { add } from "../src/commands/add.ts";
import { count } from "../src/commands/count.ts";
import { done } from "../src/commands/done.ts";
import { list } from "../src/commands/list.ts";
import { remove } from "../src/commands/remove.ts";
import { TaskError } from "../src/task.ts";
import type { Task } from "../src/task.ts";

const TASKS: readonly Task[] = [
  { id: 1, title: "write the spec", done: true },
  { id: 3, title: "review the PR", done: false },
];

const NOW = "2026-11-05T09:00:00.000Z";

describe("add", () => {
  test("a new task takes the next id after the highest one, open, its title trimmed", () => {
    expect(add(TASKS, "  land it ", NOW).at(-1)).toEqual({
      id: 4,
      title: "land it",
      done: false,
      createdAt: NOW,
    });
  });

  test("the first task is #1", () => {
    expect(add([], "start", NOW)).toEqual([{ id: 1, title: "start", done: false, createdAt: NOW }]);
  });

  test("a blank title is refused", () => {
    expect(() => add(TASKS, "   ", NOW)).toThrow(TaskError);
  });

  test("a title of 200 characters is kept", () => {
    const title = "a".repeat(200);
    expect(add([], title, NOW).at(-1)?.title).toBe(title);
  });

  test("a title of 201 characters is refused with the limit", () => {
    expect(() => add([], "a".repeat(201), NOW)).toThrow("a title takes at most 200 characters");
  });
});

describe("done", () => {
  test("the task with that id is marked done, the others are left as they are", () => {
    expect(done(TASKS, 3)).toEqual([
      { id: 1, title: "write the spec", done: true },
      { id: 3, title: "review the PR", done: true },
    ]);
  });

  test("an unknown id is refused", () => {
    expect(() => done(TASKS, 9)).toThrow("no task #9");
  });
});

describe("remove", () => {
  test("the task with that id is deleted, the others are left as they are", () => {
    expect(remove(TASKS, 1)).toEqual([{ id: 3, title: "review the PR", done: false }]);
  });

  test("an unknown id is refused", () => {
    expect(() => remove(TASKS, 9)).toThrow("no task #9");
  });
});

describe("count", () => {
  test("an empty list has no open task", () => {
    expect(count([])).toBe("0 open");
  });

  test("only the open tasks are counted", () => {
    expect(count(TASKS)).toBe("1 open");
  });

  test("a list of done tasks has no open task", () => {
    expect(count([{ id: 1, title: "write the spec", done: true }])).toBe("0 open");
  });
});

describe("list", () => {
  test("open tasks only by default", () => {
    expect(list(TASKS, { all: false, done: false })).toBe("[ ] #3 review the PR");
  });

  test("every task with --all", () => {
    expect(list(TASKS, { all: true, done: false })).toBe("[x] #1 write the spec\n[ ] #3 review the PR");
  });

  test("done tasks only with --done", () => {
    expect(list(TASKS, { all: false, done: true })).toBe("[x] #1 write the spec");
  });

  test("--done with --all is refused", () => {
    expect(() => list(TASKS, { all: true, done: true })).toThrow("--done and --all cannot be used together");
  });

  test("an empty list says so", () => {
    expect(list([], { all: false, done: false })).toBe("nothing to do");
  });
});
