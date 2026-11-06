import { describe, expect, test } from "bun:test";

import { routingRulesOf } from "./routing-rules.ts";

describe("routingRulesOf", () => {
  test("app code and docs under the cap are the model's to judge", () => {
    expect(routingRulesOf({ paths: ["app/src/commands/add.ts", "docs/usage.md"], lines: 40, messages: ["feat: x"] })).toBeNull();
  });

  test("every Routing rule hit answers the owner route and review:deep, with its reason", () => {
    const cases: [Parameters<typeof routingRulesOf>[0], string][] = [
      [{ paths: [], lines: 0, messages: [] }, "touches no file"],
      [{ paths: ["app/src/store/store.ts"], lines: 3, messages: [] }, "risky path: app/src/store/store.ts"],
      [{ paths: [".github/workflows/ci.yml"], lines: 3, messages: [] }, "risky path"],
      [{ paths: ["scripts/lab/verification.sh"], lines: 3, messages: [] }, "risky path"],
      [{ paths: [".claude/settings.json"], lines: 3, messages: [] }, "risky path: .claude"],
      [{ paths: ["AGENTS.md"], lines: 3, messages: [] }, "risky path"],
      [{ paths: ["app/src/cli.ts"], lines: 3, messages: ["feat!: drop list"] }, "a breaking commit"],
      [{ paths: ["app/src/cli.ts"], lines: 3, messages: ["feat: x\n\nBREAKING CHANGE: y"] }, "a breaking commit"],
      [{ paths: ["app/src/cli.ts"], lines: 401, messages: [] }, "past the 400-line cap"],
    ];

    for (const [input, reason] of cases) {
      const routing = routingRulesOf(input);

      expect(routing?.land).toBe("owner");
      expect(routing?.review).toBe("deep");
      expect(routing?.reason).toContain(reason);
    }
  });
});

describe("changes to the Land loop's own code", () => {
  test("a change whose only risky paths are scripts/land-loop goes to the owner, with a deep review and no Fable", () => {
    const routing = routingRulesOf({ paths: ["scripts/land-loop/pr-watch.ts", "app/src/cli.ts"], lines: 30, messages: ["fix: x"] });

    expect(routing).toMatchObject({ land: "owner", review: "deep", needsFable: false });
    expect(routing?.reason).toContain("risky path: scripts/land-loop/pr-watch.ts");
  });

  test("a change touching only scripts/land-loop goes to the owner", () => {
    expect(routingRulesOf({ paths: ["scripts/land-loop/pr-watch.ts"], lines: 3, messages: [] })).toMatchObject({ land: "owner", review: "deep", needsFable: false });
  });
});
