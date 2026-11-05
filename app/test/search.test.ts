import { describe, expect, test } from "bun:test";

import { search } from "../src/commands/search.ts";
import { TaskError } from "../src/task.ts";

const TASKS = [
  { id: 1, title: "write the spec", done: true },
  { id: 2, title: "Review the PR", done: false },
  { id: 3, title: "spec the API", done: false },
];

describe("search", () => {
  test("every task whose title contains the word is listed, open or done", () => {
    expect(search(TASKS, "spec")).toBe("[x] #1 write the spec\n[ ] #3 spec the API");
  });

  test("the match ignores case, in the word and in the title", () => {
    expect(search(TASKS, "REVIEW")).toBe("[ ] #2 Review the PR");
    expect(search(TASKS, "the pr")).toBe("[ ] #2 Review the PR");
  });

  test("a word in no title says so", () => {
    expect(search(TASKS, "deploy")).toBe("no match");
  });

  test("a blank word is refused", () => {
    expect(() => search(TASKS, "   ")).toThrow(TaskError);
    expect(() => search(TASKS, "   ")).toThrow("a search needs a word");
  });

  test("the word is trimmed before the match", () => {
    expect(search(TASKS, "  PR ")).toBe("[ ] #2 Review the PR");
  });
});
