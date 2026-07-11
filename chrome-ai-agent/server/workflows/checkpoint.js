export function applyFirstRecordCheckpoint(run, record, reviewReady, at = new Date().toISOString()) {
  if (!reviewReady) return { checkpointed: false, completed: false };
  if (record.queueIndex === 0 && !run.metadata?.firstRecordApproved) {
    record.phase = "review";
    run.status = "awaiting_first_review";
    record.workbookPreview = record.workbookPreview || { status: "pending_approval", patientNumber: (record.queueIndex ?? 0) + 1 };
    run.audit = [...(run.audit || []), { at, type: "first_record_ready_for_review", recordId: record.id }];
    return { checkpointed: true, completed: false };
  }
  if (run.metadata?.firstRecordApproved) {
    record.phase = "complete";
    return { checkpointed: false, completed: true };
  }
  return { checkpointed: false, completed: false };
}
