import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function assertSafeId(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(value))) {
    throw new Error(`${label} may contain only letters, numbers, underscores, and hyphens.`);
  }
  return String(value);
}

function now() {
  return new Date().toISOString();
}

export class WorkflowRunStore {
  constructor({ rootDir = path.resolve(process.cwd(), ".workflow-runs") } = {}) {
    this.rootDir = rootDir;
    this.locks = new Map();
  }

  async withLock(runId, operation) {
    const previous = this.locks.get(runId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(runId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(runId) === current) this.locks.delete(runId);
    }
  }

  pathFor(runId) {
    return path.join(this.rootDir, `${assertSafeId(runId, "Run ID")}.json`);
  }

  async create({ id = `run_${randomUUID()}`, profileId, profileVersion, records = [], metadata = {} } = {}) {
    assertSafeId(id, "Run ID");
    if (!profileId) throw new Error("Workflow profile ID is required.");
    const timestamp = now();
    const run = {
      id,
      profileId: String(profileId),
      ...(profileVersion ? { profileVersion: String(profileVersion) } : {}),
      status: "active",
      records,
      metadata,
      audit: [{ at: timestamp, type: "run_created" }],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.save(run);
  }

  async load(runId) {
    const file = this.pathFor(runId);
    const text = await readFile(file, "utf8");
    const run = JSON.parse(text);
    if (!run || run.id !== runId) throw new Error("Workflow run file is invalid.");
    return run;
  }

  async list() {
    await mkdir(this.rootDir, { recursive: true });
    const files = await readdir(this.rootDir, { withFileTypes: true });
    const runs = await Promise.all(files
      .filter(file => file.isFile() && file.name.endsWith(".json"))
      .map(async file => {
        const runId = file.name.slice(0, -5);
        try {
          return await this.load(runId);
        } catch (error) {
          return null;
        }
      }));
    return runs.filter(Boolean).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async save(run) {
    if (!run?.id) throw new Error("Workflow run ID is required.");
    return this.withLock(run.id, async () => {
      const file = this.pathFor(run.id);
      await mkdir(this.rootDir, { recursive: true });
      let existing = null;
      try {
        existing = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const expectedRevision = Number(run.revision ?? 0);
      const actualRevision = Number(existing?.revision ?? 0);
      if (existing && expectedRevision !== actualRevision) {
        const error = new Error("Workflow run changed while this operation was in progress.");
        error.code = "STALE_WORKFLOW_RUN";
        error.expectedRevision = expectedRevision;
        error.actualRevision = actualRevision;
        throw error;
      }
      const next = { ...run, revision: actualRevision + 1, updatedAt: now() };
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temp, file);
      return next;
    });
  }

  async appendAudit(runId, event) {
    if (!event?.type) throw new Error("Audit event type is required.");
    const run = await this.load(runId);
    run.audit = [...(run.audit ?? []), { at: now(), ...event }];
    return this.save(run);
  }

  async delete(runId) {
    await this.withLock(runId, () => rm(this.pathFor(runId), { force: true }));
  }
}
