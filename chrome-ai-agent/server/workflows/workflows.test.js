import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FieldStatus,
  UROLITHIASIS_FIELD_SCHEMA,
  WorkflowRunStore,
  applyUrolithiasisRules,
  assessUrolithiasisReview,
  assertValidPatientQueue,
  createEvidence,
  createFieldValue,
  createWorkflowRecord,
  exportRecordToMarkdown,
  exportRunToCsv,
  hasDatesWithinDays,
  parsePatientQueue,
  selectClosestBefore,
  selectFirstAfter,
  setRecordField,
  validateRecord,
  validateUrolithiasisRecord,
} from "./index.js";

const evidence = [createEvidence({ source: "TrakCare Laboratory", sourceDate: "2026-01-01", reference: "Lab 123" })];

test("patient queue accepts valid records and rejects duplicate or malformed rows", () => {
  const parsed = parsePatientQueue("123,2026-01-05,first\n456,2026-02-28\n123,2026-01-05,other\n789,2026-02-31");
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].id, "first");
  assert.match(parsed.records[1].id, /^patient_/);
  assert.deepEqual(parsed.errors.map((entry) => entry.line), [3, 4]);
  assert.throws(() => assertValidPatientQueue("123,invalid"), /Invalid patient queue/);
});

test("typed fields enforce values, evidence provenance, and required fields", () => {
  assert.throws(() => createFieldValue({ status: FieldStatus.FOUND, type: "boolean", value: 2 }), /0 or 1/);
  assert.throws(() => createEvidence({ source: "Lab", sourceDate: "2026-13-01" }), /sourceDate/);
  const record = createWorkflowRecord({ id: "record_1", mrn: "123", surgeryDate: "2026-01-05" });
  setRecordField(record, "K", { status: FieldStatus.FOUND, type: "boolean", value: 1, evidence });
  const result = validateRecord(record, { K: { type: "boolean", required: true, requireEvidence: true }, M: { type: "boolean", required: true } });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [{ fieldId: "M", message: "Required field is missing." }]);
});

test("date helpers deterministically select clinical observations", () => {
  const values = [{ date: "2026-01-01", value: "old" }, { date: "2026-01-04", value: "closest" }, { date: "2026-01-06", value: "after" }];
  assert.equal(selectClosestBefore(values, "2026-01-05").value, "closest");
  assert.equal(selectFirstAfter(values, "2026-01-05").value, "after");
  assert.equal(selectFirstAfter(values, "2026-01-05", { maxDays: 0 }), null);
  assert.equal(hasDatesWithinDays([{ date: "2026-01-01" }, { date: "2026-01-08" }], 7), true);
});

test("Urolithiasis rules apply pre-op dates, cross fields, and post-op CT N/A values", () => {
  const record = createWorkflowRecord({ id: "record_2", mrn: "123", surgeryDate: "2026-01-10" });
  setRecordField(record, "V", { status: FieldStatus.FOUND, type: "boolean", value: 0, evidence });
  setRecordField(record, "BG", { status: FieldStatus.FOUND, type: "boolean", value: 0, evidence });
  applyUrolithiasisRules(record, {
    urineCultures: [
      { date: "2026-01-03", result: "Positive" },
      { date: "2026-01-08", result: "Positive" },
    ],
    postOpCtKub: [{ date: "2026-02-12", residualStone: true }],
    evidence: { AF: evidence, AI: evidence, AG: evidence, AH: evidence, P: evidence, Q: evidence, V: evidence, W: evidence, BG: evidence, BH: evidence, CS: evidence, CT: evidence, CU: evidence, CV: evidence, CW: evidence },
  });
  assert.equal(record.fields.AF.value, "Positive");
  assert.equal(record.fields.AI.value, "2026-01-08");
  assert.equal(record.fields.AH.value, 1);
  assert.equal(record.fields.P.value, 1);
  assert.equal(record.fields.Q.value, 1);
  assert.equal(record.fields.W.value, "N/A");
  assert.equal(record.fields.BH.value, "N/A");
  for (const field of ["CS", "CT", "CU", "CV", "CW"]) assert.equal(record.fields[field].value, "N/A");
});

test("Urolithiasis validation rejects broken deterministic cross-field rules", () => {
  const record = createWorkflowRecord({ id: "record_3", mrn: "123", surgeryDate: "2026-01-10" });
  setRecordField(record, "P", { status: FieldStatus.FOUND, type: "boolean", value: 1, evidence });
  setRecordField(record, "Q", { status: FieldStatus.FOUND, type: "boolean", value: 0, evidence });
  setRecordField(record, "V", { status: FieldStatus.FOUND, type: "boolean", value: 0, evidence });
  setRecordField(record, "W", { status: FieldStatus.NOT_APPLICABLE, type: "text", evidence });
  const result = validateUrolithiasisRecord(record);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.fieldId === "Q"));
});

test("review readiness keeps unresolved fields visible without hiding deterministic errors", () => {
  const record = createWorkflowRecord({ id: "record_review", mrn: "123", surgeryDate: "2026-01-10" });
  assert.equal(assessUrolithiasisReview(record).reviewReady, false);
  for (const [fieldId, definition] of Object.entries(UROLITHIASIS_FIELD_SCHEMA)) {
    setRecordField(record, fieldId, { status: FieldStatus.UNRESOLVED, type: definition.type, note: "No report found." });
  }
  const review = assessUrolithiasisReview(record);
  assert.equal(review.reviewReady, true);
  assert.ok(review.unresolved.includes("K"));

  setRecordField(record, "P", { status: FieldStatus.FOUND, type: "boolean", value: 1, evidence });
  setRecordField(record, "Q", { status: FieldStatus.FOUND, type: "boolean", value: 0, evidence });
  assert.equal(assessUrolithiasisReview(record).reviewReady, false);
});

test("run store persists atomically and exporters preserve audit provenance", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-store-"));
  try {
    const store = new WorkflowRunStore({ rootDir });
    const record = createWorkflowRecord({ id: "record_4", mrn: "123,45", surgeryDate: "2026-01-10" });
    setRecordField(record, "K", { status: FieldStatus.FOUND, type: "boolean", value: 1, evidence });
    const run = await store.create({ id: "run_test", profileId: "generic", records: [record] });
    const saved = await store.appendAudit(run.id, { type: "first_patient_reviewed" });
    assert.equal(saved.audit.at(-1).type, "first_patient_reviewed");
    assert.equal((await store.load("run_test")).records[0].mrn, "123,45");
    assert.equal((await store.list()).length, 1);

    const csv = exportRunToCsv(saved, { fieldSchema: { K: UROLITHIASIS_FIELD_SCHEMA.K } });
    assert.match(csv, /"123,45"/);
    const markdown = exportRecordToMarkdown(record, { fieldSchema: { K: UROLITHIASIS_FIELD_SCHEMA.K } });
    assert.match(markdown, /Lab 123/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
