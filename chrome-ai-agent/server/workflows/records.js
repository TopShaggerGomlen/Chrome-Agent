import { isCalendarDate } from "./queue.js";

export const FieldStatus = Object.freeze({
  FOUND: "found",
  NOT_APPLICABLE: "not_applicable",
  UNRESOLVED: "unresolved",
});

export const ValueType = Object.freeze({
  BOOLEAN: "boolean",
  DATE: "date",
  NUMBER: "number",
  TEXT: "text",
  ENUM: "enum",
});

const VALID_STATUSES = new Set(Object.values(FieldStatus));
const VALID_TYPES = new Set(Object.values(ValueType));

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function createEvidence(input = {}) {
  const source = String(input.source ?? "").trim();
  if (!source) throw new Error("Evidence source is required.");
  const evidence = {
    source,
    ...(input.sourceDate ? { sourceDate: String(input.sourceDate) } : {}),
    ...(input.url ? { url: String(input.url) } : {}),
    ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
    ...(input.reference ? { reference: String(input.reference) } : {}),
    ...(input.snippet ? { snippet: String(input.snippet) } : {}),
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
  if (evidence.sourceDate && !isCalendarDate(evidence.sourceDate)) {
    throw new Error("Evidence sourceDate must be YYYY-MM-DD.");
  }
  return evidence;
}

function validateValue(value, type, allowedValues) {
  if (type === ValueType.BOOLEAN && value !== 0 && value !== 1) return "must be 0 or 1";
  if (type === ValueType.DATE && (!isCalendarDate(String(value)))) return "must be a YYYY-MM-DD date";
  if (type === ValueType.NUMBER && (typeof value !== "number" || !Number.isFinite(value))) return "must be a finite number";
  if ((type === ValueType.TEXT || type === ValueType.ENUM) && (typeof value !== "string" || !value.trim())) return "must be non-empty text";
  if (type === ValueType.ENUM && allowedValues?.length && !allowedValues.includes(value)) return `must be one of: ${allowedValues.join(", ")}`;
  return null;
}

export function createFieldValue({ status = FieldStatus.UNRESOLVED, value, type = ValueType.TEXT, evidence = [], note } = {}) {
  if (!VALID_STATUSES.has(status)) throw new Error(`Unknown field status: ${status}`);
  if (!VALID_TYPES.has(type)) throw new Error(`Unknown value type: ${type}`);
  if (!Array.isArray(evidence)) throw new Error("Field evidence must be an array.");
  const normalizedEvidence = evidence.map(createEvidence);

  if (status === FieldStatus.UNRESOLVED) {
    if (value !== undefined && value !== null && value !== "") throw new Error("Unresolved fields cannot have a value.");
    return { status, type, evidence: normalizedEvidence, ...(note ? { note: String(note) } : {}) };
  }

  const expected = status === FieldStatus.NOT_APPLICABLE ? "N/A" : value;
  if (status === FieldStatus.NOT_APPLICABLE && value !== undefined && value !== "N/A") {
    throw new Error('Not-applicable fields must use the value "N/A".');
  }
  const error = validateValue(expected, type === ValueType.ENUM ? type : type);
  if (error && !(status === FieldStatus.NOT_APPLICABLE && expected === "N/A")) throw new Error(`Field value ${error}.`);
  return { status, type, value: expected, evidence: normalizedEvidence, ...(note ? { note: String(note) } : {}) };
}

export function createWorkflowRecord(input = {}) {
  if (!input.id || !input.mrn || !isCalendarDate(String(input.surgeryDate))) {
    throw new Error("Workflow record requires id, MRN, and surgeryDate.");
  }
  return {
    id: String(input.id),
    mrn: String(input.mrn),
    surgeryDate: String(input.surgeryDate),
    ...(input.externalId ? { externalId: String(input.externalId) } : {}),
    ...(Number.isInteger(input.queueIndex) ? { queueIndex: input.queueIndex } : {}),
    ...(Number.isInteger(input.queueIndex) ? { queueIndex: input.queueIndex } : {}),
    phase: input.phase ?? "queued",
    fields: input.fields ?? {},
    warnings: input.warnings ?? [],
    audit: input.audit ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

export function setRecordField(record, fieldId, fieldValue) {
  if (!record || !fieldId) throw new Error("Record and field ID are required.");
  const next = createFieldValue(fieldValue);
  record.fields = { ...record.fields, [fieldId]: next };
  record.updatedAt = new Date().toISOString();
  return next;
}

export function fieldDisplayValue(field) {
  if (!field || field.status === FieldStatus.UNRESOLVED) return "";
  return field.value;
}

export function validateRecord(record, fieldSchema = {}) {
  const errors = [];
  for (const [fieldId, definition] of Object.entries(fieldSchema)) {
    const field = record.fields?.[fieldId];
    if (!field) {
      if (definition.required) errors.push({ fieldId, message: "Required field is missing." });
      continue;
    }
    if (!VALID_STATUSES.has(field.status)) {
      errors.push({ fieldId, message: `Unknown status: ${field.status}` });
      continue;
    }
    if (field.type !== definition.type) errors.push({ fieldId, message: `Expected ${definition.type} type.` });
    if (field.status === FieldStatus.UNRESOLVED && definition.required) errors.push({ fieldId, message: "Required field is unresolved." });
    if (field.status === FieldStatus.FOUND) {
      const issue = validateValue(field.value, definition.type, definition.allowedValues);
      if (issue) errors.push({ fieldId, message: issue });
      if (definition.requireEvidence && !field.evidence?.length) errors.push({ fieldId, message: "Evidence is required." });
    }
    if (field.status === FieldStatus.NOT_APPLICABLE && field.value !== "N/A") errors.push({ fieldId, message: 'Not-applicable value must be "N/A".' });
  }
  return { valid: errors.length === 0, errors };
}

export function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

export { hasOwn };
