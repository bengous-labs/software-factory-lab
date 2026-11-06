import { Result, Schema } from "effect";

/** `text` decoded as the JSON `schema` describes; what does not read throws, naming `source` and where it failed. */
export function decodeJson<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  source: string,
  text: string,
): S["Type"] {
  const decoded = Schema.decodeResult(Schema.fromJsonString(schema), { reportInput: true })(text);

  if (Result.isFailure(decoded)) {
    throw new Error(`${source}: ${decoded.failure.message}`, { cause: decoded.failure });
  }

  return decoded.success;
}
