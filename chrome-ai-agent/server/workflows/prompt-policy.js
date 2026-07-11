export function collectionPlaybookForPrompt(playbook, runState, sanitize) {
  if (runState?.playbookAcknowledged) return "";
  return sanitize(playbook || "", 12000);
}

export function assertPromptByteBudget(input, maxBytes = 48_000) {
  const bytes = Buffer.byteLength(String(input || ""), "utf8");
  if (bytes > maxBytes) {
    const error = new Error("Workflow context exceeds the safe model budget. Refresh with a smaller page region.");
    error.code = "CONTEXT_BUDGET_EXCEEDED";
    error.contextBytes = bytes;
    throw error;
  }
  return bytes;
}
