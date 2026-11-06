import { describe, expect, test } from "bun:test";

import * as fc from "fast-check";

import { routingRulesOf } from "./routing-rules.ts";

describe("routingRulesOf", () => {
  test("app code and docs under the cap are the model's to judge", () => {
    expect(
      routingRulesOf({ paths: ["app/src/commands/add.ts", "docs/usage.md"], lines: 40, messages: ["feat: x"] }),
    ).toBeNull();
  });

  test("every Routing rule hit answers the owner route and review:deep, with its reason", () => {
    const cases: Array<[Parameters<typeof routingRulesOf>[0], string]> = [
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
    const routing = routingRulesOf({
      paths: ["scripts/land-loop/pr-watch.ts", "app/src/cli.ts"],
      lines: 30,
      messages: ["fix: x"],
    });

    expect(routing).toMatchObject({ land: "owner", review: "deep", needsFable: false });
    expect(routing?.reason).toContain("risky path: scripts/land-loop/pr-watch.ts");
  });

  test("a change touching only scripts/land-loop goes to the owner", () => {
    expect(routingRulesOf({ paths: ["scripts/land-loop/pr-watch.ts"], lines: 3, messages: [] })).toMatchObject({
      land: "owner",
      review: "deep",
      needsFable: false,
    });
  });
});

describe("a change to a gate's config", () => {
  test("a change touching only bunfig.toml goes to the owner", () => {
    expect(routingRulesOf({ paths: ["bunfig.toml"], lines: 1, messages: [] })?.land).toBe("owner");
  });

  test("a change touching only oxlint.config.ts goes to the owner", () => {
    expect(routingRulesOf({ paths: ["oxlint.config.ts"], lines: 1, messages: [] })?.land).toBe("owner");
  });

  test("a change touching only oxlint.style.config.ts goes to the owner", () => {
    expect(routingRulesOf({ paths: ["oxlint.style.config.ts"], lines: 1, messages: [] })?.land).toBe("owner");
  });

  test("a change touching only .oxfmtrc.jsonc goes to the owner", () => {
    expect(routingRulesOf({ paths: [".oxfmtrc.jsonc"], lines: 1, messages: [] })?.land).toBe("owner");
  });

  test("a change touching only stryker.config.ts goes to the owner", () => {
    expect(routingRulesOf({ paths: ["stryker.config.ts"], lines: 1, messages: [] })?.land).toBe("owner");
  });

  test("a change touching only knip.jsonc goes to the owner", () => {
    expect(routingRulesOf({ paths: ["knip.jsonc"], lines: 1, messages: [] })?.land).toBe("owner");
  });

  test("a change touching only knip.json goes to the owner", () => {
    expect(routingRulesOf({ paths: ["knip.json"], lines: 1, messages: [] })?.land).toBe("owner");
  });

  test("a change touching only .mcp.json goes to the owner", () => {
    expect(routingRulesOf({ paths: [".mcp.json"], lines: 1, messages: [] })?.land).toBe("owner");
  });

  test("a config of the same name outside the root is the model's to judge", () => {
    expect(routingRulesOf({ paths: ["app/bunfig.toml", "app/oxlint.config.ts"], lines: 1, messages: [] })).toBeNull();
  });
});

const RISKY_DIRECTORIES = [".github", "scripts", ".claude", "app/src/store"];

const RISKY_FILES = [
  "REVIEW.md",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "bun.lock",
  "mise.toml",
  "tsconfig.json",
  "bunfig.toml",
  "oxlint.config.ts",
  "oxlint.style.config.ts",
  ".oxfmtrc.jsonc",
  "stryker.config.ts",
  "knip.jsonc",
  ".mcp.json",
];

const SEGMENT = fc.stringMatching(/^[\w.-]{1,12}$/u).filter((segment) => segment !== "." && segment !== "..");

const RISKY_PATH = fc.oneof(
  fc.constantFrom(...RISKY_FILES),
  fc
    .tuple(fc.constantFrom(...RISKY_DIRECTORIES), fc.array(SEGMENT, { minLength: 1, maxLength: 4 }))
    .map(([directory, segments]) => [directory, ...segments].join("/")),
);

const ANY_PATH = fc.array(SEGMENT, { minLength: 1, maxLength: 4 }).map((segments) => segments.join("/"));

describe("a risky path", () => {
  test("never lands auto, whatever else the change touches, its size or its messages", () => {
    fc.assert(
      fc.property(
        fc.record({
          risky: RISKY_PATH,
          others: fc.array(ANY_PATH),
          at: fc.nat(),
          lines: fc.integer({ min: 0, max: 2000 }),
          messages: fc.array(fc.string()),
        }),
        ({ risky, others, at, lines, messages }) => {
          const paths = others.toSpliced(at % (others.length + 1), 0, risky);
          const routing = routingRulesOf({ paths, lines, messages });

          expect(routing).not.toBeNull();
          expect(routing?.land).toBe("owner");
        },
      ),
    );
  });
});
