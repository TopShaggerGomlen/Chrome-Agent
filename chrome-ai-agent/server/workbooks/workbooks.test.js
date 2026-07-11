import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalizeWorkbookPath } from "./path-policy.js";
import { WorkbookLock } from "./lock.js";
import { createBackup } from "./backup.js";
import { AuditStore } from "./audit-store.js";
import { syncCanonicalToDesktop } from "./sync.js";
import { executeTransaction } from "./transaction.js";
import { recoverTransactions } from "./recovery.js";

async function temp() { return fs.mkdtemp(path.join(os.tmpdir(), "wb-")); }
test("path policy canonicalizes xlsx and rejects traversal/UNC/symlink escape", async () => {
  const root = await temp(), file = path.join(root, "book.xlsx"); await fs.writeFile(file, "x");
  assert.equal(await canonicalizeWorkbookPath(file, { allowedRoots: [root] }), file);
  await assert.rejects(canonicalizeWorkbookPath("\\\\server\\book.xlsx"), e => e.code === "PATH_UNSUPPORTED");
  const outside = await temp(); await fs.symlink(outside, path.join(root, "link"), "junction").catch(() => {});
  if (await fs.lstat(path.join(root, "link")).then(() => true, () => false)) await assert.rejects(canonicalizeWorkbookPath(path.join(root, "link", "x.xlsx"), { allowedRoots: [root], allowMissing: true }), /outside|unavailable/);
});
test("lock contention and stale lock recovery", async () => {
  const dir = await temp(), file = path.join(dir, "book.xlsx"); await fs.writeFile(file, "x");
  const a = new WorkbookLock(file, { retries: 0 }); await a.acquire(); await assert.rejects(new WorkbookLock(file, { retries: 0 }).acquire(), e => e.code === "WORKBOOK_LOCKED"); await a.release();
  await fs.writeFile(`${file}.lock`, "stale"); const old = new Date(Date.now() - 100000); await fs.utimes(`${file}.lock`, old, old); const b = new WorkbookLock(file, { staleMs: 10, retries: 0 }); await b.acquire(); await b.release();
});
test("backup ring and privacy audit", async () => {
  const dir = await temp(), file = path.join(dir, "book.xlsx"); await fs.writeFile(file, "x"); const b = await createBackup(file, { directory: path.join(dir, "backups"), maxCount: 1 }); assert.match(b.path, /backup/);
  const audit = new AuditStore({ directory: path.join(dir, "audit") }); await audit.append({ transactionId: "t", mrn: "secret", newValue: "secret", status: "ok" }); const text = await fs.readFile(path.join(dir, "audit", `${new Date().toISOString().slice(0,10)}.jsonl`), "utf8"); assert.doesNotMatch(text, /secret/); if (process.platform !== "win32") assert.equal((await fs.stat(path.join(dir, "audit", `${new Date().toISOString().slice(0,10)}.jsonl`))).mode & 0o777, 0o600);
});
test("sync and transaction fault safety/idempotency", async () => {
  const dir = await temp(), canonical = path.join(dir, "book.xlsx"), mirror = path.join(dir, "Desktop", "book.xlsx"); await fs.writeFile(canonical, "old");
  const result = await executeTransaction({ canonicalPath: canonical, desktopPath: mirror, transactionId: "tx1", patch: [{ cell: "A1" }], write: async tempFile => fs.writeFile(tempFile, "new") }); assert.equal(result.sync.state, "synced"); assert.equal(await fs.readFile(mirror, "utf8"), "new");
  let calls = 0; const replay = await executeTransaction({ canonicalPath: canonical, transactionId: "tx1", write: async () => { calls++; } }); assert.equal(calls, 0); assert.equal(replay.transactionId, "tx1");
  await assert.rejects(executeTransaction({ canonicalPath: canonical, transactionId: "bad", fault: "after-temp", write: async f => fs.writeFile(f, "bad") })); assert.equal(await fs.readFile(canonical, "utf8"), "new");
});
test("recovery classifies after-hash and pending journals", async () => {
  const dir = await temp(), canonical = path.join(dir, "book.xlsx"); await fs.writeFile(canonical, "done"); const crypto = await import("node:crypto"); const afterHash = crypto.createHash("sha256").update("done").digest("hex"); await fs.writeFile(path.join(dir, "a.journal.json"), JSON.stringify({ transactionId:"a", canonicalPath:canonical, afterHash, state:"writing" })); await fs.writeFile(path.join(dir, "b.journal.json"), JSON.stringify({ transactionId:"b", canonicalPath:canonical, temp:path.join(dir,"missing.tmp"), state:"writing" })); const states = await recoverTransactions(dir, { quarantine:false }); assert.equal(states.find(x=>x.transactionId === "a").state, "written"); assert.equal(states.find(x=>x.transactionId === "b").state, "recovery_required");
});

test("transaction journals preserve canonical on prewrite faults and reject digest reuse", async () => {
  const dir = await temp(), canonical = path.join(dir, "book.xlsx"); await fs.writeFile(canonical, "stable");
  await assert.rejects(executeTransaction({ canonicalPath: canonical, transactionId: "pre", fault: "before-temp", patch: { value: 1 }, write: async f => fs.writeFile(f, "changed") }), e => e.code === "INJECTED");
  assert.equal(await fs.readFile(canonical, "utf8"), "stable");
  await assert.rejects(executeTransaction({ canonicalPath: canonical, transactionId: "pre", patch: { value: 2 }, write: async f => fs.writeFile(f, "changed") }), e => e.code === "TRANSACTION_DIGEST_CONFLICT");
});

test("divergent desktop mirror is reported pending without overwriting newer data", async () => {
  const dir = await temp(), canonical = path.join(dir, "book.xlsx"), desktop = path.join(dir, "Desktop", "book.xlsx");
  await fs.mkdir(path.dirname(desktop), { recursive: true }); await fs.writeFile(canonical, "canonical"); await fs.writeFile(desktop, "desktop");
  const now = new Date(); await fs.utimes(desktop, now, new Date(now.getTime() + 2000));
  const result = await syncCanonicalToDesktop(canonical, desktop); assert.equal(result.state, "sync_pending"); assert.equal(await fs.readFile(desktop, "utf8"), "desktop");
});

test("transaction updates an unchanged baseline mirror and blocks concurrent divergence", async () => {
  const dir = await temp(), canonical = path.join(dir, "book.xlsx"), desktop = path.join(dir, "Desktop", "book.xlsx");
  await fs.mkdir(path.dirname(desktop), { recursive: true }); await fs.writeFile(canonical, "old"); await fs.copyFile(canonical, desktop);
  const ok = await executeTransaction({ canonicalPath: canonical, desktopPath: desktop, transactionId: "baseline", write: async f => fs.writeFile(f, "new") });
  assert.equal(ok.sync.state, "synced"); assert.equal(await fs.readFile(desktop, "utf8"), "new");
  await fs.writeFile(canonical, "old");
  const blocked = await executeTransaction({ canonicalPath: canonical, desktopPath: desktop, transactionId: "diverged", write: async f => { await fs.writeFile(desktop, "external"); await fs.writeFile(f, "newer"); } });
  assert.equal(blocked.sync.state, "sync_pending"); assert.equal(blocked.sync.code, "MIRROR_CONFLICT"); assert.equal(await fs.readFile(desktop, "utf8"), "external");
});
