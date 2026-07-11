import { FieldStatus, ValueType, createFieldValue, fieldDisplayValue, setRecordField, validateRecord } from "./records.js";
import { isCalendarDate } from "./queue.js";

export const UROLITHIASIS_PROFILE_ID = "urolithiasis-v3";

const bool = { type: ValueType.BOOLEAN, required: true, requireEvidence: true };
const text = { type: ValueType.TEXT, required: true, requireEvidence: true };
const date = { type: ValueType.DATE, required: true, requireEvidence: true };

// Field IDs are the existing study workbook column letters; this keeps an
// adapter's export mapping explicit without coupling the shared engine to Excel.
export const UROLITHIASIS_FIELD_SCHEMA = Object.freeze({
  K: bool, M: bool, N: bool, V: bool, W: text, P: bool, Q: bool, R: bool,
  L: { ...text }, AF: { type: ValueType.ENUM, required: true, requireEvidence: true, allowedValues: ["Positive", "Negative"] }, AI: date, AH: bool,
  AG: bool, AD: text, AE: text, AC: text, AB: bool, AA: date,
  BF: bool, BG: bool, BH: text, AL: date,
  S: text, T: { ...date }, X: bool, Y: { type: ValueType.NUMBER, required: true, requireEvidence: true },
  CE: { type: ValueType.NUMBER, required: true, requireEvidence: true }, BP: bool, BO: bool,
  CS: text, CT: { ...date }, CU: { ...bool }, CV: text, CW: { ...bool }, CN: bool, CO: text,
});

function toDateNumber(value) {
  if (!isCalendarDate(String(value))) return Number.NaN;
  return Date.parse(`${value}T00:00:00.000Z`);
}

function itemDate(item, dateField) {
  return typeof item === "string" ? item : item?.[dateField];
}

export function selectClosestBefore(items, anchorDate, { dateField = "date" } = {}) {
  const anchor = toDateNumber(anchorDate);
  if (!Number.isFinite(anchor)) throw new Error("Anchor date must be YYYY-MM-DD.");
  return (items ?? []).filter((item) => {
    const candidate = toDateNumber(itemDate(item, dateField));
    return Number.isFinite(candidate) && candidate <= anchor;
  }).sort((a, b) => toDateNumber(itemDate(b, dateField)) - toDateNumber(itemDate(a, dateField)))[0] ?? null;
}

export function selectFirstAfter(items, anchorDate, { dateField = "date", maxDays = Infinity } = {}) {
  const anchor = toDateNumber(anchorDate);
  if (!Number.isFinite(anchor)) throw new Error("Anchor date must be YYYY-MM-DD.");
  return (items ?? []).filter((item) => {
    const candidate = toDateNumber(itemDate(item, dateField));
    const distance = (candidate - anchor) / 86_400_000;
    return Number.isFinite(candidate) && distance > 0 && distance <= maxDays;
  }).sort((a, b) => toDateNumber(itemDate(a, dateField)) - toDateNumber(itemDate(b, dateField)))[0] ?? null;
}

export function hasDatesWithinDays(items, days, { dateField = "date" } = {}) {
  const dates = (items ?? []).map((item) => toDateNumber(itemDate(item, dateField))).filter(Number.isFinite).sort((a, b) => a - b);
  return dates.some((value, index) => index > 0 && value - dates[index - 1] <= days * 86_400_000);
}

export function recurringUtiValue(cultures, surgeryDate) {
  const dated = (cultures ?? []).filter((culture) => isCalendarDate(String(culture?.date)) && toDateNumber(culture.date) <= toDateNumber(surgeryDate))
    .sort((a, b) => toDateNumber(b.date) - toDateNumber(a.date));
  return dated[0]?.result === "Positive" && dated[1]?.result === "Positive" ? 1 : 0;
}

function statusFor(value, type, evidence = []) {
  return value === "N/A"
    ? createFieldValue({ status: FieldStatus.NOT_APPLICABLE, type, evidence })
    : createFieldValue({ status: FieldStatus.FOUND, value, type, evidence });
}

/**
 * Apply rules which are fully determined by already extracted, structured
 * observations. This function never guesses values or marks absent evidence as
 * N/A; missing source observations remain unresolved for human review.
 */
export function applyUrolithiasisRules(record, observations = {}) {
  const surgeryDate = observations.surgeryDate ?? record.surgeryDate;
  if (!isCalendarDate(String(surgeryDate))) throw new Error("Record surgery date must be YYYY-MM-DD.");
  const evidence = observations.evidence ?? {};
  const set = (field, value, type = UROLITHIASIS_FIELD_SCHEMA[field]?.type) => {
    if (value === undefined || value === null) return;
    setRecordField(record, field, statusFor(value, type, evidence[field] ?? []));
  };

  if (Array.isArray(observations.urineCultures)) {
    const preopCulture = selectClosestBefore(observations.urineCultures, surgeryDate);
    if (preopCulture) {
      set("AF", preopCulture.result);
      set("AI", preopCulture.date, ValueType.DATE);
      set("AG", preopCulture.result === "Negative" ? "N/A" : 1);
    }
    set("AH", hasDatesWithinDays(observations.urineCultures, 7) ? 1 : 0);
    set("P", recurringUtiValue(observations.urineCultures, surgeryDate));
  }
  if (record.fields?.P) set("Q", fieldDisplayValue(record.fields.P), ValueType.BOOLEAN);
  if (record.fields?.V) set("W", fieldDisplayValue(record.fields.V) === 1 ? "Tamsulosin" : "N/A");
  if (record.fields?.BG) set("BH", fieldDisplayValue(record.fields.BG) === 1 ? observations.anomalyType : "N/A");

  if (Array.isArray(observations.postOpCtKub)) {
    const postOpCt = selectFirstAfter(observations.postOpCtKub, surgeryDate, { maxDays: 30 });
    if (!postOpCt) {
      for (const field of ["CS", "CT", "CU", "CV", "CW"]) set(field, "N/A", UROLITHIASIS_FIELD_SCHEMA[field].type);
    } else {
      set("CS", postOpCt.imageType ?? "CT KUB");
      set("CT", postOpCt.date, ValueType.DATE);
      set("CU", postOpCt.residualStone ? 1 : 0);
      set("CV", postOpCt.residualStone ? postOpCt.residualStoneSize : "N/A");
      set("CW", postOpCt.hydronephrosis ? 1 : 0);
    }
  }
  return record;
}

export function validateUrolithiasisRecord(record) {
  const base = validateRecord(record, UROLITHIASIS_FIELD_SCHEMA);
  const errors = [...base.errors];
  const value = (field) => fieldDisplayValue(record.fields?.[field]);
  const resolved = (field) => record.fields?.[field] && record.fields[field].status !== FieldStatus.UNRESOLVED;
  if (resolved("P") && resolved("Q") && value("Q") !== value("P")) errors.push({ fieldId: "Q", message: "Recent antibiotics (Q) must equal recurrent UTI (P)." });
  if (resolved("V") && resolved("W") && value("W") !== (value("V") === 1 ? "Tamsulosin" : "N/A")) errors.push({ fieldId: "W", message: "Prostatic medications (W) must follow BPH (V)." });
  if (resolved("BG") && resolved("BH") && value("BG") === 0 && value("BH") !== "N/A") errors.push({ fieldId: "BH", message: "Specify anomaly (BH) must be N/A when no anomaly is present." });
  const postOpFields = ["CS", "CT", "CU", "CV", "CW"];
  const resolvedPostOpFields = postOpFields.filter(resolved);
  if (resolvedPostOpFields.some((field) => value(field) === "N/A") && resolvedPostOpFields.some((field) => value(field) !== "N/A" && value(field) !== "")) {
    errors.push({ fieldId: "CS", message: "All post-operative imaging fields must be N/A when no CT KUB is found." });
  }
  return { valid: errors.length === 0, errors };
}

export function assessUrolithiasisReview(record) {
  const validation = validateUrolithiasisRecord(record);
  const missing = Object.keys(UROLITHIASIS_FIELD_SCHEMA)
    .filter(fieldId => !record.fields?.[fieldId]);
  const unresolved = Object.entries(UROLITHIASIS_FIELD_SCHEMA)
    .filter(([fieldId]) => record.fields?.[fieldId]?.status === FieldStatus.UNRESOLVED)
    .map(([fieldId]) => fieldId);
  const blockingErrors = validation.errors.filter(error =>
    !/Required field is (missing|unresolved)\./.test(error.message)
  );
  const foundFields = Object.values(record.fields || {}).filter(field => field?.status === FieldStatus.FOUND);
  const evidencedFields = foundFields.filter(field => Array.isArray(field.evidence) && field.evidence.length > 0);

  return {
    ...validation,
    reviewReady: missing.length === 0 && blockingErrors.length === 0,
    blockingErrors,
    missing,
    unresolved,
    foundFieldCount: foundFields.length,
    unresolvedFieldCount: unresolved.length,
    evidenceCoveragePercent: foundFields.length ? Math.round((evidencedFields.length / foundFields.length) * 100) : 0
  };
}
