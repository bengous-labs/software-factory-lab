import { describe, expect, test } from "bun:test";

import { MERGE_BOT_STATE_MARKER } from "../../contract.ts";
import { LIGHT, P1 } from "./merge-bot.fixtures.ts";
import {
  EMPTY_RECORD,
  recordOfComment,
  recordOfJson,
  recordOfStored,
  stateCommentOf,
  storedOfRecord,
} from "./record.ts";
import type { StateRecord, StoredRecord } from "./record.ts";

describe("the stored record", () => {
  test("a stored human Land route reads as owner and is stored again as human; every other field is kept", () => {
    const stored: StoredRecord = {
      ...EMPTY_RECORD,
      reviewedPatch: P1,
      reviewRounds: 1,
      triage: { [P1]: { ...LIGHT, land: "human" }, "patch-2": { ...LIGHT, land: "auto" } },
    };

    const record = recordOfStored(stored);

    expect(record.triage[P1]?.land).toBe("owner");
    expect(record.triage["patch-2"]?.land).toBe("auto");
    expect(record).toMatchObject({ reviewedPatch: P1, reviewRounds: 1 });
    expect(storedOfRecord(record)).toEqual(stored);
  });

  test("a stored Land route that is not auto reads as owner, the safe side", () => {
    const stored = { ...EMPTY_RECORD, triage: { [P1]: { ...LIGHT, land: "later" } } };

    expect(recordOfStored(stored).triage[P1]?.land).toBe("owner");
    expect(recordOfJson(JSON.stringify(stored)).triage[P1]?.land).toBe("owner");
  });

  test("an empty comment JSON reads as the record of a change no Review round read", () => {
    expect(recordOfJson("{}")).toEqual(EMPTY_RECORD);
  });

  test("a record written before the Routing answer named its model reads with no model", () => {
    const { model: _model, ...unnamed } = LIGHT;

    expect(recordOfJson(JSON.stringify({ triage: { [P1]: { ...unnamed, land: "auto" } } })).triage[P1]).toEqual({
      ...LIGHT,
      model: null,
    });
  });

  test("a Routing answer's security flag is stored and read back; a record written before it reads with none", () => {
    const secured = { ...EMPTY_RECORD, triage: { [P1]: { ...LIGHT, security: true } } };

    expect(recordOfJson(JSON.stringify(storedOfRecord(secured)))).toEqual(secured);
    expect(recordOfJson(JSON.stringify({ triage: { [P1]: { ...LIGHT, land: "auto" } } })).triage[P1]).toEqual(LIGHT);
    expect(() => recordOfJson(JSON.stringify({ triage: { [P1]: { ...LIGHT, security: "yes" } } }))).toThrow("security");
  });

  test("a record outside its schema is refused, naming the field", () => {
    expect(() => recordOfJson(JSON.stringify({ reviewRounds: "1" }))).toThrow(
      'the Merge bot state record: Expected number\n  at ["reviewRounds"]',
    );
    expect(() => recordOfJson(JSON.stringify({ triage: { [P1]: { ...LIGHT, review: "skim" } } }))).toThrow(
      `at ["triage"]["${P1}"]["review"]`,
    );
  });

  test("a record with a review asked reads back the same, and one written before the field existed reads with none", () => {
    const review = {
      kind: "requested" as const,
      patch: P1,
      round: 2 as const,
      runId: 7,
      at: "2026-11-07T11:00:00.000Z",
    };

    const record = { ...EMPTY_RECORD, review };

    expect(recordOfJson(JSON.stringify(storedOfRecord(record)))).toEqual(record);
    expect(recordOfJson(JSON.stringify({ reviewRounds: 1 })).review).toBeUndefined();
    expect(recordOfJson(JSON.stringify({ review: { ...review, round: 3 } })).review?.round).toBe(3);
    expect(recordOfJson(JSON.stringify({ review: { ...review, round: 4 } })).review?.round).toBe(4);
    expect(() => recordOfJson(JSON.stringify({ review: { ...review, round: 5 } }))).toThrow('at ["review"]');
  });

  test("a Delta read's Routing flag and patch are stored and read back; a record written before them reads with neither", () => {
    const record = { ...EMPTY_RECORD, deltaReadPatch: P1, triage: { [P1]: { ...LIGHT, deltaRead: true } } };
    const old = recordOfJson(JSON.stringify({ triage: { [P1]: { ...LIGHT, land: "auto" } } }));

    expect(recordOfJson(JSON.stringify(storedOfRecord(record)))).toEqual(record);
    expect(old).not.toHaveProperty("deltaReadPatch");
    expect(old.triage[P1]).toEqual(LIGHT);
    expect(() => recordOfJson(JSON.stringify({ deltaReadPatch: 1 }))).toThrow('at ["deltaReadPatch"]');
    expect(() => recordOfJson(JSON.stringify({ triage: { [P1]: { ...LIGHT, deltaRead: "yes" } } }))).toThrow(
      `at ["triage"]["${P1}"]["deltaRead"]`,
    );
  });

  test("a record that counted Important findings posted in a review's body still reads, and the count is left out", () => {
    const record = recordOfJson(JSON.stringify({ reviewRounds: 1, reviewedPatch: P1, bodyImportant: { [P1]: 2 } }));

    expect(record).toEqual({ ...EMPTY_RECORD, reviewRounds: 1, reviewedPatch: P1 });
    expect(storedOfRecord(record)).not.toHaveProperty("bodyImportant");
    expect(() => recordOfJson(JSON.stringify({ bodyImportant: { [P1]: "2" } }))).toThrow('at ["bodyImportant"]');
  });

  test("a record written while the Principal judge existed still reads, and its fields are left out", () => {
    const record = recordOfJson(
      JSON.stringify({
        reviewRounds: 1,
        reviewedPatch: P1,
        triage: { [P1]: { ...LIGHT, needsFable: true } },
        fable: { [P1]: { ok: true, reason: "fine" } },
        fableFailures: { [P1]: 1 },
      }),
    );

    expect(record).toEqual({ ...EMPTY_RECORD, reviewRounds: 1, reviewedPatch: P1, triage: { [P1]: LIGHT } });
    expect(() => recordOfJson(JSON.stringify({ fable: { [P1]: { ok: "yes" } } }))).toThrow('at ["fable"]');
    expect(() => recordOfJson(JSON.stringify({ fableFailures: { [P1]: "1" } }))).toThrow('at ["fableFailures"]');
    expect(() => recordOfJson(JSON.stringify({ triage: { [P1]: { ...LIGHT, needsFable: "yes" } } }))).toThrow(
      `at ["triage"]["${P1}"]["needsFable"]`,
    );
  });

  test("a record written before the Important counts and the Owner hold reads with neither, and one with them reads back the same", () => {
    const old = recordOfJson(JSON.stringify({ reviewRounds: 2, reviewedPatch: P1 }));
    const record = { ...EMPTY_RECORD, reviewRounds: 3, importantByRound: [null, 0, 2], ownerHold: "why" };

    expect(old).toEqual({ ...EMPTY_RECORD, reviewRounds: 2, reviewedPatch: P1 });
    expect(recordOfJson(JSON.stringify(storedOfRecord(record)))).toEqual(record);
    expect(() => recordOfJson(JSON.stringify({ importantByRound: ["1"] }))).toThrow('at ["importantByRound"][0]');
    expect(() => recordOfJson(JSON.stringify({ ownerHold: 1 }))).toThrow('at ["ownerHold"]');
  });

  test("a record is stored with its reviewRounds, and reads back the same", () => {
    const record = recordOfJson(
      JSON.stringify({ reviewRounds: 1, reviewedPatch: P1, triage: { [P1]: { ...LIGHT, land: "human" } } }),
    );

    const stored = storedOfRecord(record);

    expect(stored.reviewRounds).toBe(1);
    expect(recordOfJson(JSON.stringify(stored))).toEqual(record);
  });
});

describe("the Ejection a record holds", () => {
  test("its head and its reason read back from the stored record, and one that lacks either is refused", () => {
    const stored = { ...storedOfRecord(EMPTY_RECORD), dequeued: { head: "h1", reason: "a conflict" } };

    expect(recordOfJson(JSON.stringify(stored)).dequeued).toEqual({ head: "h1", reason: "a conflict" });
    expect(() => recordOfJson(JSON.stringify({ ...stored, dequeued: { head: "h1" } }))).toThrow(
      "the Merge bot state record",
    );
  });
});

describe("the state comment", () => {
  const record: StateRecord = { ...EMPTY_RECORD, reviewedPatch: P1, reviewRounds: 2, importantByRound: [1, 0] };
  const json = JSON.stringify(storedOfRecord(record));

  test("a comment written before the ledger is still read", () => {
    const before = `Merge bot state for this PR. Do not edit.\n\n${MERGE_BOT_STATE_MARKER} ${json} -->`;

    expect(recordOfComment(before)).toEqual(record);
    expect(stateCommentOf(record, "")).toBe(before);
  });

  test("a comment that holds the ledger reads its record on the record's own line, after the ledger", () => {
    const ledger =
      "**Review findings**: 1 open.\n\n**Round 1**: 1 Important.\n- **Open.** Important [`a.ts:3`](u): off";

    const body = stateCommentOf(record, ledger);

    expect(body).toBe(
      `Merge bot state for this PR. Do not edit.\n\n${ledger}\n\n${MERGE_BOT_STATE_MARKER} ${json} -->`,
    );
    expect(recordOfComment(body)).toEqual(record);
  });

  test("a ledger line that quotes the marker cannot pass for the record", () => {
    const forged = `${MERGE_BOT_STATE_MARKER} ${JSON.stringify({ reviewRounds: 3 })} -->`;
    const ledger = `**Round 1**: 1 Important.\n- **Open.** Important [\`${forged}\`](u): a -->`;

    expect(recordOfComment(stateCommentOf(record, ledger))).toEqual(record);
    expect(recordOfComment(`x${forged}\n\n${MERGE_BOT_STATE_MARKER} ${json} -->`)).toEqual(record);
    expect(recordOfComment(`${forged} y`)).toEqual(EMPTY_RECORD);
  });

  test("a comment with no record line reads as the empty record", () => {
    expect(recordOfComment("Merge bot state for this PR. Do not edit.")).toEqual(EMPTY_RECORD);
    expect(recordOfComment(`${MERGE_BOT_STATE_MARKER} {}\n -->`)).toEqual(EMPTY_RECORD);
  });
});
