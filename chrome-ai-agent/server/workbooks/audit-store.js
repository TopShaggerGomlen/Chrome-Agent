import fs from "node:fs/promises";
import path from "node:path";
export class AuditStore {
  constructor({ directory = path.resolve(process.cwd(), ".workbook-audit"), retentionDays = 10 } = {}) { this.directory = directory; this.retentionDays = retentionDays; }
  async append(event) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const safe = { timestamp: event.timestamp ?? event.at ?? new Date().toISOString(), ...event };
    delete safe.at; delete safe.value; delete safe.oldValue; delete safe.newValue; delete safe.mrn; delete safe.patientName; delete safe.name; delete safe.path; delete safe.canonicalPath;
    if (safe.patient && typeof safe.patient === "object") safe.patient = { row: safe.patient.row };
    await this.rotate();
    await fs.appendFile(file, JSON.stringify(safe) + "\n", { encoding: "utf8", mode: 0o600 });
    try { await fs.chmod(file, 0o600); } catch { /* ACLs are platform-managed */ }
    return safe;
  }
  async rotate(now = Date.now()) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 }); const files = await fs.readdir(this.directory).catch(() => []); const cutoff = now - this.retentionDays * 86400000;
    for (const name of files.filter(n => n.endsWith(".jsonl"))) { const stat = await fs.stat(path.join(this.directory, name)).catch(() => null); if (stat && stat.mtimeMs < cutoff) await fs.rm(path.join(this.directory, name), { force: true }); }
  }
  async exportRedacted({ format = "json", from, to } = {}) {
    const files = (await fs.readdir(this.directory).catch(() => [])).filter(n => n.endsWith(".jsonl")).sort(); const rows = [];
    for (const name of files) for (const line of (await fs.readFile(path.join(this.directory, name), "utf8")).split(/\r?\n/)) { if (!line) continue; const row = JSON.parse(line); const t = Date.parse(row.timestamp); if (from && t < Date.parse(from) || to && t > Date.parse(to)) continue; rows.push(row); }
    if (format === "csv") { const keys = [...new Set(rows.flatMap(r => Object.keys(r)))]; return [keys.join(","), ...rows.map(r => keys.map(k => JSON.stringify(r[k] ?? "")).join(","))].join("\n"); }
    return JSON.stringify(rows);
  }
}
export const appendAudit = async (event, options) => new AuditStore(options).append(event);
