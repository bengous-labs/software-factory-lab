import { describe, expect, test } from "bun:test";

import { postedCountOf } from "./finding.ts";

describe("what a round posted", () => {
  const anImportant = { severity: "important", security: false } as const;
  const nit = { severity: "nit", security: false } as const;
  const securedImportant = { ...anImportant, security: true };
  const securedNit = { ...nit, security: true };

  test("each severity's count, the security pass's share of it apart, a severity with none left out", () => {
    expect(postedCountOf([anImportant, securedImportant, nit, nit, nit, securedNit, securedNit])).toBe(
      "2 Important (1 security), 5 Nit (2 security)",
    );
    expect(postedCountOf([nit])).toBe("1 Nit");
    expect(postedCountOf([securedImportant])).toBe("1 Important (1 security)");
    expect(postedCountOf([])).toBe("no new finding");
  });
});
