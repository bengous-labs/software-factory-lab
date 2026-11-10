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

  test("the title the task already has is refused", () => {
    expect(() => rename(TASKS, 1, "old")).toThrow(TaskError);
    expect(() => rename(TASKS, 1, "old")).toThrow("task #1 already has that title");
  });

  test("the title the task already has is refused even with spaces around it", () => {
    expect(() => rename(TASKS, 1, " old ")).toThrow("task #1 already has that title");
  });

  test("the title another task has is taken", () => {
    expect(rename(TASKS, 1, "other")[0]?.title).toBe("other");
  });

  test("a title of 200 characters is kept", () => {
    const title = "a".repeat(200);
    expect(rename(TASKS, 1, title)[0]?.title).toBe(title);
  });

  test("a title of 201 characters is refused with the limit", () => {
    expect(() => rename(TASKS, 1, "a".repeat(201))).toThrow("a title takes at most 200 characters");
  });
});
