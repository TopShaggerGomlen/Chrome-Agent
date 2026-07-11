import express from 'express';
import crypto from 'node:crypto';
import { validateOpen, validateWorkbookId, validateRow, validateApproval, validateRecover, validateClose, validateExpected, patientNumber, validateMutationHeader, requiredString } from '../schemas/workbook.js';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v)).digest('hex');
const correlation = () => crypto.randomUUID();
const method = (service, names, ...args) => { for (const name of names) if (service && typeof service[name] === 'function') return service[name](...args); throw Object.assign(new Error('workbook service unavailable'), { code: 'WORKBOOK_NOT_FOUND', status: 503 }); };
const statusFor = code => ({ WORKBOOK_NOT_FOUND: 404, INVALID_WORKBOOK: 422, SCHEMA_MISMATCH: 422, ROW_IDENTITY_MISMATCH: 409, ROW_CONFLICT: 409, FORMULA_REJECTED: 422, WORKBOOK_LOCKED: 409, SAVE_FAILED: 500, SYNC_PENDING: 202, RECOVERY_REQUIRED: 409, STALE_WORKFLOW_RUN: 409, IDEMPOTENCY_CONFLICT: 409, APPROVAL_REQUIRED: 403, INVALID_REQUEST: 400 })[code] || 500;

/** Factory; authentication/origin is deliberately inherited from the parent app. */
export function createWorkbookRouter({ workbookService, service, runStore, logger = console, approvalService } = {}) {
  const wb = workbookService || service;
  if (!wb) throw new Error('workbookService is required');
  const router = express.Router();
  const idem = new Map();
  const sendError = (res, err, id) => {
    const code = err.code || 'INVALID_REQUEST';
    // Never echo adapter messages: they may contain workbook values or paths.
    const messages = { INVALID_REQUEST: 'Invalid workbook request', WORKBOOK_NOT_FOUND: 'Workbook not found', ROW_CONFLICT: 'Workbook row conflict', ROW_IDENTITY_MISMATCH: 'Workbook row identity mismatch', APPROVAL_REQUIRED: 'Approval required', IDEMPOTENCY_CONFLICT: 'Idempotency key conflict' };
    res.status(err.status || statusFor(code)).json({ error: messages[code] || 'Workbook request failed', code, retryable: Boolean(err.retryable), correlationId: id, ...(err.details ? { details: err.details } : {}) });
  };
  const invoke = async (res, req, fn) => {
    const id = correlation(); const started = Date.now();
    try { const result = await fn(); res.set('X-Correlation-Id', id); res.json({ correlationId: id, ...((result && typeof result === 'object') ? result : { result }) }); logger.info?.({ route: req.path, correlationId: id, outcome: 'ok', latencyMs: Date.now() - started }); }
    catch (err) { logger.warn?.({ route: req.path, correlationId: id, outcome: 'error', code: err.code || 'INVALID_REQUEST', latencyMs: Date.now() - started }); sendError(res, err, id); }
  };
  const mutation = (req, res, next, fn) => {
    let key; try { key = validateMutationHeader(req.get('Idempotency-Key')); } catch (e) { e.code = 'INVALID_REQUEST'; return sendError(res, e, correlation()); }
    const d = digest(req.body || {}); const old = idem.get(key);
    if (old) { if (old.digest !== d) return sendError(res, Object.assign(new Error('idempotency key reused with different request'), { code: 'IDEMPOTENCY_CONFLICT' }), correlation()); return res.status(old.status).json(old.body); }
    const original = res.json.bind(res); res.json = body => { idem.set(key, { digest: d, status: res.statusCode, body }); return original(body); }; invoke(res, req, fn).catch(next);
  };

  router.get('/status', (req, res) => invoke(res, req, () => method(wb, ['status', 'getStatus'])));
  router.post('/open', (req, res, next) => mutation(req, res, next, () => method(wb, ['open'], validateOpen(req.body))));
  router.get('/patients', (req, res) => invoke(res, req, () => { const id = validateWorkbookId(req.query.workbookId); return method(wb, ['patients', 'listPatients'], { workbookId: id }); }));
  router.get('/patients/:n', (req, res) => invoke(res, req, () => { const id = validateWorkbookId(req.query.workbookId); const n = patientNumber(Number(req.params.n)); return method(wb, ['patient', 'patientRow', 'getPatient'], { workbookId: id, patientNumber: n }); }));
  router.post('/validate-row', (req, res) => invoke(res, req, () => method(wb, ['validateRow', 'validate'], validateRow(req.body))));
  router.post('/write-row', (req, res, next) => mutation(req, res, next, () => method(wb, ['writeRow', 'write'], validateRow(req.body, { write: true }))));
  // approveRow records the user's decision. Token consumption belongs to the
  // subsequent transactional write, so a failed write remains safely retryable.
  router.post('/approve-row', (req, res, next) => mutation(req, res, next, () => method(wb, ['approveRow', 'approve'], validateApproval(req.body))));
  router.post('/recover', (req, res, next) => mutation(req, res, next, () => method(wb, ['recover', 'recoverTransaction'], validateRecover(req.body))));
  router.post('/close', (req, res, next) => mutation(req, res, next, () => method(wb, ['close', 'closeWorkbook'], validateClose(req.body))));
  return router;
}
export const workbookRouter = createWorkbookRouter;
export default createWorkbookRouter;
