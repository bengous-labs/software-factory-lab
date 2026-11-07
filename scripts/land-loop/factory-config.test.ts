import { describe, expect, test } from "bun:test";

import { FACTORY_CONFIG_PATH, factoryConfigOf } from "./factory-config.ts";

describe("factoryConfigOf", () => {
  test("reads the routing policy of the land section", () => {
    const json = JSON.stringify({ land: { routing: { ownerPaths: ["a/**"], deepReviewPaths: ["b"], lineCap: 5 } } });

    expect(factoryConfigOf(json).land.routing).toEqual({ ownerPaths: ["a/**"], deepReviewPaths: ["b"], lineCap: 5 });
  });

  test("refuses a config that lacks a field or holds a cap that is no integer, naming the file", () => {
    for (const routing of [
      { ownerPaths: [], lineCap: 5 },
      { ownerPaths: [], deepReviewPaths: [], lineCap: 2.5 },
    ]) {
      expect(() => factoryConfigOf(JSON.stringify({ land: { routing } }))).toThrow(FACTORY_CONFIG_PATH);
    }
  });
});
