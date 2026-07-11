import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const hash = data => crypto.createHash("sha256").update(data).digest("hex");
export async function createBackup(file, { directory = path.join(path.dirname(file), ".workbook-backups"), now = new Date(), retentionDays = 10, maxCount = 100 } = {}) {
  await fs.mkdir(directory, { recursive: true });
  const data = await fs.readFile(file); const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  let destination = path.join(directory, `${path.basename(file, path.extname(file))}.backup.${stamp}.xlsx`);
  try { await fs.writeFile(destination, data, { mode: 0o600, flag: "wx" }); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    destination = path.join(directory, `${path.basename(file, path.extname(file))}.backup.${stamp}.${crypto.randomBytes(4).toString("hex")}.xlsx`);
    await fs.writeFile(destination, data, { mode: 0o600, flag: "wx" });
  }
  if (hash(data) !== hash(await fs.readFile(destination))) throw new Error("Backup verification failed");
  const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith(".xlsx"));
  const cutoff = Date.now() - retentionDays * 86400000;
  const stats = await Promise.all(entries.map(async e => ({ e, stat: await fs.stat(path.join(directory, e.name)) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  for (const item of stats.slice(maxCount)) await fs.rm(path.join(directory, item.e.name), { force: true });
  for (const item of stats.slice(0, maxCount)) if (item.stat.mtimeMs < cutoff && item.e.name !== path.basename(destination)) await fs.rm(path.join(directory, item.e.name), { force: true });
  return { path: destination, hash: hash(data) };
}
export const backupWorkbook = createBackup;
