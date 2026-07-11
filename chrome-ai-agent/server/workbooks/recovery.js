import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { WorkbookLock } from "./lock.js";
import { syncCanonicalToDesktop } from "./sync.js";
const hash = async file => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
const exists = async f => fs.access(f).then(() => true, () => false);
const quarantineFile = async file => { const q = `${file}.quarantine-${Date.now()}`; await fs.rename(file, q).catch(() => {}); return q; };

export async function recoverTransactions(directory, { quarantine = true } = {}) {
  const files = await fs.readdir(directory, { withFileTypes: true }).catch(e => e.code === "ENOENT" ? [] : Promise.reject(e)); const results = [];
  for (const entry of files.filter(e => e.isFile() && e.name.endsWith(".journal.json"))) {
    const journalFile = path.join(directory, entry.name); let j;
    try { j = JSON.parse(await fs.readFile(journalFile, "utf8")); } catch { if (quarantine) await quarantineFile(journalFile); results.push({ journal: journalFile, state: "quarantined", reason: "invalid_journal" }); continue; }
    let canonicalHash = null; try { canonicalHash = await hash(j.canonicalPath); } catch {}
    const tempExists = j.temp && await exists(j.temp); let state = "recovery_required";
    if (["synced", "sync_pending"].includes(j.phase)) state = j.phase;
    else if (j.afterHash && canonicalHash === j.afterHash) state = "written";
    else if (j.tempHash && tempExists && await hash(j.temp) !== j.tempHash) { if (quarantine) await quarantineFile(j.temp); state = "quarantined"; }
    else if (["prepared", "temp_verified", "backed_up"].includes(j.phase) && !tempExists) state = "aborted";
    if (state === "recovery_required" && quarantine && !tempExists && j.phase === "writing") await quarantineFile(journalFile);
    results.push({ ...j, state, temp: tempExists ? j.temp : undefined });
  }
  return results;
}
export const scanRecovery = recoverTransactions;

export async function resumeTransaction(journal, { sync = true } = {}) {
  const j = typeof journal === "string" ? JSON.parse(await fs.readFile(journal, "utf8")) : journal;
  if (!j.canonicalPath || !j.temp || !j.beforeHash) throw Object.assign(new Error("Invalid recovery journal"), { code: "RECOVERY_INVALID" });
  const lock = new WorkbookLock(j.canonicalPath); await lock.acquire();
  try {
    const current = await hash(j.canonicalPath); if (current !== j.beforeHash) throw Object.assign(new Error("Canonical changed since transaction"), { code: "RECOVERY_BASELINE_MISMATCH" });
    if (!(await exists(j.temp)) || (j.tempHash && await hash(j.temp) !== j.tempHash)) throw Object.assign(new Error("Temporary workbook is not verified"), { code: "RECOVERY_TEMP_INVALID" });
    await fs.rename(j.temp, j.canonicalPath); const afterHash = await hash(j.canonicalPath); if (j.afterHash && afterHash !== j.afterHash) throw Object.assign(new Error("Recovered hash mismatch"), { code: "RECOVERY_HASH_MISMATCH" });
    let mirror = { state: "disabled" }; if (sync && j.desktopPath) mirror = await syncCanonicalToDesktop(j.canonicalPath, j.desktopPath, { expectedExistingHash: j.desktopBeforeHash });
    return { transactionId: j.transactionId, state: mirror.state === "sync_pending" ? "sync_pending" : "written", afterHash, sync: mirror };
  } finally { await lock.release(); }
}
export const resumeRecovery = resumeTransaction;

export async function rollbackTransaction(journal, { backupPath } = {}) {
  const j = typeof journal === "string" ? JSON.parse(await fs.readFile(journal, "utf8")) : journal; const source = backupPath ?? j.backup?.path;
  if (!source || !(await exists(source))) throw Object.assign(new Error("Verified backup unavailable"), { code: "BACKUP_UNAVAILABLE" });
  const backupHash = j.backup?.hash; if (backupHash && await hash(source) !== backupHash) throw Object.assign(new Error("Backup verification failed"), { code: "BACKUP_INVALID" });
  const lock = new WorkbookLock(j.canonicalPath); await lock.acquire(); try { const tmp = `${j.canonicalPath}.rollback-${Date.now()}.tmp`; await fs.copyFile(source, tmp); if (backupHash && await hash(tmp) !== backupHash) throw new Error("Rollback hash mismatch"); const old = `${j.canonicalPath}.rollback-old-${Date.now()}`; let moved = false; try { await fs.rename(j.canonicalPath, old); moved = true; } catch (e) { if (e.code !== "ENOENT") throw e; } try { await fs.rename(tmp, j.canonicalPath); } catch (e) { if (moved) await fs.rename(old, j.canonicalPath).catch(() => {}); throw e; } if (moved) await fs.rm(old, { force: true }); return { state: "rolled_back", hash: await hash(j.canonicalPath) }; } finally { await lock.release(); }
}
export const rollbackRecovery = rollbackTransaction;
