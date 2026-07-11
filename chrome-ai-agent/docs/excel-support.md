# Excel support operator guide

Excel writes are opt-in. The protected **canonical** `.xlsx` working copy is
the source of truth; the configured `desktop` path is a verified compatibility
mirror. The backend validates the workbook before a run, writes only the
approved 36 columns on `Data Collection`, and never sends workbook contents to
an extraction provider.

## Configure once

Copy `server/.env.example` to `server/.env` and replace only the placeholders
with paths on the local machine. Do not commit that file.

```dotenv
WORKBOOK_PATH_ALIASES={"canonical":"C:\\Path\\To\\Approved\\working-copy.xlsx","desktop":"C:\\Path\\To\\Desktop\\working-copy.xlsx"}
WORKBOOK_ALLOWED_ROOTS=["C:\\Path\\To\\Approved","C:\\Path\\To\\Desktop"]
WORKBOOK_BASENAME=working-copy.xlsx
WORKBOOK_BACKUP_DIR=.workbook-backups
WORKBOOK_AUDIT_DIR=.workbook-audit
WORKBOOK_JOURNAL_DIR=.workbook-journal
WORKBOOK_BACKUP_RETENTION_DAYS=10
WORKBOOK_BACKUP_MAX=100
```

`WORKBOOK_PATH_ALIASES` must be a JSON object with `canonical` and `desktop`
absolute paths. `WORKBOOK_ALLOWED_ROOTS` is a JSON array of approved absolute
directories; both aliases must resolve inside one of those roots. Set
`WORKBOOK_BASENAME` only when a fixed filename is required. Relative backup,
audit, and journal directories are resolved by the server and should be kept
private (absolute directories are also supported). Never put credentials,
patient names, MRNs, or real identifiers in examples or logs.

One-time setup is deliberately explicit:

1. Make a disposable copy of the source workbook at the canonical path and a
   separate Desktop mirror. Ensure the target sheet is visible and named
   `Data Collection`, headers are on row 3, and the identity columns are
   present.
2. Set the aliases and allowed roots, restart the backend, and call the
   read-only open/status operation. Confirm the schema fingerprint, queue, and
   canonical/mirror hashes. No write is performed by this step.
3. Keep the original source read-only as a separate rollback reference. Do not
   point both aliases at the same file.

Example local commands (from `chrome-ai-agent`):

```powershell
Copy-Item server/.env.example server/.env
# Edit server/.env with a text editor; do not echo secrets or patient data.
node --check server/index.js
npm --prefix server test
```

## Safe run sequence

Open the workbook by its configured alias, read the queue, and extract patient
1. The backend maps patient `N` to worksheet row `N+3` (patient 1 is row 4),
re-checks MRN/date hashes, and presents a field-by-field diff. The workflow
stops at `pending_review`: a person must approve the one-time token for the
first patient. Rejection or correction regenerates the diff. Approval performs
one idempotent transaction; only after canonical replacement, verification,
and mirror hash match does continuation begin. Subsequent safe rows do not ask
for repeated permission, but any conflict pauses the run.

Every write acquires an adjacent exclusive lock and uses a same-directory temp
file, reopen/verification, atomic replacement, pre-write backup, journal, and
append-only audit record. Nonblank differing targets, changed identity/hash,
formula payloads, completed rows, and changes outside the allowlist are
conflicts—not overwrite opportunities.

## Locks, conflicts, and recovery

Lock acquisition retries sharing violations at 250/500/1000/2000/4000 ms, then
pauses with `WORKBOOK_LOCKED` (30-second overall timeout). A lock older than ten
minutes is quarantined only after the recorded process/host is confirmed dead;
this action is audited. Never delete a live lock or force-save over a workbook
open in Excel.

`sync_pending` means canonical committed successfully but the Desktop mirror
could not be replaced or hash-verified. Leave canonical authoritative, close
the workbook in Excel, then retry status/recover. A newer or divergent Desktop
copy is a split-brain conflict and must be resolved manually; synchronization
never reverses direction automatically. `recovery_required` means the process
may have stopped during a transaction. On restart, compare journal before/after
hashes: matching after-hash marks the transaction written; a verified temp with
unchanged canonical may be resumed; otherwise stop and choose a verified backup.
Transactions are idempotent and are never duplicated.

Rollback/manual recovery:

1. Stop runs and close both workbook copies in Excel/OneDrive.
2. Use the recover operation to select the last verified backup under lock.
3. If the service cannot recover, copy a verified backup to the canonical path,
   preserve the failed temp/journal for investigation, then reopen read-only
   and verify schema and hashes before resuming.
4. Rebuild the Desktop mirror from canonical; do not edit the mirror first.

Backups are pre-write snapshots in `WORKBOOK_BACKUP_DIR`, retained for 10 days
and capped at the 100 newest verified files. Pruning occurs only after a
successful commit. Audit JSONL and journals contain hashes, masked identity,
transaction state, and cell diffs—not raw patient values.

## Supported contract and limitations

- `.xlsx` only. `.xlsm`/macros, protected target sheets, hidden target sheets,
  duplicate or moved headers, external links for writes, malformed/oversized
  ZIPs, and formula payloads are rejected (external links may be inspected in
  an explicitly read-only mode).
- UNC/network paths, OneDrive placeholders, symlinks, junctions, and paths
  outside `WORKBOOK_ALLOWED_ROOTS` are rejected by default. Use a local,
  materialized working copy.
- Dates are real Excel dates formatted `d/m/yyyy`; `0` remains numeric zero;
  ranges such as `0-2` remain text; `N/A` is literal text only where the field
  profile permits; unresolved values are blank with a status/audit flag.
- Completed rows are read-only unless an explicit correction workflow is
  approved. Formula cells and non-target researcher cells are preserved.

## Staged rollout gates

Run the stages in order and keep a restore copy at every stage:

0. **Read-only inspection:** valid paired backend; queue/schema/hash shown and
   zero writes.
1. **Synthetic writes:** fixture fidelity, hash, lock, and recovery tests pass.
2. **Disposable real copy:** review before/after diff, mirror, and restore.
3. **One-patient supervised pilot:** explicit preview/approval, manual Excel
   verification, backup and audit present.
4. **Supervised multi-patient:** first checkpoint plus injected lock/crash/
   conflict tests; no duplicate or skipped rows.
5. **Broader use:** 30 successful disposable/approved runs, zero unreviewed
   writes, recovery drill, and operator sign-off.

To roll back a release, disable workbook write routes/feature flag, keep the
canonical copy unchanged, and restore the last verified backup under lock.
