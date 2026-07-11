import fs from "node:fs/promises";
import path from "node:path";

const isWindows = process.platform === "win32";
function contained(file, root) {
  const rel = path.relative(root, file);
  return rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Canonicalize a configured workbook path and ensure it remains below an approved root. */
export async function canonicalizeWorkbookPath(input, { allowedRoots = [], allowMissing = false, basename } = {}) {
  if (typeof input !== "string" || !input.trim()) throw Object.assign(new Error("Workbook path is required"), { code: "PATH_INVALID" });
  const raw = input.trim();
  if (/^\\\\/.test(raw) || /^\/\//.test(raw) || /^[a-z]+:\/\//i.test(raw) || /^\\\\\?\\/i.test(raw) || /^\\\\\.\\/i.test(raw)) throw Object.assign(new Error("UNC/network paths are not allowed"), { code: "PATH_UNSUPPORTED" });
  if (raw.split(/[\\/]+/).includes("..")) throw Object.assign(new Error("Path traversal is not allowed"), { code: "PATH_NOT_ALLOWED" });
  const absolute = path.resolve(raw);
  if (path.extname(absolute).toLowerCase() !== ".xlsx") throw Object.assign(new Error("Only .xlsx workbooks are supported"), { code: "UNSUPPORTED_FORMAT" });
  if (basename && path.basename(absolute).toLowerCase() !== String(basename).toLowerCase()) throw Object.assign(new Error("Workbook filename is not approved"), { code: "PATH_NOT_ALLOWED" });
  const roots = allowedRoots.length ? allowedRoots : [path.dirname(absolute)];
  const canonicalRoots = await Promise.all(roots.map(async root => {
    try { return await fs.realpath(path.resolve(root)); } catch (e) { if (e.code === "ENOENT") return path.resolve(root); throw e; }
  }));
  let canonical;
  try { canonical = await fs.realpath(absolute); } catch (e) {
    if (!allowMissing || e.code !== "ENOENT") throw Object.assign(new Error("Workbook path is unavailable"), { code: "PATH_NOT_FOUND", cause: e });
    // Resolve the existing parent so a missing file beneath a symlink/junction
    // cannot bypass containment checks.
    let parentPath = path.dirname(absolute); let parent;
    while (true) { try { parent = await fs.realpath(parentPath); break; } catch (x) { if (x.code !== "ENOENT" || parentPath === path.dirname(parentPath)) throw x; parentPath = path.dirname(parentPath); } }
    canonical = path.join(parent, path.basename(absolute));
  }
  if (!canonicalRoots.some(root => contained(canonical, root))) throw Object.assign(new Error("Path is outside approved roots"), { code: "PATH_NOT_ALLOWED" });
  if (canonical.includes(".." + path.sep)) throw Object.assign(new Error("Path traversal is not allowed"), { code: "PATH_NOT_ALLOWED" });
  return canonical;
}

export const canonicalizePath = canonicalizeWorkbookPath;
