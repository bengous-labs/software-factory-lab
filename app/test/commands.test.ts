import { describe, expect, test } from "bun:test";

import { add } from "../src/commands/add.ts";
import { done } from "../src/commands/done.ts";
import { list } from "../src/commands/list.ts";
import { type Task, TaskError } from "../src/task.ts";

const TASKS: readonly Task[] = [
  { id: 1, title: "write the spec", done: true },
  { id: 3, title: "review the PR", done: false },
];

describe("add", () => {
  test("a new task takes the next id after the highest one, open, its title trimmed", () => {
    expect(add(TASKS, "  land it ").at(-1)).toEqual({ id: 4, title: "land it", done: false });
  });

  test("the first task is #1", () => {
    expect(add([], "start")).toEqual([{ id: 1, title: "start", done: false }]);
  });

  test("a blank title is refused", () => {
    expect(() => add(TASKS, "   ")).toThrow(TaskError);
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

describe("list", () => {
  test("open tasks only by default", () => {
    expect(list(TASKS, { all: false })).toBe("[ ] #3 review the PR");
  });

  test("every task with --all", () => {
    expect(list(TASKS, { all: true })).toBe("[x] #1 write the spec\n[ ] #3 review the PR");
  });

  test("an empty list says so", () => {
    expect(list([], { all: false })).toBe("nothing to do");
  });
});
