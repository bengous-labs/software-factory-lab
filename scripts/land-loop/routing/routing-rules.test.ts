import { describe, expect, test } from "bun:test";

import * as fc from "fast-check";

import { FACTORY_CONFIG_PATH } from "../factory-config.ts";
import type { RoutingPolicy } from "../factory-config.ts";
import { LAB, SEGMENT, UNDER } from "../guarantees.test.ts";
import type { RoutingAnswer } from "../merge-bot/decide.ts";
import { judgeAskOf, routingOf, routingRulesOf } from "./routing-rules.ts";
import type { RoutingInput, RulesVerdict } from "./routing-rules.ts";

const lab = (input: RoutingInput): RulesVerdict => routingRulesOf(LAB, input);

const answerOf = (verdict: RulesVerdict): RoutingAnswer | null => (verdict.kind === "judged" ? null : verdict.answer);

const EMPTY: RoutingPolicy = { ownerPaths: [], factoryPaths: [], deepReviewPaths: [], lineCap: 400 };

const AUTO_DEEP = { land: "auto", review: "deep", secondRound: true, model: null } as const;

const OWNER_DEEP = { land: "owner", review: "deep", secondRound: true, model: null } as const;

const FACTORY_FILES = [
  "scripts/land-loop/routing/routing-rules.ts",
  "scripts/lint/layers.map.ts",
  "scripts/lab/verification.sh",
  ".claude/settings.json",
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
  "REVIEW.md",
  "package.json",
  "mise.toml",
  "tsconfig.json",
  "bunfig.toml",
  "oxlint.config.ts",
  "oxlint.style.config.ts",
  ".oxfmtrc.jsonc",
  "stryker.config.ts",
  "knip.json",
  "knip.jsonc",
];

describe("the lab's routing policy", () => {
  test("app code and docs under the cap are the Routing judge's", () => {
    expect(lab({ paths: ["app/src/commands/add.ts", "docs/usage.md"], lines: 40, messages: ["feat: x"] })).toEqual({
      kind: "judged",
    });
  });

  test("a change to .github/ or to a path the Code review does not read goes to the Owner with review:deep", () => {
    for (const [input, reason] of [
      [
        { paths: [".github/workflows/ci.yml"], lines: 3, messages: [] },
        "a path the Owner lands: .github/workflows/ci.yml",
      ],
      [{ paths: [FACTORY_CONFIG_PATH, "scripts/a.ts"], lines: 3, messages: [] }, FACTORY_CONFIG_PATH],
      [{ paths: ["bun.lock", "package.json"], lines: 3, messages: [] }, "a path the Owner lands: bun.lock"],
      [{ paths: ["scripts/vendor/anti-slop/a.md"], lines: 3, messages: [] }, "scripts/vendor/anti-slop/a.md"],
      [{ paths: [".github/a.yml"], lines: 3000, messages: ["feat!: x"] }, "a path the Owner lands: .github/a.yml"],
    ] as const) {
      const verdict = lab(input);

      expect(verdict.kind).toBe("ruled");
      expect(answerOf(verdict)).toMatchObject(OWNER_DEEP);
      expect(answerOf(verdict)?.reason).toContain(reason);
    }
  });

  test("a change that touches no file has no route", () => {
    expect(() => lab({ paths: [], lines: 0, messages: [] })).toThrow("at least one file");
  });

  test("the factory's own code, its session settings, the agent docs and the build and gate configs land auto after a deep review", () => {
    for (const path of FACTORY_FILES) {
      const verdict = lab({ paths: [path], lines: 3, messages: [] });

      expect(verdict.kind).toBe("ruled");
      expect(answerOf(verdict)).toMatchObject(AUTO_DEEP);
      expect(answerOf(verdict)?.reason).toContain(`a path a deep review reads: ${path}`);
    }
  });

  test("the task file's format lands auto after a deep review, under the breaking-commit hold", () => {
    const paths = ["app/src/store/store.ts"];

    expect(lab({ paths, lines: 400, messages: ["fix(store): x"] })).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
    expect(answerOf(lab({ paths, lines: 3, messages: ["feat(store)!: drop v1"] }))?.land).toBe("owner");
    expect(lab({ paths, lines: 401, messages: [] })).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
    expect(answerOf(lab({ paths: [...paths, "scripts/a.ts"], lines: 3, messages: ["feat!: x"] }))?.land).toBe("owner");
  });

  test("the reason names the first three paths a rule matched", () => {
    expect(
      answerOf(lab({ paths: ["scripts/a.ts", "scripts/b.ts", "scripts/c.ts", "scripts/d.ts"], lines: 4, messages: [] }))
        ?.reason,
    ).toBe(
      "touches a path a deep review reads: scripts/a.ts, scripts/b.ts, scripts/c.ts; lands once CI is green and no Important is open",
    );
  });

  test("a config of the same name outside the root is the Routing judge's", () => {
    expect(lab({ paths: ["app/bunfig.toml", "app/oxlint.config.ts"], lines: 1, messages: [] }).kind).toBe("judged");
  });
});

describe("the breaking commits", () => {
  test("send a change outside the factory's paths to the Owner", () => {
    for (const [input, reason] of [
      [{ paths: ["app/src/cli.ts"], lines: 3, messages: ["feat!: drop list"] }, "a breaking commit: feat!: drop list"],
      [
        { paths: ["app/src/cli.ts"], lines: 3, messages: ["feat: x\n\nBREAKING CHANGE: y"] },
        "a breaking commit: feat: x",
      ],
      [{ paths: ["app/src/cli.ts"], lines: 3000, messages: ["feat!: x"] }, "a breaking commit: feat!: x"],
    ] as const) {
      expect(lab(input)).toEqual({ kind: "ruled", answer: { ...OWNER_DEEP, reason } });
    }
  });

  test("a breaking marker that does not start a line breaks nothing", () => {
    expect(lab({ paths: ["app/src/cli.ts"], lines: 3, messages: ["docs: explain the feat!: prefix"] }).kind).toBe(
      "judged",
    );
  });

  test("hold a change that mixes the factory's paths with other paths, which otherwise takes the rules' answer", () => {
    const paths = ["scripts/land-loop/pr-watch.ts", "app/src/cli.ts"];

    expect(answerOf(lab({ paths, lines: 3, messages: ["fix(app)!: x"] }))?.land).toBe("owner");
    expect(lab({ paths, lines: 400, messages: ["fix: x"] })).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
  });

  test("do not hold a change of the factory's paths only", () => {
    expect(
      lab({ paths: ["scripts/land-loop/pr-watch.ts", "AGENTS.md"], lines: 3000, messages: ["feat!: x"] }),
    ).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
  });
});

describe("the cap", () => {
  test("gives a change past it a deep review that lands auto, inside the factory's paths and outside, and asks no judge", () => {
    for (const paths of [
      ["app/src/cli.ts"],
      ["scripts/land-loop/pr-watch.ts"],
      ["scripts/land-loop/pr-watch.ts", "app/src/cli.ts"],
    ]) {
      const verdict = lab({ paths, lines: 401, messages: ["feat: x"] });

      expect(verdict).toEqual({
        kind: "ruled",
        answer: { ...AUTO_DEEP, reason: "401 lines changed, past the 400-line cap" },
      });
      expect(judgeAskOf(verdict, null)).toEqual({ kind: "none" });
    }
  });

  test("is the policy's", () => {
    const policy: RoutingPolicy = { ...EMPTY, lineCap: 10 };

    expect(routingRulesOf(policy, { paths: ["a.ts"], lines: 10, messages: [] }).kind).toBe("judged");
    expect(routingRulesOf(policy, { paths: ["a.ts"], lines: 11, messages: [] })).toEqual({
      kind: "ruled",
      answer: { ...AUTO_DEEP, reason: "11 lines changed, past the 10-line cap" },
    });
  });
});

const judge = (land: RoutingAnswer["land"]): RoutingAnswer => ({
  land,
  review: "light",
  secondRound: false,
  reason: "costly to undo",
  model: "claude-haiku-5-5",
});

const RULED: RoutingAnswer = { ...AUTO_DEEP, reason: "touches scripts/a.ts" };

const RULED_ONLY: RulesVerdict = { kind: "ruled", answer: RULED };

const JUDGED: RulesVerdict = { kind: "judged" };

describe("judgeAskOf", () => {
  test("with no Patch delta, asks about a change no rule names, and nothing of a ruled one", () => {
    expect(judgeAskOf(JUDGED, null)).toEqual({ kind: "ask" });
    expect(judgeAskOf(RULED_ONLY, null)).toEqual({ kind: "none" });
  });

  test("on a Patch delta, asks exactly when the delta's own verdict is judged", () => {
    expect(judgeAskOf(RULED_ONLY, JUDGED)).toEqual({ kind: "ask" });
    expect(judgeAskOf(JUDGED, JUDGED)).toEqual({ kind: "ask" });
    expect(judgeAskOf(RULED_ONLY, RULED_ONLY)).toEqual({ kind: "none" });
    expect(judgeAskOf(JUDGED, RULED_ONLY)).toEqual({ kind: "none" });
  });
});

describe("routingOf", () => {
  test("a change no rule names takes the Routing judge's Review depth, and lands auto whatever the judge answers", () => {
    expect(routingOf(JUDGED, null, judge("auto"))).toEqual(judge("auto"));
    expect(routingOf(JUDGED, null, judge("owner"))).toEqual(judge("auto"));
    expect(routingOf(JUDGED, JUDGED, judge("owner"))).toEqual(judge("auto"));
  });

  test("a ruled change keeps the rules' answer, and asks no judge", () => {
    expect(routingOf(RULED_ONLY, null, null)).toEqual(RULED);
  });

  test("a ruled change keeps the rules' route whatever the judge says of its Patch delta, which it only asks whether to read again", () => {
    expect(routingOf(RULED_ONLY, JUDGED, judge("owner"))).toEqual({ ...RULED, secondRound: false });
    expect(routingOf(RULED_ONLY, JUDGED, { ...judge("auto"), secondRound: true })).toEqual(RULED);
  });

  test("on a ruled Patch delta, a ruled change is read again", () => {
    expect(routingOf(RULED_ONLY, RULED_ONLY, null)).toEqual(RULED);
    expect(routingOf(RULED_ONLY, { kind: "ruled", answer: { ...RULED, secondRound: false } }, null)).toEqual(RULED);
  });

  test("a change no rule names whose Patch delta is ruled takes the delta's answer, asks no judge, and lands auto", () => {
    const delta: RoutingAnswer = { ...RULED, reason: "the delta" };

    expect(routingOf(JUDGED, { kind: "ruled", answer: delta }, null)).toEqual(delta);
    expect(routingOf(JUDGED, { kind: "ruled", answer: { ...delta, land: "owner" } }, null)).toEqual(delta);
  });

  test("a change the judge was not asked about, though its verdict needs it, fails", () => {
    expect(() => routingOf(JUDGED, null, null)).toThrow("the Routing judge was not asked about a judged change");
    expect(() => routingOf(JUDGED, JUDGED, null)).toThrow("judged change");
    expect(() => routingOf(RULED_ONLY, JUDGED, null)).toThrow("judged change");
  });
});

describe("under the lab's policy, the Patch delta of a change that mixes the factory's paths with a path no rule names", () => {
  // PR #88's shape: the PR touched .gitignore among the factory's paths, and its round-1 fix touched a factory path only.
  const whole = lab({ paths: [".gitignore", "scripts/land-loop/stop/hook.ts"], lines: 30, messages: ["fix: x"] });

  test("is ruled as a whole, and lands auto after a deep review", () => {
    expect(whole).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
  });

  test("that touches the factory's paths only asks the Routing judge nothing and keeps the rules' route", () => {
    const patchDelta = lab({ paths: ["scripts/land-loop/stop/hook.test.ts"], lines: 0, messages: [] });

    expect(judgeAskOf(whole, patchDelta)).toEqual({ kind: "none" });
    expect(routingOf(whole, patchDelta, null)).toMatchObject(AUTO_DEEP);
  });

  test("that touches the path no rule names alone asks the Routing judge whether to read it again, and keeps the rules' route", () => {
    const patchDelta = lab({ paths: [".gitignore"], lines: 0, messages: [] });

    expect(judgeAskOf(whole, patchDelta)).toEqual({ kind: "ask" });
    expect(routingOf(whole, patchDelta, judge("owner"))).toMatchObject({ ...AUTO_DEEP, secondRound: false });
  });

  test("that touches both is ruled, and asks the Routing judge nothing", () => {
    const patchDelta = lab({ paths: [".gitignore", "scripts/land-loop/stop/hook.test.ts"], lines: 0, messages: [] });

    expect(judgeAskOf(whole, patchDelta)).toEqual({ kind: "none" });
  });
});

const FACTORY_PATH = fc.oneof(
  fc.constantFrom("AGENTS.md", "REVIEW.md", "package.json", "stryker.config.ts", ".mcp.json"),
  fc.constantFrom("scripts/land-loop", "scripts/lint", ".claude").chain(UNDER),
);

const ANY_PATH = fc.array(SEGMENT, { minLength: 1, maxLength: 4 }).map((segments) => segments.join("/"));

const matches = (globs: readonly string[], path: string): boolean =>
  globs.some((glob) => new Bun.Glob(glob).match(path));

const NOT_OWNER_PATH = fc
  .oneof(ANY_PATH, FACTORY_PATH, UNDER("app/src"))
  .filter((path) => !matches([FACTORY_CONFIG_PATH, ...LAB.ownerPaths], path));

const BREAKING = /^\w+(\([^)]*\))?!:|BREAKING CHANGE/mu;

const JUDGE: fc.Arbitrary<RoutingAnswer> = fc.record({
  land: fc.constantFrom("auto", "owner"),
  review: fc.constantFrom("none", "light", "deep"),
  secondRound: fc.boolean(),
  reason: fc.string(),
  model: fc.option(fc.string(), { nil: null }),
});

const CHANGE = (path: fc.Arbitrary<string>) =>
  fc.record({
    paths: fc.array(path, { minLength: 1 }),
    lines: fc.integer({ min: 0, max: 2000 }),
    messages: fc.array(fc.oneof(fc.string(), fc.constantFrom("feat!: x", "fix: y\n\nBREAKING CHANGE: z"))),
  });

describe("under the lab's policy", () => {
  test("a change of the factory's paths only lands auto after a deep review, whatever its size or its messages", () => {
    fc.assert(
      fc.property(CHANGE(FACTORY_PATH), (input) => {
        expect(lab(input)).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
      }),
    );
  });

  test("a change with no ownerPaths path, no factory config and no breaking commit outside the factory's paths never goes to the Owner, whatever the Routing judge answers", () => {
    fc.assert(
      fc.property(
        fc.record({
          change: CHANGE(NOT_OWNER_PATH),
          delta: fc.option(CHANGE(NOT_OWNER_PATH), { nil: null }),
          judge: JUDGE,
        }),
        ({ change, delta, judge: answer }) => {
          const verdict = lab(change);
          const patchDelta = delta === null ? null : lab(delta);
          const routed = routingOf(verdict, patchDelta, judgeAskOf(verdict, patchDelta).kind === "ask" ? answer : null);
          const factoryOnly = change.paths.every((path) => matches(LAB.factoryPaths, path));
          const heldBreaking = !factoryOnly && change.messages.some((message) => BREAKING.test(message));

          expect(routed.land).toBe(heldBreaking ? "owner" : "auto");
        },
      ),
    );
  });
});
