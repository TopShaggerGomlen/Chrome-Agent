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
    await this.save(run);
    return run;
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
    const file = this.pathFor(run.id);
    await mkdir(this.rootDir, { recursive: true });
    const next = { ...run, updatedAt: now() };
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
    return next;
  }

  async appendAudit(runId, event) {
    if (!event?.type) throw new Error("Audit event type is required.");
    const run = await this.load(runId);
    run.audit = [...(run.audit ?? []), { at: now(), ...event }];
    return this.save(run);
  }

  async delete(runId) {
    await rm(this.pathFor(runId), { force: true });
  }
}
