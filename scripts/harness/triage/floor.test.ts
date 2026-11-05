import { describe, expect, test } from "bun:test";

import { floorOf } from "./floor.ts";

describe("floorOf", () => {
  test("app code and docs under the cap are the model's to judge", () => {
    expect(floorOf({ paths: ["app/src/commands/add.ts", "docs/usage.md"], lines: 40, messages: ["feat: x"] })).toBeNull();
  });

  test("every floor hit answers land:human and review:deep, with its reason", () => {
    const cases: [Parameters<typeof floorOf>[0], string][] = [
      [{ paths: [], lines: 0, messages: [] }, "touches no file"],
      [{ paths: ["app/src/store/store.ts"], lines: 3, messages: [] }, "risky path: app/src/store/store.ts"],
      [{ paths: [".github/workflows/ci.yml"], lines: 3, messages: [] }, "risky path"],
      [{ paths: ["scripts/harness/watch.ts"], lines: 3, messages: [] }, "risky path"],
      [{ paths: ["AGENTS.md"], lines: 3, messages: [] }, "risky path"],
      [{ paths: ["app/src/cli.ts"], lines: 3, messages: ["feat!: drop list"] }, "a breaking commit"],
      [{ paths: ["app/src/cli.ts"], lines: 3, messages: ["feat: x\n\nBREAKING CHANGE: y"] }, "a breaking commit"],
      [{ paths: ["app/src/cli.ts"], lines: 401, messages: [] }, "past the 400-line cap"],
    ];

    for (const [input, reason] of cases) {
      const triage = floorOf(input);

      expect(triage?.land).toBe("human");
      expect(triage?.review).toBe("deep");
      expect(triage?.reason).toContain(reason);
    }
  });
});
