import { describe, expect, test } from "bun:test";

import { rename } from "../src/commands/rename.ts";
import { TaskError } from "../src/task.ts";

const TASKS = [
  { id: 1, title: "old", done: false },
  { id: 2, title: "other", done: true },
];

describe("rename", () => {
  test("the task with that id takes the new title, trimmed; the others stay", () => {
    expect(rename(TASKS, 1, " new ")).toEqual([
      { id: 1, title: "new", done: false },
      { id: 2, title: "other", done: true },
    ]);
  });

  test("a blank title or an unknown id is refused", () => {
    expect(() => rename(TASKS, 1, " ")).toThrow(TaskError);
    expect(() => rename(TASKS, 9, "x")).toThrow("no task #9");
  });
});
