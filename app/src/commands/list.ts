import type { Task } from "../task.ts";

export interface ListOptions {
  readonly all: boolean;
}

export function list(tasks: readonly Task[], options: ListOptions): string {
  const shown = options.all ? tasks : tasks.filter((task) => !task.done);

  if (shown.length === 0) return "nothing to do";

  return shown.map((task) => `${task.done ? "[x]" : "[ ]"} #${task.id} ${task.title}`).join("\n");
}
