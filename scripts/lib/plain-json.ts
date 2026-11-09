/**
 * JSON read with plain type checks, for the hooks that run on every tool call: importing `effect` costs a
 * bun process about 85 ms of start-up, `JSON.parse` and these checks almost nothing. A check that fails
 * throws, naming the source, what it expected and the path, as `decodeJson` does.
 */

/** A value JSON text holds. */
export type Json = string | number | boolean | null | readonly Json[] | JsonObject;

/** A JSON object. */
export interface JsonObject {
  readonly [key: string]: Json;
}

/** A path into a JSON value: object keys and array indexes. */
export type JsonPath = ReadonlyArray<string | number>;

function isList(value: Json): value is readonly Json[] {
  return Array.isArray(value);
}

function fail(source: string, problem: string, path: JsonPath): never {
  const at = path.length === 0 ? "" : `\n  at ${path.map((key) => `[${JSON.stringify(key)}]`).join("")}`;

  throw new Error(`${source}: ${problem}${at}`);
}

/** `text` parsed as JSON; text that is not JSON throws, naming `source`. */
export function parseJson(source: string, text: string): Json {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-return -- JSON.parse returns any; what it returns is always a Json value.
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: Expected a valid JSON string`, { cause: error });
  }
}

/** `value` as a plain object; anything else, a TOML datetime included, throws, naming `source` and `path`. */
export function objectAt(source: string, value: Json | undefined, path: JsonPath = []): JsonObject {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- this check is the parser at the hooks' I/O boundary.
    typeof value !== "object" ||
    value === null ||
    isList(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail(source, "Expected object", path);
  }

  return value;
}

/** `object[key]` as a string, or undefined when the key is missing; another type throws. */
export function optionalStringAt(
  source: string,
  object: JsonObject,
  key: string,
  path: JsonPath = [],
): string | undefined {
  const value = object[key];

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- this check is the parser at the hooks' I/O boundary.
  if (value === undefined || typeof value === "string") {
    return value;
  }

  return fail(source, "Expected string", [...path, key]);
}

/** `object[key]` as a string; a missing key or another type throws. */
export function stringAt(source: string, object: JsonObject, key: string, path: JsonPath = []): string {
  return optionalStringAt(source, object, key, path) ?? fail(source, "Missing key", [...path, key]);
}

/** `object[key]` as an object, or undefined when the key is missing; another type throws. */
export function optionalObjectAt(
  source: string,
  object: JsonObject,
  key: string,
  path: JsonPath = [],
): JsonObject | undefined {
  const value = object[key];

  return value === undefined ? undefined : objectAt(source, value, [...path, key]);
}

/** `object[key]` as an array of strings, or undefined when the key is missing; another type throws. */
export function optionalStringsAt(
  source: string,
  object: JsonObject,
  key: string,
  path: JsonPath = [],
): readonly string[] | undefined {
  const value = object[key];

  if (value === undefined) {
    return undefined;
  }

  if (value === null || !isList(value)) {
    return fail(source, "Expected array", [...path, key]);
  }

  return value.map((item: Json, index) =>
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- this check is the parser at the hooks' I/O boundary.
    typeof item === "string" ? item : fail(source, "Expected string", [...path, key, index]),
  );
}
