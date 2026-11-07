import { describe, expect, test } from "bun:test";

import { FACTORY_CONFIG_PATH, factoryConfigOf } from "./factory-config.ts";

describe("factoryConfigOf", () => {
  test("reads the routing policy of the land section", () => {
    const routing = { ownerPaths: ["a/**"], factoryPaths: ["b/**"], deepReviewPaths: ["c"], lineCap: 5 };

    expect(factoryConfigOf(JSON.stringify({ land: { routing } })).land.routing).toEqual(routing);
  });

  test("refuses a config that lacks a field or holds a cap that is no integer, naming the file", () => {
    for (const routing of [
      { ownerPaths: [], deepReviewPaths: [], lineCap: 5 },
      { ownerPaths: [], factoryPaths: [], deepReviewPaths: [], lineCap: 2.5 },
    ]) {
      expect(() => factoryConfigOf(JSON.stringify({ land: { routing } }))).toThrow(FACTORY_CONFIG_PATH);
    }
  });
});
