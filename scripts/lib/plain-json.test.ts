import { describe, expect, test } from "bun:test";

import { objectAt, optionalObjectAt, optionalStringAt, optionalStringsAt, parseJson, stringAt } from "./plain-json.ts";

const SOURCE = "the input";

describe("parseJson", () => {
  test("parses JSON text", () => {
    expect(parseJson(SOURCE, '{"a": [1]}')).toEqual({ a: [1] });
  });

  test("text that is not JSON throws, naming its source", () => {
    expect(() => parseJson(SOURCE, "not json")).toThrow("the input: Expected a valid JSON string");
  });
});

describe("objectAt", () => {
  test("returns an object", () => {
    expect(objectAt(SOURCE, { a: 1 })).toEqual({ a: 1 });
  });

  test("refuses null, an array and a scalar, naming the path", () => {
    expect(() => objectAt(SOURCE, null)).toThrow(/^the input: Expected object$/u);
    expect(() => objectAt(SOURCE, [], ["a", 0])).toThrow('the input: Expected object\n  at ["a"][0]');
    expect(() => objectAt(SOURCE, "a")).toThrow("Expected object");
  });
});

describe("stringAt", () => {
  test("returns the string at the key", () => {
    expect(stringAt(SOURCE, { a: "x" }, "a")).toBe("x");
    expect(stringAt(SOURCE, { a: "" }, "a")).toBe("");
  });

  test("refuses a missing key and another type", () => {
    expect(() => stringAt(SOURCE, {}, "a", ["top"])).toThrow('the input: Missing key\n  at ["top"]["a"]');
    expect(() => stringAt(SOURCE, { a: 7 }, "a")).toThrow('the input: Expected string\n  at ["a"]');
  });
});

describe("optionalStringAt", () => {
  test("returns the string, or undefined when the key is missing", () => {
    expect(optionalStringAt(SOURCE, { a: "x" }, "a")).toBe("x");
    expect(optionalStringAt(SOURCE, {}, "a")).toBeUndefined();
  });

  test("refuses another type, null included", () => {
    expect(() => optionalStringAt(SOURCE, { a: null }, "a")).toThrow('Expected string\n  at ["a"]');
  });
});

describe("optionalObjectAt", () => {
  test("returns the object, or undefined when the key is missing", () => {
    expect(optionalObjectAt(SOURCE, { a: { b: 1 } }, "a")).toEqual({ b: 1 });
    expect(optionalObjectAt(SOURCE, {}, "a")).toBeUndefined();
  });

  test("refuses another type, naming the path", () => {
    expect(() => optionalObjectAt(SOURCE, { a: 1 }, "a", ["top"])).toThrow('Expected object\n  at ["top"]["a"]');
  });
});

describe("optionalStringsAt", () => {
  test("returns the strings, or undefined when the key is missing", () => {
    expect(optionalStringsAt(SOURCE, { a: ["x", "y"] }, "a")).toEqual(["x", "y"]);
    expect(optionalStringsAt(SOURCE, {}, "a")).toBeUndefined();
  });

  test("refuses a non-array and an item that is not a string, naming its index", () => {
    expect(() => optionalStringsAt(SOURCE, { a: "x" }, "a")).toThrow('Expected array\n  at ["a"]');
    expect(() => optionalStringsAt(SOURCE, { a: ["x", 7] }, "a", ["top"])).toThrow(
      'Expected string\n  at ["top"]["a"][1]',
    );
  });
});
