import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
const digest = async file => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
export async function syncCanonicalToDesktop(canonical, desktop, { tempSuffix = `.sync-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.tmp`, force = false, expectedExistingHash } = {}) {
  if (!desktop) return { state: "disabled" };
  const sourceHash = await digest(canonical); const temp = `${desktop}${tempSuffix}`;
  try { await fs.mkdir(path.dirname(desktop), { recursive: true });
    try { const st = await fs.stat(desktop); const existing = await digest(desktop);
      if (!force && existing !== sourceHash) {
        if (expectedExistingHash !== undefined ? existing !== expectedExistingHash : st.mtimeMs >= (await fs.stat(canonical)).mtimeMs) {
          const e = Object.assign(new Error("Desktop mirror diverged"), { code: "MIRROR_CONFLICT" }); throw e;
        }
      }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    await fs.copyFile(canonical, temp, fs.constants.COPYFILE_EXCL); 
    const tempHandle = await fs.open(temp, "r"); await tempHandle.sync().catch(() => {}); await tempHandle.close();
    if (await digest(temp) !== sourceHash) throw new Error("Mirror verification failed");
    // rename() cannot replace an existing file on Windows. Preserve the old
    // mirror until the new copy is in place, and restore it if replacement
    // fails so a transient sync error never destroys the user's mirror.
    const old = `${desktop}.previous-${process.pid}-${Date.now()}`;
    let movedOld = false;
    try {
      await fs.rename(desktop, old); movedOld = true;
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    try { await fs.rename(temp, desktop); }
    catch (e) { if (movedOld) await fs.rename(old, desktop).catch(() => {}); throw e; }
    if (movedOld) await fs.rm(old, { force: true });
    if (await digest(desktop) !== sourceHash) throw new Error("Mirror hash mismatch"); return { state: "synced", hash: sourceHash, path: desktop }; }
  catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); return { state: "sync_pending", hash: sourceHash, path: desktop, error: error.message, code: error.code }; }
}
export const syncWorkbook = syncCanonicalToDesktop;
