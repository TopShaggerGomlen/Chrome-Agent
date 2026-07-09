import { createHash } from "node:crypto";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function patientRecordId({ mrn, surgeryDate, externalId }) {
  if (externalId) return externalId;
  const digest = createHash("sha256").update(`${mrn}\u0000${surgeryDate}`).digest("hex").slice(0, 16);
  return `patient_${digest}`;
}

/**
 * Parse a deliberately small queue format: MRN,YYYY-MM-DD[,externalId].
 * CSV quoting is intentionally unsupported so a pasted queue cannot silently
 * change how patients are identified.
 */
export function parsePatientQueue(input) {
  const records = [];
  const errors = [];
  const mrnAndDate = new Set();
  const externalIds = new Set();
  const lines = String(input ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;

    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length < 2 || cells.length > 3) {
      errors.push({ line: lineNumber, message: "Expected MRN,YYYY-MM-DD[,externalId]." });
      continue;
    }

    const [mrn, surgeryDate, externalId = ""] = cells;
    if (!mrn) {
      errors.push({ line: lineNumber, message: "MRN is required." });
      continue;
    }
    if (!isCalendarDate(surgeryDate)) {
      errors.push({ line: lineNumber, message: "Surgery date must be a real YYYY-MM-DD date." });
      continue;
    }

    const pair = `${mrn}\u0000${surgeryDate}`;
    if (mrnAndDate.has(pair)) {
      errors.push({ line: lineNumber, message: "MRN and surgery date duplicate an earlier queue record." });
      continue;
    }
    if (externalId && externalIds.has(externalId)) {
      errors.push({ line: lineNumber, message: "External ID duplicates an earlier queue record." });
      continue;
    }

    mrnAndDate.add(pair);
    if (externalId) externalIds.add(externalId);
    records.push({
      id: patientRecordId({ mrn, surgeryDate, externalId }),
      mrn,
      surgeryDate,
      ...(externalId ? { externalId } : {}),
      queueIndex: records.length,
    });
  }

  return { records, errors };
}

export function assertValidPatientQueue(input) {
  const parsed = parsePatientQueue(input);
  if (parsed.errors.length) {
    const details = parsed.errors.map((error) => `line ${error.line}: ${error.message}`).join(" ");
    throw new Error(`Invalid patient queue: ${details}`);
  }
  if (!parsed.records.length) throw new Error("Patient queue contains no records.");
  return parsed.records;
}

export { isCalendarDate };
