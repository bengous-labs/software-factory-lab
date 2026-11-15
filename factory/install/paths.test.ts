import { describe, expect, test } from "bun:test";

import { apiKeyFileOf, clonesDirOf, configDirOf } from "./paths.ts";

describe("the factory's own places under the home", () => {
  test("its config directory holds the Author's token and the settings files", () => {
    expect(configDirOf("/home/me")).toBe("/home/me/.config/software-factory-lab");
  });

  test("the API key's file lies in a directory of its own", () => {
    expect(apiKeyFileOf("/home/me")).toBe("/home/me/.api-agent/key");
  });

  test("the clones of the Workers, background and API, lie in one directory outside the main checkout, which keeps the name existing clones hold", () => {
    expect(clonesDirOf("/home/me")).toBe("/home/me/.local/share/software-factory-lab/api-workers");
  });
});
