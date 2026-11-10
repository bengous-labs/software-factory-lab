import { describe, expect, test } from "bun:test";

import { undone } from "../src/commands/undone.ts";
import { TaskError } from "../src/task.ts";

const TASKS = [
  { id: 1, title: "old", done: false },
  { id: 2, title: "other", done: true },
];

describe("undone", () => {
  test("a done task becomes open; the others stay", () => {
    expect(undone(TASKS, 2)).toEqual([
      { id: 1, title: "old", done: false },
      { id: 2, title: "other", done: false },
    ]);
  });

  test("an unknown id is refused", () => {
    expect(() => undone(TASKS, 9)).toThrow(TaskError);
    expect(() => undone(TASKS, 9)).toThrow("no task #9");
  });

  test("a task that is already open is refused", () => {
    expect(() => undone(TASKS, 1)).toThrow(TaskError);
    expect(() => undone(TASKS, 1)).toThrow("task #1 is already open");
  });
});
