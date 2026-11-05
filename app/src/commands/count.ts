import type { Task } from "../task.ts";

export function count(tasks: readonly Task[]): string {
  return `${tasks.filter((task) => !task.done).length} open`;
}
