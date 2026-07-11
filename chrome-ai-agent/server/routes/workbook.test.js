import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createWorkbookRouter } from './workbook.js';

async function harness(service) {
  const app = express(); app.use(express.json()); app.use('/workbook', createWorkbookRouter({ workbookService: service, approvalService: service, logger: { info() {}, warn() {} } }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, resolve)); const port = server.address().port;
  return { server, request: async (path, options = {}) => { const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } }); return { status: response.status, body: await response.json() }; } };
}
const base = { workbookId: 'opaque_handle_1234', runId: 'run-1', patientNumber: 1, record: { K: 0 } };

test('all workbook routes delegate through injected service', async t => {
  const calls = []; const service = { status: () => ({ state: 'open' }), open: x => ({ workbookId: 'opaque_handle_1234', ...x }), patients: () => ({ patients: [] }), patient: () => ({ row: 4 }), validateRow: () => ({ valid: true }), writeRow: x => ({ status: 'written', transactionId: x.transactionId }), approveRow: () => ({ status: 'approved' }), recover: () => ({ state: 'recovered' }), close: () => ({ closed: true }) };
  for (const key of Object.keys(service)) { const fn = service[key]; if (typeof fn === 'function') service[key] = (...args) => { calls.push(key); return fn(...args); }; }
  const h = await harness(service); t.after(() => h.server.close());
  assert.equal((await h.request('/workbook/status')).status, 200);
  assert.equal((await h.request('/workbook/open', { method: 'POST', body: JSON.stringify({ pathAlias: 'main' }), headers: { 'Idempotency-Key': 'open-1' } })).status, 200);
  assert.equal((await h.request('/workbook/patients?workbookId=opaque_handle_1234')).status, 200);
  assert.equal((await h.request('/workbook/patients/1?workbookId=opaque_handle_1234')).status, 200);
  assert.equal((await h.request('/workbook/validate-row', { method: 'POST', body: JSON.stringify(base) })).status, 200);
  assert.equal((await h.request('/workbook/write-row', { method: 'POST', body: JSON.stringify({ ...base, transactionId: 'tx-1' }), headers: { 'Idempotency-Key': 'write-1' } })).status, 200);
  assert.equal((await h.request('/workbook/approve-row', { method: 'POST', body: JSON.stringify({ runId: 'run-1', patientNumber: 1, approvalToken: 'token' }), headers: { 'Idempotency-Key': 'approve-1' } })).status, 200);
  assert.equal((await h.request('/workbook/recover', { method: 'POST', body: JSON.stringify({ workbookId: base.workbookId, transactionId: 'tx-1', action: 'resume' }), headers: { 'Idempotency-Key': 'recover-1' } })).status, 200);
  assert.equal((await h.request('/workbook/close', { method: 'POST', body: JSON.stringify({ workbookId: base.workbookId }), headers: { 'Idempotency-Key': 'close-1' } })).status, 200);
  assert.ok(calls.length >= 9);
});

test('write forwards approval linkage and approve does not pre-consume token', async t => {
  let written; let verifies = 0;
  const service = {
    writeRow: body => { written = body; return { status: 'written', transactionId: body.transactionId }; },
    verifyApproval: () => { verifies += 1; return true; },
    approveRow: body => ({ status: 'approved', approvalToken: body.approvalToken }),
  };
  const h = await harness(service); t.after(() => h.server.close());
  const approved = await h.request('/workbook/approve-row', { method: 'POST', body: JSON.stringify({ runId: 'run-1', patientNumber: 1, approvalToken: 'token-exact' }), headers: { 'Idempotency-Key': 'approval-link' } });
  assert.equal(approved.status, 200); assert.equal(verifies, 0);
  const response = await h.request('/workbook/write-row', { method: 'POST', body: JSON.stringify({ ...base, transactionId: 'tx-link', approvalToken: 'token-exact', diffHash: 'diff-exact' }), headers: { 'Idempotency-Key': 'write-link' } });
  assert.equal(response.status, 200); assert.equal(written.approvalToken, 'token-exact'); assert.equal(written.diffHash, 'diff-exact'); assert.equal(verifies, 0);
});

test('open rejects desktop paths at transport boundary', async t => {
  let opens = 0; const h = await harness({ open: () => { opens += 1; return {}; } }); t.after(() => h.server.close());
  const response = await h.request('/workbook/open', { method: 'POST', body: JSON.stringify({ pathAlias: 'main', desktopPath: 'C:\\Desktop\\copy.xlsx' }), headers: { 'Idempotency-Key': 'desktop-path' } });
  assert.equal(response.status, 400); assert.equal(opens, 0);
});

test('mutations replay idempotently and reject digest conflicts; errors are redacted', async t => {
  const service = { open: () => ({ workbookId: 'opaque_handle_1234' }) }; const h = await harness(service); t.after(() => h.server.close());
  const one = await h.request('/workbook/open', { method: 'POST', body: JSON.stringify({ pathAlias: 'main' }), headers: { 'Idempotency-Key': 'same' } });
  const replay = await h.request('/workbook/open', { method: 'POST', body: JSON.stringify({ pathAlias: 'main' }), headers: { 'Idempotency-Key': 'same' } }); assert.equal(replay.status, 200); assert.equal(replay.body.correlationId, one.body.correlationId);
  const conflict = await h.request('/workbook/open', { method: 'POST', body: JSON.stringify({ pathAlias: 'other' }), headers: { 'Idempotency-Key': 'same' } }); assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
  const bad = await h.request('/workbook/open', { method: 'POST', body: JSON.stringify({ pathAlias: '../MRN-123' }), headers: { 'Idempotency-Key': 'bad' } }); assert.equal(bad.status, 400); assert.equal(bad.body.error, 'Invalid workbook request'); assert.doesNotMatch(JSON.stringify(bad.body), /MRN-123/);
});
