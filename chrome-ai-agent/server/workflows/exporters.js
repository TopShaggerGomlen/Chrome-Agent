import { fieldDisplayValue } from "./records.js";

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportRunToCsv(run, { fieldSchema = {} } = {}) {
  const fields = Object.keys(fieldSchema);
  const header = ["record_id", "external_id", "mrn", "surgery_date", ...fields];
  const lines = [header.map(csvCell).join(",")];
  for (const record of run.records ?? []) {
    const row = [record.id, record.externalId ?? "", record.mrn, record.surgeryDate, ...fields.map((field) => fieldDisplayValue(record.fields?.[field]))];
    lines.push(row.map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function exportRecordToMarkdown(record, { fieldSchema = {} } = {}) {
  const fields = Object.keys(fieldSchema);
  const lines = [
    `## Record ${record.id}`,
    "",
    `- MRN: ${record.mrn}`,
    `- Surgery date: ${record.surgeryDate}`,
    `- Phase: ${record.phase}`,
    "",
    "| Field | Status | Value | Evidence |",
    "| --- | --- | --- | --- |",
  ];
  for (const fieldId of fields) {
    const field = record.fields?.[fieldId];
    const sources = (field?.evidence ?? []).map((evidence) => evidence.reference ?? evidence.source).join("; ");
    lines.push(`| ${fieldId} | ${field?.status ?? "unresolved"} | ${markdownCell(fieldDisplayValue(field))} | ${markdownCell(sources)} |`);
  }
  if (record.warnings?.length) lines.push("", "### Warnings", ...record.warnings.map((warning) => `- ${warning}`));
  return `${lines.join("\n")}\n`;
}

export function exportRunToMarkdown(run, options = {}) {
  return [
    `# Workflow run ${run.id}`,
    "",
    `Profile: ${run.profileId}`,
    `Status: ${run.status}`,
    "",
    ...(run.records ?? []).map((record) => exportRecordToMarkdown(record, options).trimEnd()),
    "",
  ].join("\n");
}
