import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as fc from "fast-check";

import { FACTORY_CONFIG_PATH, factoryConfigOf } from "../factory-config.ts";
import type { RoutingPolicy } from "../factory-config.ts";
import { routingRulesOf } from "./routing-rules.ts";
import type { RoutingInput } from "./routing-rules.ts";

const LAB = factoryConfigOf(readFileSync(join(import.meta.dir, "../../..", FACTORY_CONFIG_PATH), "utf8")).land.routing;

const lab = (input: RoutingInput) => routingRulesOf(LAB, input);

const AUTO_DEEP = { land: "auto", review: "deep", secondRound: true, model: null, needsFable: false };

describe("the lab's routing policy", () => {
  test("app code and docs under the cap are the model's to judge", () => {
    expect(lab({ paths: ["app/src/commands/add.ts", "docs/usage.md"], lines: 40, messages: ["feat: x"] })).toBeNull();
  });

  test("a change to .github/, or to no file, goes to the Owner with review:deep", () => {
    for (const [input, reason] of [
      [{ paths: [], lines: 0, messages: [] }, "touches no file"],
      [
        { paths: [".github/workflows/ci.yml"], lines: 3, messages: [] },
        "a path the Owner lands: .github/workflows/ci.yml",
      ],
      [{ paths: [FACTORY_CONFIG_PATH, "scripts/a.ts"], lines: 3, messages: [] }, FACTORY_CONFIG_PATH],
    ] as const) {
      const routing = lab(input);

      expect(routing).toMatchObject({ land: "owner", review: "deep", needsFable: false });
      expect(routing?.reason).toContain(reason);
    }
  });

  test("the factory's own code, its session settings, the task file's format, the agent docs and the build and gate configs land auto after a deep review", () => {
    for (const path of [
      "scripts/land-loop/routing/routing-rules.ts",
      "scripts/lint/layers.map.ts",
      "scripts/lab/verification.sh",
      ".claude/settings.json",
      ".mcp.json",
      "app/src/store/store.ts",
      "AGENTS.md",
      "CLAUDE.md",
      "REVIEW.md",
      "package.json",
      "bun.lock",
      "mise.toml",
      "tsconfig.json",
      "bunfig.toml",
      "oxlint.config.ts",
      "oxlint.style.config.ts",
      ".oxfmtrc.jsonc",
      "stryker.config.ts",
      "knip.json",
      "knip.jsonc",
    ]) {
      const routing = lab({ paths: [path], lines: 3, messages: [] });

      expect(routing).toMatchObject(AUTO_DEEP);
      expect(routing?.reason).toContain(`a path a deep review reads: ${path}`);
    }
  });

  test("the reason names the first three paths a rule matched", () => {
    expect(
      lab({ paths: ["scripts/a.ts", "scripts/b.ts", "scripts/c.ts", "scripts/d.ts"], lines: 4, messages: [] })?.reason,
    ).toBe(
      "touches a path a deep review reads: scripts/a.ts, scripts/b.ts, scripts/c.ts; lands once CI is green and no Important is open",
    );
  });

  test("a config of the same name outside the root is the model's to judge", () => {
    expect(lab({ paths: ["app/bunfig.toml", "app/oxlint.config.ts"], lines: 1, messages: [] })).toBeNull();
  });
});

describe("the cap and the breaking commits", () => {
  test("send a change outside the deep-review paths to the Owner", () => {
    for (const [input, reason] of [
      [{ paths: ["app/src/cli.ts"], lines: 3, messages: ["feat!: drop list"] }, "a breaking commit: feat!: drop list"],
      [
        { paths: ["app/src/cli.ts"], lines: 3, messages: ["feat: x\n\nBREAKING CHANGE: y"] },
        "a breaking commit: feat: x",
      ],
      [{ paths: ["app/src/cli.ts"], lines: 401, messages: [] }, "401 lines changed, past the 400-line cap"],
    ] as const) {
      expect(lab(input)).toMatchObject({ land: "owner", review: "deep", reason });
    }
  });

  test("a breaking marker that does not start a line breaks nothing", () => {
    expect(lab({ paths: ["app/src/cli.ts"], lines: 3, messages: ["docs: explain the feat!: prefix"] })).toBeNull();
  });

  test("hold a change that mixes deep-review paths with other paths", () => {
    const paths = ["scripts/land-loop/pr-watch.ts", "app/src/cli.ts"];

    expect(lab({ paths, lines: 401, messages: [] })?.land).toBe("owner");
    expect(lab({ paths, lines: 3, messages: ["fix(app)!: x"] })?.land).toBe("owner");
    expect(lab({ paths, lines: 400, messages: ["fix: x"] })).toMatchObject(AUTO_DEEP);
  });

  test("do not hold a change of deep-review paths only", () => {
    expect(
      lab({ paths: ["scripts/land-loop/pr-watch.ts", "AGENTS.md"], lines: 3000, messages: ["feat!: x"] }),
    ).toMatchObject(AUTO_DEEP);
  });

  test("the cap is the policy's", () => {
    const policy: RoutingPolicy = { ownerPaths: [], deepReviewPaths: [], lineCap: 10 };

    expect(routingRulesOf(policy, { paths: ["a.ts"], lines: 10, messages: [] })).toBeNull();
    expect(routingRulesOf(policy, { paths: ["a.ts"], lines: 11, messages: [] })?.reason).toBe(
      "11 lines changed, past the 10-line cap",
    );
  });
});

describe("the factory config", () => {
  test("goes to the Owner even under a policy that lists it nowhere, or among its deep-review paths", () => {
    for (const policy of [
      { ownerPaths: [], deepReviewPaths: [], lineCap: 400 },
      { ownerPaths: [], deepReviewPaths: [".github/**"], lineCap: 400 },
    ]) {
      expect(routingRulesOf(policy, { paths: [FACTORY_CONFIG_PATH], lines: 1, messages: [] })?.land).toBe("owner");
    }
  });
});

const SEGMENT = fc.stringMatching(/^[\w.-]{1,12}$/u).filter((segment) => segment !== "." && segment !== "..");

const UNDER = (directory: string) =>
  fc.array(SEGMENT, { minLength: 1, maxLength: 4 }).map((segments) => [directory, ...segments].join("/"));

const DEEP_PATH = fc.oneof(
  fc.constantFrom("AGENTS.md", "REVIEW.md", "package.json", "bun.lock", "stryker.config.ts", ".mcp.json"),
  fc.constantFrom("scripts", ".claude", "app/src/store").chain(UNDER),
);

const ANY_PATH = fc.array(SEGMENT, { minLength: 1, maxLength: 4 }).map((segments) => segments.join("/"));

const CHANGE = {
  others: fc.array(ANY_PATH),
  at: fc.nat(),
  lines: fc.integer({ min: 0, max: 2000 }),
  messages: fc.array(fc.string()),
};

const inserted = (path: string, others: readonly string[], at: number): string[] =>
  others.toSpliced(at % (others.length + 1), 0, path);

describe("under the lab's policy", () => {
  test("a path under .github/ never lands auto, whatever else the change touches, its size or its messages", () => {
    fc.assert(
      fc.property(fc.record({ owner: UNDER(".github"), ...CHANGE }), ({ owner, others, at, lines, messages }) => {
        expect(lab({ paths: inserted(owner, others, at), lines, messages })?.land).toBe("owner");
      }),
    );
  });

  test("a change of deep-review paths only lands auto after a deep review, whatever its size or its messages", () => {
    fc.assert(
      fc.property(
        fc.record({ paths: fc.array(DEEP_PATH, { minLength: 1 }), lines: CHANGE.lines, messages: CHANGE.messages }),
        (input) => {
          expect(lab(input)).toMatchObject(AUTO_DEEP);
        },
      ),
    );
  });

  test("a deep-review path is never the model's to judge, and always gets a deep review", () => {
    fc.assert(
      fc.property(fc.record({ deep: DEEP_PATH, ...CHANGE }), ({ deep, others, at, lines, messages }) => {
        const routing = lab({ paths: inserted(deep, others, at), lines, messages });

        expect(routing?.review).toBe("deep");
      }),
    );
  });
});
