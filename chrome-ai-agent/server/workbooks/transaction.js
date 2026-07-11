import fs from "node:fs/promises";
import path from "node:path";
import crypto, { randomUUID } from "node:crypto";
import { WorkbookLock } from "./lock.js";
import { createBackup } from "./backup.js";
import { syncCanonicalToDesktop } from "./sync.js";
import { AuditStore } from "./audit-store.js";
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
const fileHash = async file => sha(await fs.readFile(file));
async function journalWrite(file, value) { const h = await fs.open(file, "w", 0o600); try { await h.writeFile(JSON.stringify(value)); await h.sync().catch(() => {}); } finally { await h.close(); } }

export async function executeTransaction({ canonicalPath, desktopPath, transactionId = randomUUID(), patch, write, verify, journalPath, backup = {}, lock = {}, audit, fault } = {}) {
  if (!canonicalPath || typeof write !== "function") throw Object.assign(new Error("canonicalPath and write callback are required"), { code: "TRANSACTION_INVALID" });
  const lockHandle = new WorkbookLock(canonicalPath, lock); await lockHandle.acquire();
  const temp = `${canonicalPath}.${transactionId}.tmp`; const journal = journalPath ?? `${canonicalPath}.${transactionId}.journal.json`; const requestDigest = sha(JSON.stringify(patch ?? null));
  try {
    try {
      const prior = JSON.parse(await fs.readFile(journal, "utf8"));
      if (prior.transactionId === transactionId) {
        // A caller retrying a completed write may omit the original patch.  A
        // supplied patch, however, must match exactly or this key is unsafe to
        // replay for a different request.
        if (patch !== undefined && prior.requestDigest !== requestDigest) {
          throw Object.assign(new Error("Transaction request digest conflict"), { code: "TRANSACTION_DIGEST_CONFLICT", retryable: false });
        }
        if (["synced", "sync_pending"].includes(prior.phase)) return prior.result ?? prior;
      }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    const beforeHash = await fileHash(canonicalPath);
    let desktopBeforeHash = null;
    if (desktopPath) { try { desktopBeforeHash = await fileHash(desktopPath); } catch (e) { if (e.code !== "ENOENT") throw e; } }
    const base = { transactionId, requestDigest, canonicalPath, desktopPath, temp, beforeHash, desktopBeforeHash, patch };
    await journalWrite(journal, { ...base, phase: "prepared" }); if (fault === "before-temp") throw Object.assign(new Error("Injected failure before temp save"), { code: "INJECTED" });
    await write(temp, canonicalPath); if (fault === "after-temp") throw Object.assign(new Error("Injected failure after temp save"), { code: "INJECTED" });
    // Ensure a callback that leaves an open descriptor still has durable bytes
    // before verification/replacement.  (Normal adapters close their file.)
    const tempHandle = await fs.open(temp, "r"); await tempHandle.sync().catch(() => {}); await tempHandle.close();
    const tempHash = await fileHash(temp); if (verify) { const verified = await verify(temp, canonicalPath); if (verified && typeof verified === "string" && verified !== tempHash) throw new Error("Temporary workbook hash mismatch"); } else await fs.access(temp);
    await journalWrite(journal, { ...base, tempHash, phase: "temp_verified" });
    const backupInfo = await createBackup(canonicalPath, backup); await journalWrite(journal, { ...base, tempHash, backup: backupInfo, phase: "backed_up" }); if (fault === "before-replace") throw Object.assign(new Error("Injected failure before replace"), { code: "INJECTED" });
    const rollback = `${canonicalPath}.${transactionId}.rollback`;
    try { await fs.rename(temp, canonicalPath); } catch (e) {
      try { await fs.rename(canonicalPath, rollback); await fs.rename(temp, canonicalPath); await fs.rm(rollback, { force: true }); } catch (replaceError) { await fs.rename(rollback, canonicalPath).catch(() => {}); throw replaceError; }
    }
    const afterHash = await fileHash(canonicalPath); if (afterHash !== tempHash) throw new Error("Post-replace hash mismatch"); await journalWrite(journal, { ...base, tempHash, backup: backupInfo, afterHash, phase: "canonical_replaced" }); if (fault === "after-replace") throw Object.assign(new Error("Injected failure after replace"), { code: "INJECTED" });
    await journalWrite(journal, { ...base, tempHash, backup: backupInfo, afterHash, phase: "sync_pending" }); const sync = await syncCanonicalToDesktop(canonicalPath, desktopPath, { expectedExistingHash: desktopBeforeHash }); const phase = sync.state === "synced" ? "synced" : "sync_pending";
    const result = { transactionId, beforeHash, afterHash, backup: backupInfo, sync, patch, requestDigest }; await journalWrite(journal, { ...base, tempHash, backup: backupInfo, afterHash, sync, result, phase });
    if (audit) { const store = new AuditStore(audit); const cells = Array.isArray(patch) ? patch : [patch ?? {}]; for (const x of cells) await store.append({ timestamp: new Date().toISOString(), runId: transactionId, transactionId, patient: x.patient ?? x.patientId, row: x.row, column: x.column, cell: x.cell, old: x.old ?? x.before, new: x.new ?? x.after, format: x.format, evidence: x.evidence, confidence: x.confidence, provider: x.provider, approval: x.approval, retries: x.retries ?? 0, errors: x.errors, beforeHash, afterHash }); }
    return result;
  } catch (error) {
    // Keep a staged artifact for startup recovery/forensics.  It is adjacent
    // to the canonical and can never be mistaken for the workbook itself;
    // the next attempt may safely overwrite it under the same lock.
    error.transactionId = transactionId; throw error;
  } finally { await lockHandle.release(); }
}
export const runTransaction = executeTransaction;
