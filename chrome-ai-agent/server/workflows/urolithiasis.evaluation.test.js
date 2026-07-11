import assert from "node:assert/strict";
import test from "node:test";

import {
  applyUrolithiasisRules,
  hasDatesWithinDays,
  recurringUtiValue,
  selectClosestBefore
} from "./urolithiasis.js";
import { createWorkflowRecord } from "./records.js";

function record(id = "synthetic-evaluation") {
  return createWorkflowRecord({ id, mrn: "SYNTHETIC", surgeryDate: "2026-01-15" });
}

test("evaluation scenario 6: an equal-date closest-before tie is resolved by source order", () => {
  const first = { date: "2026-01-14", value: "first" };
  const second = { date: "2026-01-14", value: "second" };
  assert.equal(selectClosestBefore([first, second], "2026-01-15"), first);
  assert.equal(selectClosestBefore([second, first], "2026-01-15"), second);
});

test("evaluation scenarios 9-10: seven days qualifies and eight days does not", () => {
  assert.equal(hasDatesWithinDays([{ date: "2026-01-01" }, { date: "2026-01-08" }], 7), true);
  assert.equal(hasDatesWithinDays([{ date: "2026-01-01" }, { date: "2026-01-09" }], 7), false);
});

test("evaluation scenarios 11-12: only the two latest consecutive positive pre-op cultures qualify", () => {
  assert.equal(recurringUtiValue([
    { date: "2026-01-14", result: "Positive" },
    { date: "2026-01-10", result: "Positive" }
  ], "2026-01-15"), 1);
  assert.equal(recurringUtiValue([
    { date: "2026-01-14", result: "Positive" },
    { date: "2026-01-10", result: "Negative" }
  ], "2026-01-15"), 0);
});

test("evaluation scenario 13 characterization: same-day post-op CT is currently treated as absent", () => {
  const target = record("same-day-ct");
  applyUrolithiasisRules(target, {
    postOpCtKub: [{ date: "2026-01-15", imageType: "CT KUB", residualStone: false, hydronephrosis: false }]
  });
  assert.equal(target.fields.CS.value, "N/A");
  assert.equal(target.fields.CT.value, "N/A");
});

test("evaluation scenario 14: ultrasound is not substituted when the CT KUB list is empty", () => {
  const target = record("ultrasound-only");
  applyUrolithiasisRules(target, { postOpCtKub: [] });
  for (const field of ["CS", "CT", "CU", "CV", "CW"]) assert.equal(target.fields[field].value, "N/A");
});

test("evaluation field CV characterization: numeric residual-stone size is rejected by the text schema", () => {
  const target = record("numeric-stone-size");
  assert.throws(() => applyUrolithiasisRules(target, {
    postOpCtKub: [{ date: "2026-01-16", residualStone: true, residualStoneSize: 4, hydronephrosis: false }]
  }), /non-empty text/i);
});
