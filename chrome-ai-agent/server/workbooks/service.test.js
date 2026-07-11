import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbookService } from './service.js';

test('workbook service keeps opaque handles and binds one-time approvals', async () => {
  const service = new WorkbookService({ pathAliases: { main: 'C:/missing.xlsx' } });
  assert.match(service.issueApproval({ runId: 'run-1', patientNumber: 1, diff: [{ column: 'K', after: 1 }] }).approvalToken, /^[A-Za-z0-9_-]+$/);
  const token = service.issueApproval({ runId: 'run-1', patientNumber: 1, diff: [] }).approvalToken;
  assert.equal(service.verifyApproval(token, { runId: 'run-1', patientNumber: 1 }), true);
  assert.equal(service.verifyApproval(token, { runId: 'run-2', patientNumber: 1 }), false);
  await service.approveRow({ runId: 'run-1', patientNumber: 1, approvalToken: token });
  assert.equal(service.verifyApproval(token, { runId: 'run-1', patientNumber: 1 }), true);
});

test('status is closed before open and configured aliases are not exposed', () => {
  const service = new WorkbookService({ pathAliases: { main: 'C:/secret.xlsx' } });
  assert.deepEqual(service.status(), { state: 'closed' });
});

test('approval tokens bind correction mode and exact diff', () => {
  const service = new WorkbookService();
  const issued = service.issueApproval({ runId:'run-c', workbookId:'wb-c', patientNumber:2, mode:'correction', diff:[{ column:'K', before:1, after:0 }], expected:{ row:5 } });
  assert.equal(service.verifyApproval(issued.approvalToken, { runId:'run-c', workbookId:'wb-c', patientNumber:2, diffHash:issued.diffHash, expected:{ row:5 } }), true);
  assert.equal(service.verifyApproval(issued.approvalToken, { runId:'run-c', workbookId:'wb-c', patientNumber:2, diffHash:'wrong' }), false);
  assert.equal(service._approval(issued.approvalToken).mode, 'correction');
});

test('projection preserves numeric zero as a nonblank target value', () => {
  const service = new WorkbookService();
  assert.equal(service._projectRecord({ K:{ status:'found', value:0 } }).projected.K, 0);
});
