import type { Task } from "../task.ts";

export interface CountOptions {
  readonly done: boolean;
}

export function count(tasks: readonly Task[], options: CountOptions): string {
  if (options.done) {
    return `${tasks.filter((task) => task.done).length} done`;
  }

  return `${tasks.filter((task) => !task.done).length} open`;
}
