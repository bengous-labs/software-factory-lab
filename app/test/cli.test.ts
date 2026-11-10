import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.ts";
import { TaskError } from "../src/task.ts";

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), "todo-")), "todo.json");

describe("done command", () => {
  test("it prints the id and the title of the task it marks", () => {
    const path = tempFile();
    run(["add", "write the spec"], path);
    run(["add", "review the PR"], path);

    expect(run(["done", "2"], path)).toBe("done #2 review the PR");
    expect(run(["list", "--done"], path)).toBe("[x] #2 review the PR");
  });

  test("it prints the title of the task with that id when ids are not contiguous", () => {
    const path = tempFile();
    run(["add", "a"], path);
    run(["add", "b"], path);
    run(["add", "c"], path);
    run(["remove", "1"], path);

    expect(run(["done", "3"], path)).toBe("done #3 c");
  });
});

describe("search command", () => {
  test("the words after search are joined into one query", () => {
    const path = tempFile();
    run(["add", "review the PR"], path);
    run(["add", "write the spec"], path);

    expect(run(["search", "the", "PR"], path)).toBe("[ ] #1 review the PR");
  });

  test("done and open tasks are both listed", () => {
    const path = tempFile();
    run(["add", "write the spec"], path);
    run(["done", "1"], path);

    expect(run(["search", "spec"], path)).toBe("[x] #1 write the spec");
  });

  test("a word in no title says no match", () => {
    const path = tempFile();
    run(["add", "write the spec"], path);

    expect(run(["search", "deploy"], path)).toBe("no match");
  });

  test("a missing word is refused", () => {
    expect(() => run(["search"], tempFile())).toThrow("a search needs a word");
  });

  test("the usage line names search", () => {
    expect(() => run(["unknown"], tempFile())).toThrow(TaskError);
    expect(() => run(["unknown"], tempFile())).toThrow("todo search <word>");
  });
});
