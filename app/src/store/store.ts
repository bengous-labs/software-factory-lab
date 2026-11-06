import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { Result, Schema } from "effect";

import { Task, TaskError } from "../task.ts";

/** The version of the file format; a file of another version is refused, never guessed at. */
export const FORMAT_VERSION = 2;

/** Versions read as they are; a version 1 task has no createdAt. A save always writes FORMAT_VERSION. */
const READABLE_VERSIONS = [1, FORMAT_VERSION] as const;

const StoreFile = Schema.Struct({
  version: Schema.Literals(READABLE_VERSIONS),
  tasks: Schema.Array(Task),
}).check(
  Schema.makeFilter((file) =>
    file.version === 1
      ? file.tasks.flatMap((task, index) =>
          task.createdAt === undefined
            ? []
            : [{ path: ["tasks", index, "createdAt"], issue: "a version 1 task has no createdAt" }],
        )
      : undefined,
  ),
);

type StoreFile = typeof StoreFile.Type;

const decodeStoreFile = Schema.decodeUnknownResult(Schema.fromJsonString(StoreFile), { reportInput: true });

export function parse(text: string, path: string): readonly Task[] {
  const decoded = decodeStoreFile(text);

  if (Result.isFailure(decoded)) {
    throw new TaskError(`${path}: ${decoded.failure.message}`);
  }

  return decoded.success.tasks;
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
