import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { canonicalizeWorkbookPath } from './path-policy.js';
import { WorkbookReader } from './reader.js';
import { ExcelJSAdapter } from './exceljs-adapter.js';
import { executeTransaction } from './transaction.js';
import { recoverTransactions, resumeRecovery, rollbackRecovery } from './recovery.js';
import { ALLOWLIST, normalizeValue } from './contract.js';

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const opaque = () => `wb_${crypto.randomBytes(18).toString('base64url')}`;
export const stableCheckpoint = ({ row, mrnHash, surgeryDateHash, fileHash, schemaFingerprint }) => ({ row, mrnHash, surgeryDateHash, fileHash, schemaFingerprint });

export class WorkbookService {
  constructor({ runStore, pathAliases = {}, allowedRoots = [], audit, backup, aliasConfig = process.env.WORKBOOK_PATH_ALIASES } = {}) {
    this.runStore = runStore; this.handles = new Map(); this.approvals = new Map(); this.audit = audit; this.backup = backup;
    let configured = pathAliases;
    if (aliasConfig) { try { configured = { ...configured, ...JSON.parse(aliasConfig) }; } catch { /* invalid secrets are ignored */ } }
    this.pathAliases = configured; this.allowedRoots = allowedRoots;
  }
  async _entry(id, runId) {
    let e = this.handles.get(id);
    // Opaque handles are intentionally not persisted. Rebind them safely from
    // the run's non-sensitive alias metadata after a backend restart.
    if (!e && runId && this.runStore) {
      try { const run = await this.runStore.load(runId); const alias = run.metadata?.pathAlias; if (alias) { const rebound = await this.open({ pathAlias: alias }); e = this.handles.get(rebound.workbookId); } } catch {}
    }
    if (!e) throw Object.assign(new Error('not found'), { code:'WORKBOOK_NOT_FOUND' }); return e;
  }
  async open({ pathAlias } = {}) {
    const configured = this.pathAliases[pathAlias];
    const input = typeof configured === 'string' ? configured : configured?.canonical;
    if (!input) throw Object.assign(new Error('path unavailable'), { code:'WORKBOOK_NOT_FOUND' });
    const canonical = await canonicalizeWorkbookPath(input, { allowedRoots:this.allowedRoots, basename: process.env.WORKBOOK_BASENAME });
    const reader = new WorkbookReader(canonical); await reader.open();
    let desktopPath = typeof configured === 'object' ? configured.desktop : process.env.WORKBOOK_DESKTOP_PATH;
    if (desktopPath) desktopPath = await canonicalizeWorkbookPath(desktopPath, { allowedRoots:this.allowedRoots, basename: process.env.WORKBOOK_BASENAME, allowMissing:true });
    let syncState = 'sync_pending';
    if (desktopPath) { try { const mirrorHash = crypto.createHash('sha256').update(await fs.readFile(desktopPath)).digest('hex'); syncState = mirrorHash === reader.fileHash ? 'synced' : 'sync_pending'; } catch {} }
    const id = opaque(); const entry = { id, canonical, desktopPath, pathAlias, reader, metadata: { ...reader.metadata(), pathAlias, syncState }, openedAt:new Date().toISOString() };
    this.handles.set(id, entry); return { workbookId:id, metadata:entry.metadata, queue:reader.patients() };
  }
  status() { const entries=[...this.handles.values()]; const e=entries[0]; if (!e) return { state:'closed' }; const syncState=e.metadata.syncState; return { state:syncState==='sync_pending'?'sync_pending':'synced', workbookId:e.id, metadata:e.metadata }; }
  async patients({ workbookId }) { const e=await this._entry(workbookId); await e.reader.open(); return { workbookId, patients:e.reader.patients(), fileHash:e.reader.fileHash }; }
  async patient({ workbookId, patientNumber }) { const e=await this._entry(workbookId); await e.reader.open(); return { workbookId, ...e.reader.patientRow(patientNumber) }; }
  _projectRecord(record = {}) {
    const projected = {}; const warnings = []; const evidence = {};
    for (const [column, field] of Object.entries(record)) {
      if (!ALLOWLIST.includes(column)) throw Object.assign(new Error('Unknown workbook column'), { code:'INVALID_REQUEST' });
      if (!field || typeof field !== 'object' || Array.isArray(field)) throw Object.assign(new Error('Invalid field value'), { code:'INVALID_REQUEST' });
      const status = field.status || 'found';
      if (!['found','not_applicable','unresolved'].includes(status)) throw Object.assign(new Error('Invalid field status'), { code:'INVALID_REQUEST' });
      let value = status === 'unresolved' ? null : (status === 'not_applicable' ? 'N/A' : field.value);
      try { value = normalizeValue(column, value).value; } catch (error) { error.code = error.code || 'INVALID_REQUEST'; throw error; }
      // Keep the transport and approval payload JSON-scalar. ExcelJS uses
      // Date instances internally, but exposing those leaks adapter details
      // and makes diff hashes unstable across process restarts.
      if (value instanceof Date) value = value.toISOString().slice(0, 10);
      projected[column] = value;
      if (Array.isArray(field.evidence) && field.evidence.length) evidence[column] = field.evidence.map(item => ({ source:item?.source, reference:item?.reference, url:item?.url, sourceDate:item?.sourceDate })).filter(item => item.source || item.reference || item.url);
      if (status !== 'found') warnings.push(`${column}: ${status}`);
    }
    return { projected, warnings, evidence };
  }
  async validateRow({ workbookId, runId, patientNumber, record, expected, mode='normal' }) { const e=await this._entry(workbookId, runId); await e.reader.open(); const row=e.reader.patientRow(patientNumber); if (expected && (expected.fileHash!==e.reader.fileHash || expected.schemaFingerprint!==e.reader.schemaFingerprint || expected.row!==row.row || expected.mrnHash!==row.mrnHash || expected.surgeryDateHash!==row.surgeryDateHash)) throw Object.assign(new Error('conflict'),{code:'ROW_CONFLICT'}); const p=this._projectRecord(record); const diff=Object.entries(p.projected).filter(([column,after])=>JSON.stringify(row.values[column])!==JSON.stringify(after)).map(([column,after])=>({column,row:row.row,before:row.values[column],after,evidence:p.evidence[column]||[]})); for(const d of diff) { if(d.before && typeof d.before==='object' && (d.before.formula||d.before.sharedFormula)) throw Object.assign(new Error('formula target'),{code:'FORMULA_REJECTED'}); const blank=d.before===null||d.before===undefined||d.before===''; if(!blank && mode!=='correction') throw Object.assign(new Error('conflict'),{code:'ROW_CONFLICT'}); } const checkpoint=stableCheckpoint({row:row.row,mrnHash:row.mrnHash,surgeryDateHash:row.surgeryDateHash,fileHash:e.reader.fileHash,schemaFingerprint:e.reader.schemaFingerprint}); const approval = runId && (mode==='correction' || diff.length>0) ? this.issueApproval({runId,workbookId,patientNumber,diff,expected:checkpoint,mode}) : null; return { valid:true, warnings:p.warnings, diff, mode, ...(approval||{}), expected:checkpoint }; }
  _approvalKey(runId, patientNumber, diffHash) { return `${runId}:${patientNumber}:${diffHash}`; }
  issueApproval({ runId, workbookId, patientNumber, diff, expected, mode='normal' }) { const token=crypto.randomBytes(24).toString('base64url'); const tokenHash=sha(token); const diffHash=sha(JSON.stringify(diff)); this.approvals.set(tokenHash,{tokenHash,runId,workbookId,patientNumber,diffHash,expected,mode,state:'issued',expiresAt:Date.now()+10*60_000}); return { approvalToken:token, diffHash }; }
  _approval(token) { return this.approvals.get(sha(token)); }
  verifyApproval(token, { runId, workbookId, patientNumber, diffHash, expected } = {}) { const a=this._approval(token); return Boolean(a&&a.state!=='consumed'&&a.expiresAt>Date.now()&&a.runId===runId&&(!workbookId||a.workbookId===workbookId)&&a.patientNumber===patientNumber&&(!diffHash||a.diffHash===diffHash)&&(!expected||JSON.stringify(a.expected)===JSON.stringify(expected))); }
  async approveRow({ runId, patientNumber, approvalToken }) { const a=this._approval(approvalToken); if (!this.verifyApproval(approvalToken,{runId,patientNumber})) throw Object.assign(new Error('approval'),{code:'APPROVAL_REQUIRED'}); a.state='approved'; if(this.runStore){const run=await this.runStore.load(runId); run.metadata={...(run.metadata||{}),firstRecordApproved:true,pathAlias:run.metadata?.pathAlias || this.handles.get(a.workbookId)?.metadata?.pathAlias,approval:{tokenHash:a.tokenHash,diffHash:a.diffHash,expected:a.expected,workbookId:a.workbookId,patientNumber,mode:a.mode}}; run.audit=[...(run.audit||[]),{type:'first_record_approved',patientNumber,mode:a.mode,at:new Date().toISOString()}]; await this.runStore.save(run);} return {status:'approved',runId,patientNumber}; }
  async writeRow({ workbookId, runId, transactionId, patientNumber, record, expected, approvalToken, diffHash, mode='normal' }) { const e=await this._entry(workbookId, runId); if(!e.desktopPath) throw Object.assign(new Error('mirror required'),{code:'SYNC_PENDING'}); const p=this._projectRecord(record); await e.reader.open(); const changed=await e.reader.externalChange(); if(changed.changed) throw Object.assign(new Error('external change'),{code:'ROW_CONFLICT'}); const row=e.reader.patientRow(patientNumber); const checkpoint=stableCheckpoint({row:row.row,mrnHash:row.mrnHash,surgeryDateHash:row.surgeryDateHash,fileHash:e.reader.fileHash,schemaFingerprint:e.reader.schemaFingerprint}); if(expected && (expected.fileHash!==checkpoint.fileHash || expected.schemaFingerprint!==checkpoint.schemaFingerprint || !e.reader.compareCheckpoint({...expected,rowHash:row.rowHash},patientNumber))) throw Object.assign(new Error('conflict'),{code:'ROW_CONFLICT'}); const diff=Object.entries(p.projected).filter(([column,after])=>JSON.stringify(row.values[column])!==JSON.stringify(after)).map(([column,after])=>({column,row:row.row,before:row.values[column],after,evidence:p.evidence[column]||[]})); for(const d of diff) { if(d.before && typeof d.before==='object' && (d.before.formula||d.before.sharedFormula)) throw Object.assign(new Error('formula target'),{code:'FORMULA_REJECTED'}); const blank=d.before===null||d.before===undefined||d.before===''; if(!blank && mode!=='correction') throw Object.assign(new Error('conflict'),{code:'ROW_CONFLICT'}); } const a=this._approval(approvalToken); const needsApproval=Boolean(diff.length && (patientNumber===1 || mode==='correction')); if(needsApproval && (!a || a.state!=='approved' || !approvalToken || !diffHash || !expected || !this.verifyApproval(approvalToken,{runId,workbookId,patientNumber,diffHash,expected}) || a.mode!==mode || sha(JSON.stringify(diff))!==diffHash)) throw Object.assign(new Error('approval'),{code:'APPROVAL_REQUIRED'}); const adapter=new ExcelJSAdapter(e.canonical); const auditPatch=diff.map(x=>({...x,patient:patientNumber,approval:needsApproval?'approved':undefined})); const result=await executeTransaction({canonicalPath:e.canonical,desktopPath:e.desktopPath,transactionId,patch:auditPatch,backup:this.backup, audit:this.audit,write:async temp=>{const staged=await adapter.stageWrite({row:row.row,record:p.projected}); await staged.workbook.xlsx.writeFile(temp);},verify:async temp=>{const check=new ExcelJSAdapter(temp); await check.load();}}); if(a&&result.sync?.state==='synced') a.state='consumed'; e.metadata.syncState=result.sync?.state||'sync_pending'; if(runId&&this.runStore){const run=await this.runStore.load(runId); run.metadata={...(run.metadata||{}),pathAlias:e.metadata.pathAlias,workbookWriteSynced:result.sync?.state==='synced',workbookTransactionStatus:result.sync?.state||'sync_pending',workbookLastTransactionId:transactionId}; await this.runStore.save(run);} await e.reader.open(); return {status:result.sync?.state||'sync_pending',transactionId,diff,hashes:{beforeHash:result.beforeHash,afterHash:result.afterHash},sync:result.sync}; }
  async recover({ workbookId, transactionId, action, runId }) { const e=await this._entry(workbookId, runId); const found=(await recoverTransactions(path.dirname(e.canonical), { quarantine:false })).find(x=>x.transactionId===transactionId); if(!found) throw Object.assign(new Error('recovery required'),{code:'RECOVERY_REQUIRED'}); let state=found.state; if(action==='resume') { const r=await resumeRecovery(found,{sync:true}); state=r.state; } else if(action==='rollback') { const r=await rollbackRecovery(found); state=r.state; } else if(action==='quarantine') { if(found.journal) await fs.rename(found.journal, `${found.journal}.quarantine-${Date.now()}`).catch(()=>{}); state='quarantined'; } if(this.runStore&&runId){ const run=await this.runStore.load(runId); run.status=state==='synced'?'synced':state==='sync_pending'?'sync_pending':state==='rolled_back'?'rolled_back':'recovery_required'; run.metadata={...(run.metadata||{}),pathAlias:e.metadata.pathAlias,recovery:{transactionId,action,state}}; await this.runStore.save(run); } return { state, transactionId, action }; }
  async close({ workbookId }) { this.handles.delete(workbookId); return { closed:true, workbookId }; }
}
