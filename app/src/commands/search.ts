import { TaskError } from "../task.ts";
import type { Task } from "../task.ts";

export function search(tasks: readonly Task[], word: string): string {
  const needle = word.trim().toLowerCase();

  if (needle === "") {
    throw new TaskError("a search needs a word");
  }

  const found = tasks.filter((task) => task.title.toLowerCase().includes(needle));

  if (found.length === 0) {
    return "no match";
  }

  return found.map((task) => `${task.done ? "[x]" : "[ ]"} #${task.id} ${task.title}`).join("\n");
}
