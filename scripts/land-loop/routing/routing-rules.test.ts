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

  test("a change to .github/, to a path the Code review does not read, or to no file goes to the Owner with review:deep", () => {
    for (const [input, reason] of [
      [{ paths: [], lines: 0, messages: [] }, "touches no file"],
      [
        { paths: [".github/workflows/ci.yml"], lines: 3, messages: [] },
        "a path the Owner lands: .github/workflows/ci.yml",
      ],
      [{ paths: [FACTORY_CONFIG_PATH, "scripts/a.ts"], lines: 3, messages: [] }, FACTORY_CONFIG_PATH],
      [{ paths: ["bun.lock", "package.json"], lines: 3, messages: [] }, "a path the Owner lands: bun.lock"],
      [{ paths: ["scripts/vendor/anti-slop/a.md"], lines: 3, messages: [] }, "scripts/vendor/anti-slop/a.md"],
    ] as const) {
      const verdict = lab(input);

      expect(verdict.kind).toBe("ruled");
      expect(answerOf(verdict)).toMatchObject(OWNER_DEEP);
      expect(answerOf(verdict)?.reason).toContain(reason);
    }
  });

  test("the factory's own code, its session settings, the agent docs and the build and gate configs land auto after a deep review", () => {
    for (const path of FACTORY_FILES) {
      const verdict = lab({ paths: [path], lines: 3, messages: [] });

      expect(verdict.kind).toBe("ruled");
      expect(answerOf(verdict)).toMatchObject(AUTO_DEEP);
      expect(answerOf(verdict)?.reason).toContain(`a path a deep review reads: ${path}`);
    }
  });

  test("the task file's format lands auto after a deep review, under the cap and the breaking-commit hold", () => {
    const paths = ["app/src/store/store.ts"];

    expect(lab({ paths, lines: 400, messages: ["fix(store): x"] })).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
    expect(answerOf(lab({ paths, lines: 3, messages: ["feat(store)!: drop v1"] }))?.land).toBe("owner");
    expect(answerOf(lab({ paths, lines: 401, messages: [] }))?.land).toBe("owner");
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

describe("the cap and the breaking commits", () => {
  test("send a change outside the factory's paths to the Owner", () => {
    for (const [input, reason] of [
      [{ paths: ["app/src/cli.ts"], lines: 3, messages: ["feat!: drop list"] }, "a breaking commit: feat!: drop list"],
      [
        { paths: ["app/src/cli.ts"], lines: 3, messages: ["feat: x\n\nBREAKING CHANGE: y"] },
        "a breaking commit: feat: x",
      ],
      [{ paths: ["app/src/cli.ts"], lines: 401, messages: [] }, "401 lines changed, past the 400-line cap"],
    ] as const) {
      expect(lab(input)).toEqual({ kind: "ruled", answer: { ...OWNER_DEEP, reason } });
    }
  });

  test("a breaking marker that does not start a line breaks nothing", () => {
    expect(lab({ paths: ["app/src/cli.ts"], lines: 3, messages: ["docs: explain the feat!: prefix"] }).kind).toBe(
      "judged",
    );
  });

  test("hold a change that mixes the factory's paths with other paths, which the Routing judge is then asked about", () => {
    const paths = ["scripts/land-loop/pr-watch.ts", "app/src/cli.ts"];

    expect(answerOf(lab({ paths, lines: 401, messages: [] }))?.land).toBe("owner");
    expect(answerOf(lab({ paths, lines: 3, messages: ["fix(app)!: x"] }))?.land).toBe("owner");
    expect(lab({ paths, lines: 400, messages: ["fix: x"] })).toMatchObject({
      kind: "ruled-then-judged",
      answer: AUTO_DEEP,
      judgedPaths: ["app/src/cli.ts"],
    });
  });

  test("do not hold a change of the factory's paths only", () => {
    expect(
      lab({ paths: ["scripts/land-loop/pr-watch.ts", "AGENTS.md"], lines: 3000, messages: ["feat!: x"] }),
    ).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
  });

  test("the cap is the policy's", () => {
    const policy: RoutingPolicy = { ...EMPTY, lineCap: 10 };

    expect(routingRulesOf(policy, { paths: ["a.ts"], lines: 10, messages: [] }).kind).toBe("judged");
    expect(answerOf(routingRulesOf(policy, { paths: ["a.ts"], lines: 11, messages: [] }))?.reason).toBe(
      "11 lines changed, past the 10-line cap",
    );
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

const MIXED: RulesVerdict = { kind: "ruled-then-judged", answer: RULED, judgedPaths: ["app/b.ts"] };

const mixedOf = (judgedPaths: readonly string[]): RulesVerdict => ({
  kind: "ruled-then-judged",
  answer: RULED,
  judgedPaths,
});

describe("judgeAskOf", () => {
  test("asks the whole diff of a change no rule names, and only the unruled paths of a mixed one", () => {
    expect(judgeAskOf({ kind: "judged" }, null)).toEqual({ kind: "ask", paths: null });
    expect(judgeAskOf(MIXED, null)).toEqual({ kind: "ask", paths: ["app/b.ts"] });
  });

  test("on a Patch delta, asks about the unruled paths of a mixed change that the delta touches, and nothing when it touches none", () => {
    const wide = mixedOf(["app/b.ts", "app/c.ts"]);

    expect(judgeAskOf(wide, mixedOf(["app/c.ts", "docs/d.md"]))).toEqual({ kind: "ask", paths: ["app/c.ts"] });
    expect(judgeAskOf(wide, mixedOf(["docs/d.md"]))).toEqual({ kind: "none" });
    expect(judgeAskOf(wide, { kind: "judged" })).toEqual({ kind: "ask", paths: ["app/b.ts", "app/c.ts"] });
    expect(judgeAskOf(wide, RULED_ONLY)).toEqual({ kind: "none" });
  });

  test("asks nothing of a ruled change, unless its Patch delta is the judge's", () => {
    expect(judgeAskOf(RULED_ONLY, null)).toEqual({ kind: "none" });
    expect(judgeAskOf(RULED_ONLY, RULED_ONLY)).toEqual({ kind: "none" });
    expect(judgeAskOf(RULED_ONLY, { kind: "judged" })).toEqual({ kind: "ask", paths: null });
  });
});

describe("routingOf", () => {
  test("a change no rule names takes the Routing judge's answer, on a Patch delta too", () => {
    expect(routingOf({ kind: "judged" }, null, judge("auto"))).toEqual(judge("auto"));
    expect(routingOf({ kind: "judged" }, RULED_ONLY, judge("auto"))).toEqual(judge("auto"));
  });

  test("a ruled change keeps the rules' answer, and asks no judge", () => {
    expect(routingOf(RULED_ONLY, null, null)).toEqual(RULED);
  });

  test("a ruled change keeps the rules' route whatever the judge says of its Patch delta, which it only asks whether to read again", () => {
    expect(routingOf(RULED_ONLY, { kind: "judged" }, judge("owner"))).toEqual({ ...RULED, secondRound: false });
  });

  test("a mixed change the judge would land auto keeps the rules' answer, deep review included", () => {
    expect(routingOf(MIXED, null, judge("auto"))).toEqual(RULED);
  });

  test("a mixed change the judge sends to the Owner goes to the Owner, still with a deep review, naming both reasons", () => {
    expect(routingOf(MIXED, null, judge("owner"))).toEqual({
      ...RULED,
      land: "owner",
      reason: "touches scripts/a.ts; the Routing judge: costly to undo",
      model: "claude-haiku-5-5",
    });
  });

  test("on a Patch delta, a ruled delta is read again, and a judged one only when the judge says so", () => {
    expect(routingOf(RULED_ONLY, RULED_ONLY, null).secondRound).toBe(true);
    expect(routingOf(RULED_ONLY, { kind: "judged" }, judge("auto")).secondRound).toBe(false);
    expect(routingOf(RULED_ONLY, { kind: "judged" }, { ...judge("auto"), secondRound: true }).secondRound).toBe(true);
    expect(routingOf(MIXED, mixedOf(["app/b.ts"]), judge("auto")).secondRound).toBe(true);
    expect(routingOf(MIXED, { kind: "judged" }, judge("auto")).secondRound).toBe(false);
  });

  test("on a Patch delta that touches none of a mixed change's unruled paths, the rules' answer stands, read again, with no judge", () => {
    expect(routingOf(MIXED, RULED_ONLY, null)).toEqual(RULED);
    expect(routingOf(MIXED, mixedOf(["docs/d.md"]), null)).toEqual(RULED);
  });

  test("on a Patch delta that touches one of them, the judge still has its say", () => {
    expect(routingOf(MIXED, mixedOf(["app/b.ts"]), judge("owner")).land).toBe("owner");
  });

  test("a change the judge was not asked about, though its verdict needs it, fails", () => {
    expect(() => routingOf({ kind: "judged" }, null, null)).toThrow(
      "the Routing judge was not asked about a judged change",
    );
    expect(() => routingOf(MIXED, null, null)).toThrow("ruled-then-judged");
    expect(() => routingOf(MIXED, mixedOf(["app/b.ts"]), null)).toThrow("ruled-then-judged");
    expect(() => routingOf(MIXED, { kind: "judged" }, null)).toThrow("ruled-then-judged");
    expect(() => routingOf(RULED_ONLY, { kind: "judged" }, null)).toThrow("ruled");
  });
});

describe("under the lab's policy, the Patch delta of a change that mixes the factory's paths with a path no rule names", () => {
  // PR #88's shape: the PR touched .gitignore among the factory's paths, and its round-1 fix touched a factory path only.
  const whole = lab({ paths: [".gitignore", "scripts/land-loop/stop/hook.ts"], lines: 30, messages: ["fix: x"] });

  test("that touches the factory's paths only asks the Routing judge nothing and keeps the rules' route", () => {
    const patchDelta = lab({ paths: ["scripts/land-loop/stop/hook.test.ts"], lines: 0, messages: [] });

    expect(judgeAskOf(whole, patchDelta)).toEqual({ kind: "none" });
    expect(routingOf(whole, patchDelta, null)).toMatchObject(AUTO_DEEP);
  });

  test("that touches the path no rule names asks the Routing judge about it", () => {
    for (const paths of [[".gitignore"], [".gitignore", "scripts/land-loop/stop/hook.test.ts"]]) {
      expect(judgeAskOf(whole, lab({ paths, lines: 0, messages: [] }))).toEqual({ kind: "ask", paths: [".gitignore"] });
    }
  });
});

const FACTORY_PATH = fc.oneof(
  fc.constantFrom("AGENTS.md", "REVIEW.md", "package.json", "stryker.config.ts", ".mcp.json"),
  fc.constantFrom("scripts/land-loop", "scripts/lint", ".claude").chain(UNDER),
);

const RULED_PATH = fc.oneof(FACTORY_PATH, UNDER("app/src/store"));

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
  test("a change of the factory's paths only lands auto after a deep review, whatever its size or its messages", () => {
    fc.assert(
      fc.property(
        fc.record({ paths: fc.array(FACTORY_PATH, { minLength: 1 }), lines: CHANGE.lines, messages: CHANGE.messages }),
        (input) => {
          expect(lab(input)).toMatchObject({ kind: "ruled", answer: AUTO_DEEP });
        },
      ),
    );
  });

  test("a path no rule names keeps the Routing judge's say on the route of a change that also touches a ruled path", () => {
    fc.assert(
      fc.property(
        fc.record({ ruled: RULED_PATH, app: UNDER("app/src/commands"), ...CHANGE }),
        ({ ruled, app, others, at, lines, messages }) => {
          const verdict = lab({ paths: [app, ...inserted(ruled, others, at)], lines, messages });

          expect(verdict.kind === "ruled-then-judged" || answerOf(verdict)?.land === "owner").toBe(true);
        },
      ),
    );
  });
});
