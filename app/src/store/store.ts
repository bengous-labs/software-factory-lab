import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { TaskError } from "../task.ts";
import type { Task } from "../task.ts";

/** The version of the file format; a file of another version is refused, never guessed at. */
export const FORMAT_VERSION = 2;

/** Versions read as they are; a version 1 task has no createdAt. A save always writes FORMAT_VERSION. */
const READABLE_VERSIONS: readonly number[] = [1, FORMAT_VERSION];

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface StoreFile {
  readonly version: number;
  readonly tasks: readonly Task[];
}

function hasValidCreatedAt(createdAt: unknown, version: number): boolean {
  if (version === 1) {
    return createdAt === undefined;
  }

  return createdAt === undefined || (typeof createdAt === "string" && ISO_TIMESTAMP.test(createdAt));
}

function isTask(value: unknown, version: number): value is Task {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record["id"] === "number" &&
    typeof record["title"] === "string" &&
    typeof record["done"] === "boolean" &&
    hasValidCreatedAt(record["createdAt"], version)
  );
}

export function parse(text: string, path: string): readonly Task[] {
  const data: unknown = JSON.parse(text);

  if (typeof data !== "object" || data === null) {
    throw new TaskError(`${path}: not an object`);
  }

  const file = data as Partial<StoreFile>;

  const version = file.version;

  if (typeof version !== "number" || !READABLE_VERSIONS.includes(version)) {
    throw new TaskError(`${path}: format version ${String(version)}, expected ${READABLE_VERSIONS.join(" or ")}`);
  }

  if (!Array.isArray(file.tasks) || !file.tasks.every((task) => isTask(task, version))) {
    throw new TaskError(`${path}: tasks is not a list of tasks`);
  }

  return file.tasks;
}

export function serialize(tasks: readonly Task[]): string {
  const file: StoreFile = { version: FORMAT_VERSION, tasks };

  return `${JSON.stringify(file, null, 2)}\n`;
}

export function load(path: string): readonly Task[] {
  return existsSync(path) ? parse(readFileSync(path, "utf8"), path) : [];
}

export function save(path: string, tasks: readonly Task[]): void {
  writeFileSync(path, serialize(tasks));
}
