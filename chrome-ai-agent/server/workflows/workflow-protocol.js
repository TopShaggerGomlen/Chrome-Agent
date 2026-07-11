export function assertSingleWorkflowAction(response) {
  if (!response || typeof response !== "object" || !Object.hasOwn(response, "action") || Object.hasOwn(response, "actions")) {
    const error = new Error("Workflow response must contain exactly one action field with an action or null.");
    error.code = "INVALID_WORKFLOW_PROTOCOL";
    throw error;
  }
  if (response.action !== null && (typeof response.action !== "object" || Array.isArray(response.action))) {
    const error = new Error("Workflow action must be an object or null.");
    error.code = "INVALID_WORKFLOW_PROTOCOL";
    throw error;
  }
  return response.action;
}

export function assertPhaseFieldAllowed(fieldId, phase, allowedFieldIds) {
  if (!new Set(allowedFieldIds).has(fieldId)) {
    const error = new Error(`Field ${fieldId} is not allowed during phase ${phase}.`);
    error.code = "OUT_OF_PHASE_FIELD";
    throw error;
  }
}
