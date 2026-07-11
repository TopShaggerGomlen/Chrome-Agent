import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOpen, validateRow, validateWorkbookId, validateExpected } from './workbook.js';

test('workbook schemas reject unknown properties and raw identifiers', () => {
  assert.throws(() => validateOpen({ pathAlias: 'main', extra: true }));
  assert.throws(() => validateOpen({ pathAlias: 'main', desktopPath: 'C:\\Desktop\\copy.xlsx' }));
  assert.throws(() => validateOpen({ pathAlias: 'C:\\secret.xlsx' }));
  assert.throws(() => validateWorkbookId('not opaque'));
  assert.throws(() => validateExpected({ rowHash: 'x', extra: 1 }));
});
test('write row accepts strict approval linkage only for writes', () => {
  const body = { workbookId: 'opaque_handle_1234', runId: 'r1', transactionId: 'tx1', patientNumber: 1, record: {}, approvalToken: 'token-1', diffHash: 'hash-1' };
  assert.equal(validateRow(body, { write: true }).diffHash, 'hash-1');
  assert.throws(() => validateRow({ ...body, approvalToken: '' }, { write: true }));
  assert.throws(() => validateRow({ ...body, diffHash: 42 }, { write: true }));
  assert.throws(() => validateRow({ ...body, transactionId: undefined }));
});

test('row mode accepts only normal or correction', () => {
  assert.equal(validateRow({ workbookId:'wb_1', runId:'run_1', patientNumber:1, record:{}, mode:'correction' }).mode, 'correction');
  assert.throws(() => validateRow({ workbookId:'wb_1', runId:'run_1', patientNumber:1, record:{}, mode:'overwrite' }));
});
test('row schema enforces complete transport shape', () => {
  const value = validateRow({ workbookId: 'opaque_handle_1234', runId: 'r1', patientNumber: 1, record: { K: 0 }, expected: { row: 4 } });
  assert.equal(value.patientNumber, 1);
  assert.throws(() => validateRow({ workbookId: 'opaque_handle_1234', runId: 'r1', patientNumber: 0, record: {} }));
  assert.throws(() => validateRow({ workbookId: 'opaque_handle_1234', runId: 'r1', patientNumber: 1, record: { A1: 'bad' } }));
});
