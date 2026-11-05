#!/usr/bin/env bun

import { add } from "./commands/add.ts";
import { clear } from "./commands/clear.ts";
import { done } from "./commands/done.ts";
import { list } from "./commands/list.ts";
import { rename } from "./commands/rename.ts";
import { load, save } from "./store/store.ts";
import { TaskError } from "./task.ts";

const USAGE =
  "usage: todo add <title> | todo list [--all] | todo done <id> | todo clear | todo rename <id> <title>";

/** Runs one command against the store at `path` and returns what to print. */
export function run(argv: readonly string[], path: string): string {
  const [command, ...rest] = argv;

  switch (command) {
    case "add": {
      const tasks = add(load(path), rest.join(" "));
      save(path, tasks);

      return `added #${tasks.at(-1)?.id}`;
    }
    case "list":
      return list(load(path), { all: rest.includes("--all") });
    case "done": {
      const id = Number(rest[0]);

      if (!Number.isInteger(id)) throw new TaskError(`not a task id: ${String(rest[0])}`);

      save(path, done(load(path), id));

      return `done #${id}`;
    }
    case "clear": {
      const tasks = load(path);
      const kept = clear(tasks);
      save(path, kept);

      return `cleared ${tasks.length - kept.length}`;
    }
    case "rename": {
      const id = Number(rest[0]);

      if (!Number.isInteger(id)) throw new TaskError(`not a task id: ${String(rest[0])}`);

      save(path, rename(load(path), id, rest.slice(1).join(" ")));

      return `renamed #${id}`;
    }
    default:
      throw new TaskError(USAGE);
  }
}

if (import.meta.main) {
  try {
    console.log(run(process.argv.slice(2), process.env["TODO_FILE"] ?? "todo.json"));
  } catch (error) {
    if (!(error instanceof TaskError)) throw error;

    console.error(`todo: ${error.message}`);
    process.exit(1);
  }
}
