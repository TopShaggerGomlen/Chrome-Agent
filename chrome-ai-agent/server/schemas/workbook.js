// Small dependency-free validators for the workbook API.  These intentionally
// reject unknown keys so routes never accidentally accept an expanded payload.
export const WORKBOOK_ID = /^[A-Za-z0-9_-]{4,128}$/;
export const PATH_ALIAS = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
export const ACTIONS = new Set(['rollback', 'resume', 'quarantine']);

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
export function assertObject(value, allowed, name = 'body') {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown ${name} property`);
  return value;
}
export function requiredString(value, name, { pattern, max = 256 } = {}) {
  if (typeof value !== 'string' || !value || value.length > max || (pattern && !pattern.test(value))) throw new Error(`invalid ${name}`);
  return value;
}
export function patientNumber(value) {
  if (!Number.isInteger(value) || value < 1) throw new Error('invalid patientNumber');
  return value;
}
export function validateExpected(value) {
  if (value === undefined) return undefined;
  assertObject(value, new Set(['row', 'mrnHash', 'surgeryDateHash', 'rowHash', 'fileHash', 'schemaFingerprint']), 'expected');
  if (value.row !== undefined && (!Number.isInteger(value.row) || value.row < 1)) throw new Error('invalid expected.row');
  for (const key of ['mrnHash', 'surgeryDateHash', 'rowHash', 'fileHash', 'schemaFingerprint']) if (value[key] !== undefined) requiredString(value[key], `expected.${key}`, { max: 256 });
  return value;
}
export function validateWorkbookId(value) { return requiredString(value, 'workbookId', { pattern: WORKBOOK_ID, max: 128 }); }
export function validatePathAlias(value) { return requiredString(value, 'pathAlias', { pattern: PATH_ALIAS, max: 64 }); }
export function validateMutationHeader(value) { return requiredString(value, 'Idempotency-Key', { max: 200 }); }
export function validateRecord(value) {
  if (!isObject(value)) throw new Error('record must be an object');
  // The service owns the column allowlist and value policy; this only prevents
  // prototype pollution and non-JSON values at the transport boundary.
  for (const key of Object.keys(value)) if (!/^[A-Z]{1,3}$/.test(key)) throw new Error('invalid record column');
  return value;
}
export function validateOpen(body) {
  assertObject(body, new Set(['pathAlias']), 'body');
  validatePathAlias(body.pathAlias);
  return body;
}
export function validateRow(body, { write = false } = {}) {
  const allowed = new Set(['workbookId', 'runId', 'transactionId', 'patientNumber', 'record', 'expected', ...(write ? ['approvalToken', 'diffHash', 'mode'] : []), ...(!write ? ['mode'] : [])]);
  assertObject(body, allowed, 'body');
  validateWorkbookId(body.workbookId); requiredString(body.runId, 'runId', { max: 128 }); patientNumber(body.patientNumber);
  if (write) requiredString(body.transactionId, 'transactionId', { max: 128 });
  if (body.approvalToken !== undefined) requiredString(body.approvalToken, 'approvalToken', { max: 512 });
  if (body.diffHash !== undefined) requiredString(body.diffHash, 'diffHash', { max: 256 });
  if (body.mode !== undefined && !['normal','correction'].includes(body.mode)) throw new Error('invalid mode');
  validateRecord(body.record); validateExpected(body.expected); return body;
}
export function validateApproval(body) {
  assertObject(body, new Set(['runId', 'patientNumber', 'approvalToken']), 'body');
  requiredString(body.runId, 'runId', { max: 128 }); patientNumber(body.patientNumber); requiredString(body.approvalToken, 'approvalToken', { max: 512 }); return body;
}
export function validateRecover(body) {
  assertObject(body, new Set(['workbookId', 'transactionId', 'action', 'runId']), 'body'); validateWorkbookId(body.workbookId); requiredString(body.transactionId, 'transactionId', { max: 128 }); if (body.runId !== undefined) requiredString(body.runId, 'runId', { max: 128 });
  if (!ACTIONS.has(body.action)) throw new Error('invalid action'); return body;
}
export function validateClose(body) { assertObject(body, new Set(['workbookId']), 'body'); validateWorkbookId(body.workbookId); return body; }
