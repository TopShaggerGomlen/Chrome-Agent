const WRITE_WORDS = ["save", "update", "submit", "delete", "remove", "approve", "payment", "transfer"];

export const TRAKCARE_ADAPTER_ID = "trakcare-chartbook";

const PHASE_FIELDS = Object.freeze({
  patient_search: [],
  chartbook: [],
  comorbidities: ["K", "M", "N", "V", "W"],
  laboratory: ["L", "AF", "AI", "AH", "AG", "AD", "AE", "AC", "AB", "AA", "P", "Q"],
  radiology: ["BF", "BG", "BH", "AL", "CS", "CT", "CU", "CV", "CW"],
  operations: ["S", "T", "CE", "BP", "R", "X", "Y"],
  medications: ["BO", "CN", "CO"],
  validation: []
});

export const TRAKCARE_PHASE_HINTS = Object.freeze({
  patient_search: "Open the patient episode search and locate the URN field. Type only {{MRN}}, search, and verify the patient banner before continuing.",
  chartbook: "Open Encounter Record and Chartbook. Confirm the patient banner before collecting data.",
  comorbidities: "Read Active Problems and Anaesthesia Clearance comments. Capture evidence; do not infer diagnoses.",
  laboratory: "Use Lab Results with targeted searches for A1c, urine culture, urine examination, and creatinine. Keep collection/result dates as evidence.",
  radiology: "Open the closest pre-op CT KUB report. Use the separate viewer only for report reading and return to the EMR afterwards.",
  operations: "Read the index operation, prior stone procedures, operation notes, and Anaesthesia Clearance. Never save or update a form.",
  medications: "Read All Meds and Discharge Meds around the surgery episode without changing prescriptions.",
  validation: "Resolve only rule-driven fields, record uncertainty, and request review for any remaining missing evidence."
});

export function isTrakCareReadOnlyAction(action) {
  const text = [action?.type, action?.description, action?.text, action?.selector].join(" ").toLowerCase();
  return !WRITE_WORDS.some(word => text.includes(word));
}

export function shouldReturnToEmrTab(phase) {
  return ["operations", "medications", "validation"].includes(String(phase || ""));
}

export function trakCarePhaseInstruction(phase) {
  return TRAKCARE_PHASE_HINTS[phase] || "Observe the current read-only page and gather direct evidence only.";
}

export function trakCarePhaseFieldIds(phase, allFieldIds = []) {
  const normalized = String(phase || "");
  if (normalized === "validation") return [...allFieldIds];
  const selected = PHASE_FIELDS[normalized];
  return selected ? [...selected] : [...allFieldIds];
}

export function isTrakCarePhaseTransitionAllowed(currentPhase, nextPhase) {
  const phases = Object.keys(TRAKCARE_PHASE_HINTS);
  if (String(currentPhase || "") === "queued" && String(nextPhase || "") === phases[0]) return true;
  const currentIndex = phases.indexOf(String(currentPhase || ""));
  const nextIndex = phases.indexOf(String(nextPhase || ""));
  if (currentIndex < 0 || nextIndex < 0) return false;
  return nextIndex === currentIndex || nextIndex === currentIndex + 1;
}
