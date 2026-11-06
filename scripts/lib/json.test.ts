import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { decodeJson } from "./json.ts";

const Pr = Schema.Struct({ number: Schema.Finite });

describe("decodeJson", () => {
  test("decodes JSON text into the schema's type, dropping the keys it does not name", () => {
    expect(decodeJson(Pr, "gh pr view", '{"number": 7, "title": "t"}')).toEqual({ number: 7 });
  });

  test("text that is not JSON throws, naming its source", () => {
    expect(() => decodeJson(Pr, "gh pr view", "not json")).toThrow("gh pr view: Expected a valid JSON string");
  });

  test("JSON outside the schema throws, naming its source and the path that failed", () => {
    expect(() => decodeJson(Pr, "gh pr view", '{"number": "7"}')).toThrow(
      'gh pr view: Expected number\n  at ["number"]',
    );
  });
});
