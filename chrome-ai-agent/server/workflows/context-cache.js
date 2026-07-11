import { randomUUID } from "node:crypto";

function keyFor(item, fallbackPrefix, index) {
  if (item?.contextKey) return String(item.contextKey);
  if (item?.chunkId) return `chunk:${item.chunkId}`;
  if (item?.selector) return `target:${item.frameId ?? 0}:${item.selector}:${JSON.stringify(item.shadowPath || [])}`;
  if (item?.name || item?.label) return `form:${item.frameId ?? 0}:${item.name || item.label}:${index}`;
  return `${fallbackPrefix}:${index}`;
}

function mergeList(previous, changed, removed, prefix) {
  const map = new Map((previous || []).map((item, index) => [keyFor(item, prefix, index), item]));
  for (const key of removed || []) map.delete(String(key));
  for (const [index, item] of (changed || []).entries()) map.set(keyFor(item, prefix, index), item);
  return Array.from(map.values());
}

export class WorkflowContextCache {
  constructor({ ttlMs = 5 * 60 * 1000, maxEntries = 100 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt > this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }

  resolve(key, payload = {}) {
    this.prune();
    const current = this.entries.get(key);
    const suppliedCursor = String(payload.cursor || "");
    const full = payload.fullPage && typeof payload.fullPage === "object" ? payload.fullPage : null;

    if (!full && (!current || !suppliedCursor || suppliedCursor !== current.cursor)) {
      const error = new Error("Workflow context cache miss. Send a fresh full page snapshot.");
      error.code = "CONTEXT_REFRESH_REQUIRED";
      throw error;
    }

    const base = full || current.page;
    const delta = payload.delta && typeof payload.delta === "object" ? payload.delta : {};
    const page = full ? { ...full } : {
      ...base,
      ...(delta.url ? { url: delta.url } : {}),
      ...(delta.title ? { title: delta.title } : {}),
      ...(delta.timestamp ? { timestamp: delta.timestamp } : {}),
      ...(delta.scroll ? { scroll: delta.scroll } : {}),
      chunks: mergeList(base.chunks, delta.changedChunks, delta.removedChunkIds, "chunk"),
      elements: mergeList(base.elements, delta.changedElements, delta.removedElementIds, "target"),
      formValues: mergeList(base.formValues, delta.changedFormValues, delta.removedFormValueIds, "form"),
      warnings: Array.isArray(delta.warnings) ? delta.warnings : base.warnings
    };
    const changedPage = full ? { ...page, contextMode: "full" } : {
      url: page.url,
      title: page.title,
      timestamp: page.timestamp,
      scroll: page.scroll,
      chunks: delta.changedChunks || [],
      elements: delta.changedElements || [],
      formValues: delta.changedFormValues || [],
      warnings: delta.warnings || [],
      contextMode: "delta",
      removedRegionIds: [
        ...(delta.removedChunkIds || []),
        ...(delta.removedElementIds || []),
        ...(delta.removedFormValueIds || [])
      ]
    };
    const cursor = randomUUID();
    const regionHashes = payload.regionHashes && typeof payload.regionHashes === "object"
      ? payload.regionHashes
      : (current?.regionHashes || {});
    this.entries.set(key, { cursor, page, regionHashes, updatedAt: Date.now() });
    this.prune();
    return { page, changedPage, cursor, cacheHit: Boolean(current && !full), regionHashCount: Object.keys(regionHashes).length };
  }

  delete(key) {
    this.entries.delete(key);
  }

  deleteRun(runId) {
    const prefix = `${runId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

export function workflowContextKey(runId, recordId) {
  return `${runId}:${recordId}`;
}
