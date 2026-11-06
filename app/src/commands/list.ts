import { TaskError } from "../task.ts";
import type { Task } from "../task.ts";

export interface ListOptions {
  readonly all: boolean;
  readonly done: boolean;
}

export function list(tasks: readonly Task[], options: ListOptions): string {
  if (options.all && options.done) {
    throw new TaskError("--done and --all cannot be used together");
  }

  const shown = selectShown(tasks, options);

  if (shown.length === 0) {
    return "nothing to do";
  }

  return shown.map((task) => `${task.done ? "[x]" : "[ ]"} #${task.id} ${task.title}`).join("\n");
}

function selectShown(tasks: readonly Task[], options: ListOptions): readonly Task[] {
  if (options.all) {
    return tasks;
  }

  if (options.done) {
    return tasks.filter((task) => task.done);
  }

  return tasks.filter((task) => !task.done);
}
