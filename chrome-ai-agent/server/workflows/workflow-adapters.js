import {
  isTrakCareReadOnlyAction,
  isTrakCarePhaseTransitionAllowed,
  trakCarePhaseInstruction
} from "./trakcare-adapter.js";

function phaseFieldIds(profile, phase, allFieldIds) {
  if (phase === "validation" || !profile.phaseFields) return [...allFieldIds];
  return Array.isArray(profile.phaseFields[phase]) ? [...profile.phaseFields[phase]] : [...allFieldIds];
}

function orderedPhaseTransition(profile, currentPhase, nextPhase) {
  if (currentPhase === "queued") return nextPhase === profile.phases[0];
  const current = profile.phases.indexOf(currentPhase);
  const next = profile.phases.indexOf(nextPhase);
  return current >= 0 && next >= 0 && (next === current || next === current + 1);
}

function genericReadOnlyAction(profile, action) {
  if (profile.mode !== "read_only") return true;
  const text = [action?.type, action?.description, action?.text, action?.selector].join(" ").toLowerCase();
  return !(profile.blockedActionWords || []).some(word => text.includes(String(word).toLowerCase()));
}

const GENERIC_ADAPTER = {
  id: "generic-browser-read-only",
  phaseInstruction(profile, phase) {
    return profile.phaseInstructions?.[phase] || "Observe the current page, use direct evidence only, and avoid write controls.";
  },
  phaseFieldIds,
  transitionAllowed: orderedPhaseTransition,
  actionAllowed: genericReadOnlyAction
};

const TRAKCARE_ADAPTER = {
  ...GENERIC_ADAPTER,
  id: "trakcare-chartbook",
  phaseInstruction(_profile, phase) {
    return trakCarePhaseInstruction(phase);
  },
  transitionAllowed(_profile, currentPhase, nextPhase) {
    return isTrakCarePhaseTransitionAllowed(currentPhase, nextPhase);
  },
  actionAllowed(_profile, action) {
    return isTrakCareReadOnlyAction(action);
  }
};

const ADAPTERS = new Map([
  [GENERIC_ADAPTER.id, GENERIC_ADAPTER],
  [TRAKCARE_ADAPTER.id, TRAKCARE_ADAPTER]
]);

export function workflowAdapterFor(profile) {
  return ADAPTERS.get(profile?.adapterId) || GENERIC_ADAPTER;
}

export function publicWorkflowPolicy(profile) {
  const adapter = workflowAdapterFor(profile);
  return {
    adapterId: adapter.id,
    mode: profile.mode,
    externalViewer: profile.externalViewer || null
  };
}
