import type { Task } from "../task.ts";

export function clear(tasks: readonly Task[]): readonly Task[] {
  return tasks.filter((task) => !task.done);
}
