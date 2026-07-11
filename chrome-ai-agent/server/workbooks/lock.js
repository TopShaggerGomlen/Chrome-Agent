import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class WorkbookLock {
  constructor(target, { staleMs = 15 * 60_000, retries = 8, retryDelayMs = 100, heartbeatMs } = {}) {
    this.target = target; this.lockPath = `${target}.lock`; this.staleMs = staleMs; this.retries = Math.max(0, retries); this.retryDelayMs = retryDelayMs; this.owner = randomUUID(); this.heartbeatMs = heartbeatMs ?? Math.max(100, Math.floor(staleMs / 3)); this.timer = null;
  }
  async acquire() {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const handle = await fs.open(this.lockPath, "wx", 0o600);
        const metadata = { owner: this.owner, pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(), heartbeatAt: Date.now() };
        await handle.writeFile(JSON.stringify(metadata)); await handle.close();
        this.timer = setInterval(async () => { try { const current = JSON.parse(await fs.readFile(this.lockPath, "utf8")); if (current.owner !== this.owner) return; current.heartbeatAt = Date.now(); await fs.writeFile(this.lockPath, JSON.stringify(current), { mode: 0o600 }); } catch {} }, this.heartbeatMs); this.timer.unref?.();
        return { owner: this.owner, path: this.lockPath, release: () => this.release() };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let stale = false;
        try { const text = await fs.readFile(this.lockPath, "utf8"); const meta = JSON.parse(text); const age = Date.now() - (meta.heartbeatAt || Date.parse(meta.createdAt) || 0); let alive = false; if (Number.isInteger(meta.pid) && meta.pid > 0) { try { process.kill(meta.pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; } } stale = age > this.staleMs && !alive; } catch (e) { if (e.code !== "ENOENT") { stale = true; } else continue; }
        if (stale) { try { await fs.rename(this.lockPath, `${this.lockPath}.stale-${Date.now()}-${randomUUID()}`); continue; } catch { /* another process won */ } }
        if (attempt === this.retries) throw Object.assign(new Error("Workbook is locked"), { code: "WORKBOOK_LOCKED", retryable: true });
        await sleep(this.retryDelayMs * Math.min(8, attempt + 1));
      }
    }
  }
  async release() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { const metadata = JSON.parse(await fs.readFile(this.lockPath, "utf8")); if (metadata.owner !== this.owner) return false; } catch (e) { if (e.code === "ENOENT") return true; throw e; }
    await fs.rm(this.lockPath, { force: true }); return true;
  }
}
export async function withWorkbookLock(target, options, operation) { const lock = new WorkbookLock(target, options); await lock.acquire(); try { return await operation(lock); } finally { await lock.release(); } }
