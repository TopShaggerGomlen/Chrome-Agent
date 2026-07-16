# Chrome AI Agent Extension — Extraction Workflow Evaluation

**Evaluation date:** 10 July 2026  
**Repository:** `chrome-ai-agent`  
**Authoritative workflow:** `Extraction_Steps_v3_FINAL(1)(1).md`  
**Data used:** deterministic synthetic identifiers and clinical values only. No live EMR or real patient record was accessed.  
**Decision:** **NO-GO for clinical or research-data use**

## 1. Executive Summary

The extension is a capable browser-agent prototype with meaningful safety engineering: DOM-based targets, document and tab binding, frame aggregation, target fingerprints, bounded context, explicit batch approval, selector rematching, stop handling, a persisted workflow queue, first-patient checkpointing, PACS tab leasing, typed evidence-backed records, and provider abstraction. These capabilities were verified by code inspection and passing unit/integration/E2E tests.

It cannot complete the authoritative workflow end to end. Direct Excel reading/writing, the `Data Collection` sheet contract, row mapping, target-column protection, real-date/text formatting, workbook locking, atomic row commits, scratch/Desktop synchronization, and crash-safe workbook resume are not implemented. Workflow Mode exports CSV and Markdown only. Most clinical rules are delegated to the model rather than implemented or verified deterministically. There is no deterministic EMR patient-identity guard, no complete TrakCare navigation adapter, no reliable early native-dialog strategy, and no postcondition verification after clicks or typed actions.

The synthetic TrakCare tests verified that the extension can enter a synthetic URN, navigate synthetic patient/encounter/EPR pages through stable DOM targets, observe delayed lab content, read non-sensitive form values including blood loss `0`, and block an Update action. They also verified a critical gap: a wrong-patient banner is observable but does not trigger a deterministic rejection. Characterization tests confirmed that a same-day postoperative CT is incorrectly treated as absent and that a numeric residual-stone size is rejected by the field schema.

Cloud provider adapters were tested repeatedly with injected deterministic clients, not real provider services. No OpenAI or Claude credential was available, no `.env` existed, and the saved runtime settings contained only provider/model selection. Therefore authentication reliability, real latency, model clinical accuracy, hallucination rate, and real cost remain untested.

## 2. Final Score and Readiness Decision

### Overall scorecard

| Category | Score | Maximum | Evidence | Confidence |
|---|---:|---:|---|---|
| Browser navigation and interaction reliability | 11 | 20 | DOM selectors/fingerprints, frame routing, stale-document rejection, PACS leasing, synthetic navigation; no postcondition verification or full TrakCare adapter | High for tested fixtures; Low for TrakCare |
| Correct extraction and clinical-rule application | 5 | 25 | Typed schema and a small deterministic rule subset; most field rules absent; two demonstrated rule/schema defects | High |
| Spreadsheet correctness and data preservation | 0 | 15 | No XLSX reader/writer or native/file-system integration; CSV/Markdown only | High |
| Recovery from failures and dynamic-page behavior | 5 | 15 | Selector rematch/retry, stop/revision protection, stale document and PACS tests; dialog, session, stream, stale-pane, and operation retry gaps | Medium-High |
| Security, privacy, and read-only enforcement | 9 | 15 | Strong target/action validation and write/credential blocks; critical wrong-patient and PHI minimization gaps | High |
| Checkpoint, approval, continuation, and state | 4 | 5 | First-record checkpoint, explicit continuation, local run persistence, stop race protection; no workbook-aware resume | High |
| Model-provider implementation and consistency | 3 | 5 | Five adapters and normalized structured-output tests; three required paths repeated with mocks; no real-provider execution | Medium |
| **Total** | **37** | **100** |  | **High for implementation state; Low for real EMR/provider reliability** |

**Production readiness:** **Prototype**  
**Supervised use with real patient data:** **Not acceptable** until all P0 items are resolved and independently validated.  
**Unsupervised use:** **Not acceptable.**

The score reflects capability toward the complete playbook, not generic browser-agent quality. The missing spreadsheet integration alone makes the expected full autonomous completion rate **0%** for the defined deliverable.

## 3. Architecture Overview

The system is a Manifest V3 extension plus a loopback Node backend:

- The side panel collects the instruction, requests bounded page context from the background worker, sends it to the backend, displays a structured plan, and executes one approved batch ([`extension/sidepanel.js`](chrome-ai-agent/extension/sidepanel.js), especially lines 2335-2467 and 3041-3124).
- The background service worker aggregates content-script snapshots across frames, binds observations to tab/frame/document identity, captures optional accessibility/screenshot context, and routes validated actions ([`extension/background.js`](chrome-ai-agent/extension/background.js), lines 612-656, 901-1054, 1086-1190).
- The all-frame content script discovers DOM/shadow-root targets, generates selectors and fingerprints, collects bounded text/form values, revalidates actions, and executes click/type/submit/extract actions ([`extension/content.js`](chrome-ai-agent/extension/content.js), lines 171-291, 589-620, 834-955, 958-991).
- The backend pairs one extension origin, stores provider settings locally, builds prompts, validates structured actions, calls a provider driver, and persists workflow runs ([`server/index.js`](chrome-ai-agent/server/index.js), lines 437-533, 853-1013, 1415-1480, 1743-1769).
- Workflow modules define queue parsing, typed field records, audit evidence, profile phases, read-only policy, deterministic helper rules, checkpointing, atomic JSON run persistence, and CSV/Markdown export ([`server/workflows`](chrome-ai-agent/server/workflows)).
- Provider drivers normalize OpenAI API, Claude API, Codex CLI sign-in, DeepSeek/Ollama, and gpt-oss/Ollama paths ([`server/providers`](chrome-ai-agent/server/providers)).

The manifest uses `<all_urls>`, `all_frames`, `tabs`, `webNavigation`, `scripting`, `storage`, and `debugger`; the content script starts at `document_idle` ([`extension/manifest.json`](chrome-ai-agent/extension/manifest.json), lines 7-38).

## 4. End-to-End Execution Trace

1. **User instruction:** side panel records the task and optional attachments/screenshot.
2. **Observation:** the background worker queries the active tab, enumerates accessible frames, requests bounded snapshots, assigns a context ID, and stores tab/frame/document identity.
3. **Model request:** the side panel posts context to `/agent/stream`; Workflow Mode posts phase-scoped context to workflow-plan routes.
4. **Planning:** the selected provider returns JSON; backend schemas allow only click/type/submit/extract-like actions, with at most one workflow action.
5. **Validation:** backend and content script reject unsupported, sensitive, destructive, stale-document, wrong-tab/frame, missing-selector, and fingerprint-mismatch actions.
6. **Approval:** generic action batches require one explicit `Run action batch`; Workflow Mode uses `Run First Patient` and `Approve & Continue`.
7. **Execution:** the content script performs DOM actions. There is no arbitrary model JavaScript action.
8. **Recovery:** selector-like failures receive bounded settle/rematch/retry; stale documents fail closed; workflow revisions prevent a late planner response from overwriting a stop.
9. **Verification:** the executor returns immediate action success, but does not assert intended DOM/navigation postconditions. A later observation may reveal failure, but this is model-dependent.
10. **Record/checkpoint:** workflow fields and evidence are persisted to JSON; all schema fields may be marked unresolved and still become review-ready. The first record pauses pending approval.
11. **Spreadsheet write:** **missing**. Only CSV/Markdown export exists; there is no workbook path, sheet, row, column, format, locking, sync, or rollback implementation.

## 5. Requirements Traceability Matrix

### Requirements matrix

| Requirement | Status | Code evidence | Test evidence | Risk |
|---|---|---|---|---|
| DOM-based element discovery | Implemented | `content.js:43-60, 233-291` | Synthetic navigation and existing E2E | Low |
| Stable references instead of coordinates | Implemented | selectors, fingerprints, document IDs in `content.js:171-291, 462-546` | stale-document and synthetic tests | Low |
| Form-field value extraction | Implemented | `content.js:589-620, 1097-1102` | synthetic operation values | Medium: capped/accessible DOM only |
| Safe JavaScript execution | Implemented by exclusion | action schemas expose no arbitrary JS; `content.js:1048-1059` refuses injection | unsupported/malformed action tests | Low |
| Navigation/full reload handling | Partial | document commits tracked in `background.js:53-66`; stale actions rejected | reload stale-document test | Medium |
| Main-menu navigation | Missing as deterministic adapter | only model phase hints | no TrakCare menu fixture path | High |
| Left-navigation interaction | Partial | generic DOM click | synthetic Laboratory link | High on real TrakCare |
| Stale/non-repainted pane detection | Missing | no DOM-versus-URL repaint invariant | not executed | High |
| Dynamically rendered content | Partial | re-observation and settle delays | delayed synthetic labs pass | Medium |
| Frames/iframes | Partial | all-frame content script; capped light/deep frames | generic frame architecture only | Medium |
| New-tab detection/PACS switching/return | Implemented for configured viewer lease | `background.js:324-564`; profile viewer policy | PACS association E2E | Medium |
| Transient connection recovery | Partial/Incorrect | limited context/budget retries; no general workflow stream retry | not executed | High |
| Action timeout | Partial | request abort/stop and Codex timeout | abort tests | Medium |
| Prevent repeated clicking | Partial | action limit, batch stop, no-progress budgets | batch tests | Medium |
| Verify intended action result | Missing | executor returns after DOM method, no postcondition | code inspection | High |
| Patient Episode Search/URN/result/Episode/Encounter/EPR | Partial | model-driven only | synthetic path passes | High on real TrakCare |
| Laboratory/Radiology/Operations/Forms/Medication/Problems navigation | Partial | phase hints/profile only | only synthetic labs/PACS/operation form | High |
| Correct-patient validation | Incorrect | PACS terms checked; no generic EMR banner guard | wrong-patient synthetic characterization | Critical |
| Reopen search/clear prior patient | Missing | prompt hint only | not tested | High |
| Native `alert` handling | Partial/Incorrect | CDP `Page.handleJavaScriptDialog`; no early auto strategy | no immediate/reload alert E2E | High |
| Native `confirm`/`print` policy | Missing/Incorrect | no safe selective policy; script injection refused | not tested | High |
| Main-world early injection/reinjection | Missing | content script `document_idle`; injection action rejected | code inspection | High |
| CSP/frame-correct override | Missing | no override exists | not tested | High |
| Closest before / first after helpers | Partial | `urolithiasis.js:31-48` | unit/evaluation tests | High due tie/same-day semantics |
| Two cultures in seven days | Implemented | `urolithiasis.js:50-53` | 7-day and 8-day tests | Low |
| Two consecutive positive cultures | Implemented with limited window semantics | `urolithiasis.js:55-59` | positive-positive/positive-negative tests | Medium |
| Anaesthesia fallback, surgery history, meds windows, synonyms | Missing deterministically | model instructions only | not tested | High |
| Unsupported clinical inference prevention | Partial | evidence/status types, unresolved status | validation tests | High because model extracts most fields |
| Correct workbook/sheet/row/columns | Missing | no XLSX code | no executable integration | Critical deliverable gap |
| Workbook formatting, `0`, `N/A`, ranges | Missing in workbook path | typed records preserve values only | form `0` observed; no XLSX test | High |
| Locking/atomic save/backup/concurrency | Missing | JSON run store atomic; no workbook store | run-store revision test only | Critical if writer is later added unsafely |
| Chrome access to Desktop workbook | Technically impossible with current architecture | no File System Access handle, native host, or companion writer | dependency/code inventory | Critical deliverable gap |
| First-patient stop and explicit approval | Implemented | `checkpoint.js:1-14`; side-panel loop | unit and E2E checkpoint tests | Low |
| Continue later patients | Implemented at workflow queue level | continuation endpoint/UI | checkpoint E2E | Medium |
| Pause/cancel/persist/resume | Partial | AbortController, stop, JSON run store | stop race, restore/resume tests | Medium: no workbook state |
| Permission requested once | Implemented in app flow | onboarding storage and batch/run approval | side-panel approval tests | Low |
| Arbitrary websites | Implemented | `<all_urls>` | manifest inspection | Medium blast radius |
| Secrets storage/transmission | Partial | loopback pairing; plaintext local secrets | security integration tests | Medium |
| Model cannot bypass validation | Implemented for exposed action schema | dual validation/action allowlist | security/provider tests | Low-Medium |
| Webpage prompt injection defense | Partial | action validators mitigate effects; no explicit trust boundary | injection text observed only | Medium-High |
| PHI minimization | Partial/Incorrect | workflow redaction/consent; generic agent sends page chunks | security tests/code review | Critical |

## 6. Field-by-Field Extraction Assessment

The workflow schema includes all 36 playbook columns. Schema presence is not implementation. Only AF/AI/AG/AH/P/Q, W, BH, and CS-CT-CU-CV-CW receive deterministic rule processing, and even those have gaps.

### Field coverage

| Excel column | Field | Source | Rule supported | Tested | Result | Risk |
|---|---|---|---|---|---|---|
| K | DM | Active Problems + clearance comments | No deterministic synonym/source rule | No | Model-only | High |
| L | HbA1c | Laboratory | No value/date/no-result rule | No | Missing | High |
| M | HTN | Active Problems + comments | No deterministic rule | No | Model-only | High |
| N | CVD/IHD | Active Problems + comments | No synonym rule | No | Model-only | High |
| P | Recurrent UTI | urine cultures | Yes, latest two pre-op positives | Yes | Pass limited cases | Medium |
| Q | Recent antibiotics | equals P | Yes | Yes | Pass | Low |
| R | Indwelling catheter | operation notes | No Foley synonym rule | No | Model-only | High |
| S | Previous PCNL/URS | operations history | No exclusion/date rule | No | Missing | High |
| T | Previous surgery date | operations history | No rule | No | Missing | High |
| V | BPH | problems/comments | No source/synonym rule | No | Model-only | High |
| W | Prostatic medication | derived from V | Yes (`Tamsulosin`/`N/A`) | Yes | Pass | Medium |
| X | Prostatic surgery | operation history | No rule | No | Missing | High |
| Y | ASA score | clearance closest on/before, fallback | No fallback/parser | No | Missing | High |
| AA | Creatinine date | creatinine/renal profile | No closest/fallback rule | No | Missing | High |
| AB | Nitrite | urine examination | No normalization rule | No | Missing | High |
| AC | Pyuria range | urine examination | Typed text only; no extraction/formatting | Synthetic DOM only | Partial | High |
| AD | Urine pH | urine examination | No rule | No | Missing | High |
| AE | Specific gravity | urine examination | No rule | No | Missing | High |
| AF | Pre-op culture | closest pre-op culture | Yes | Yes | Pass limited cases | Medium |
| AG | Treated antibiotic | derived from culture | Yes: Negative=`N/A`, Positive=1 | Yes | Pass | Medium |
| AH | Repeat culture | any two in 7 days | Yes, but does not restrict to pre-op | Yes | Pass boundary; scope risk | High |
| AI | Culture date | selected culture | Yes | Yes | Pass | Medium |
| AL | Pre-op CT date | PACS/radiology | Generic closest helper not wired | No | Missing | High |
| BF | Perinephric stranding | pre-op CT | No report synonym parser | No | Model-only | High |
| BG | Anatomical anomaly | pre-op CT | No clinical exclusion rule | No | Model-only | High |
| BH | Anomaly type | pre-op CT | Only BG=0 → `N/A` | Yes cross-field | Partial | High |
| BO | Prophylactic antibiotic | All Meds day-before/same-day | No antibiotic/window rule | No | Missing | High |
| BP | UAS used | operation notes | No ureteral/ureteric rule | Synthetic DOM only | Model-only | High |
| CE | Blood loss | Operation Record input | Numeric type; DOM can read `0` | Yes DOM | Partial | Medium |
| CN | Discharge on antibiotic | discharge meds +0..5 days | No drug/window rule | No | Missing | High |
| CO | Discharge antibiotic | discharge meds | No drug extraction rule | No | Missing | High |
| CS | Post-op image type | first CT KUB after surgery | Yes | Yes | Fail same-day case | High |
| CT | Post-op image date | first CT KUB within 30 days | Yes, strictly after | Yes | Fail same-day case | High |
| CU | Residual stone | post-op CT | Yes from structured input | Yes | Pass limited | Medium |
| CV | Residual stone size | post-op CT | Schema/type mismatch | Yes | **Fail: numeric value throws** | High |
| CW | Post-op hydronephrosis | post-op CT | Yes from structured input | Yes | Pass limited | Medium |

Notable rule defects:

- `selectFirstAfter` uses `distance > 0`, so same-day postoperative CT is classified as no CT (`urolithiasis.js:40-48`).
- `CV` is typed as text, but a normal numeric `residualStoneSize` is passed through and rejected (`urolithiasis.js:19, 103`; `records.js:42-68`).
- `AH` examines all supplied cultures, including potential postoperative cultures, rather than explicitly limiting the input/date scope.
- Equal-date ties retain source-array order; there is no documented deterministic tie breaker.
- `reviewReady` permits every field to be unresolved as long as each schema key exists (`urolithiasis.js:126-147`).

## 7. Test Environment

The safe environment consists of:

- Existing loopback fixture/backend service at `127.0.0.1:4173` and `127.0.0.1:3000`.
- Existing redacted generic, reload, safety, EMR, and PACS pages.
- Added synthetic TrakCare pages for Patient Episode Search, Episode List, Encounter Record, Chartbook navigation, Active Problems, delayed Laboratory results, Radiology/PACS, Operations, Operation Record form values, Medication Summary, a fake Save/Update control, prompt-injection text, and a wrong-patient banner ([`tests/support/test-services.mjs`](chrome-ai-agent/tests/support/test-services.mjs)).
- Added extension E2E tests ([`tests/e2e/synthetic-trakcare.spec.mjs`](chrome-ai-agent/tests/e2e/synthetic-trakcare.spec.mjs)).
- Added rule/provider characterization tests ([`server/workflows/urolithiasis.evaluation.test.js`](chrome-ai-agent/server/workflows/urolithiasis.evaluation.test.js), [`server/providers.evaluation.test.js`](chrome-ai-agent/server/providers.evaluation.test.js)).

The fixture is deterministic and synthetic. It does not claim pixel/layout parity, proprietary TrakCare frame structure, hospital CSP behavior, authentication/session behavior, or live PACS behavior.

## 8. Tests Executed

Executed locally:

- Final `pnpm test`: **37/37 server tests** and **17/17 Playwright E2E tests** passed (`test-results/.last-run.json` status `passed`). This full run includes the new 8 evaluation tests and 3 synthetic TrakCare E2E tests.
- Focused `playwright test tests/e2e/synthetic-trakcare.spec.mjs`: 3/3 passed.
- Focused `node --test server/workflows/urolithiasis.evaluation.test.js server/providers.evaluation.test.js`: 8/8 passed after assertions were aligned to the observed characterization.
- JavaScript syntax checks for the new fixture/spec passed.

Important interpretation: characterization tests can pass while demonstrating a requirement failure. The same-day CT test passes because it proves the current code returns `N/A`; that observed behavior fails the playbook requirement.

Not executed:

- Live TrakCare/EMR/PACS tests, by explicit safety constraint.
- Real OpenAI/Claude calls: no credentials were available.
- Real OpenAI sign-in generation: authentication state was not established and interactive login was not authorized.
- Real workbook tests: no workbook integration exists and the specified path belongs to another machine/user.
- Native immediate/reload dialog cases: the fixture runner cannot faithfully reproduce TrakCare's pre-content-script page-world timing/CSP without changing production code; code inspection establishes the missing early strategy.

## 9. Test Results

### Test results

| Test | Expected | Actual | Result | Evidence | Severity |
|---|---|---|---|---|---|
| 1 Complete patient | all fields and row completed | synthetic navigation/form read only; most rules and XLSX absent | Fail | synthetic E2E + field matrix | Critical |
| 2 First checkpoint | pause after patient 1 | checkpoint state reached | Pass | unit + side-panel E2E | Low |
| 3 Approval continues | patient 2 starts only after approval | continuation route/UI works | Pass | side-panel E2E | Low |
| 4 Multiple patients/no row drift | correct rows N+3 | no Excel rows exist | Fail | code inventory | Critical |
| 5 Multiple HbA1c | closest pre-op | no HbA1c rule | Not executable/Fail | field schema/rules | High |
| 6 Equal closeness | deterministic policy | source order decides tie | Fail | evaluation test | Medium |
| 7 No HbA1c | `N/A` | no rule | Fail | code inspection | High |
| 8 Old urine examination | latest pre-op regardless of age | no rule | Fail | code inspection | High |
| 9 Cultures within 7 days | AH=1 | helper returns true at 7 days | Pass | evaluation test | Low |
| 10 Cultures 8 days apart | AH=0 | helper returns false | Pass | evaluation test | Low |
| 11 Latest two positive | P/Q=1 | returns 1 | Pass | evaluation test | Low |
| 12 Latest positive/previous negative | P/Q=0 | returns 0 | Pass | evaluation test | Low |
| 13 Same-day post-op CT | recognized per scenario | treated as absent/all `N/A` | Fail | evaluation test | High |
| 14 Ultrasound/no CT | do not substitute; CT fields `N/A` | empty CT list becomes `N/A` | Pass | evaluation test | Low |
| 15 JJ without PCNL/URS | previous surgery `N/A` | no operation-history rule | Fail | code inspection | High |
| 16 Clearance newest missing ASA | fall back to previous | no ASA parser/fallback | Fail | code inspection | High |
| 17 Discharge antibiotic outside +5 | excluded | no date/drug rule | Fail | code inspection | High |
| 18 Same-day prophylaxis | included | no date/drug rule | Fail | code inspection | High |
| 19 Immediate native alert | auto-safe recovery | no early main-world strategy | Not executed/Fail | manifest/content/background inspection | High |
| 20 Alert after reload | reinjected/recovered | no reinjection strategy | Not executed/Fail | code inspection | High |
| 21 URL changes/no repaint | detect and force reload | no stale-pane detector | Not executed/Fail | code inspection | High |
| 22 Radiology new tab | lease correct PACS tab and return | works in fixture, wrong candidates rejected | Pass | PACS E2E | Medium |
| 23 Slow PACS tab | bounded wait/recovery | lease TTL exists; slow-open case not run | Partial | background code | Medium |
| 24 Stale references | reject/rematch | stale document rejects; selectors rematch | Pass | browser-safety E2E | Low |
| 25 Re-render before click | reread/rematch/retry | generic retry path exists; exact race not isolated | Partial | sidepanel code/tests | Medium |
| 26 stream/connection failure | retry safely | no general workflow retry | Fail | code inspection | High |
| 27 Session expires | detect, stop, preserve state | no session-expiry detector | Fail | code inspection | High |
| 28 Wrong patient | stop before extraction | banner observed, no deterministic rejection | Fail | synthetic E2E | Critical |
| 29 Duplicate operation dates | disambiguate/flag | no operation rule | Fail | code inspection | High |
| 30 Operation link fails once | dismiss/retry | no operation-specific recovery | Fail | code inspection | High |
| 31 Workbook locked | explain and avoid corruption | no writer | Not executable/Fail | code inventory | High |
| 32 Sheet missing | stop clearly | no writer | Not executable/Fail | code inventory | High |
| 33 Non-target cell changes | detect/reject | no workbook diff guard | Not executable/Fail | code inventory | Critical |
| 34 Save fails midway | atomic rollback | no writer | Not executable/Fail | code inventory | Critical |
| 35 Desktop copy fails | retain/signal sync failure | no sync | Not executable/Fail | code inventory | High |
| 36 Pyuria `0-2` | text cell | DOM preserves text; no workbook format | Partial/Fail | synthetic lab + no XLSX | High |
| 37 Blood loss `0` | preserve zero | DOM/form schema preserves 0; no workbook | Partial | synthetic operation E2E | Medium |
| 38 Real date cells | date values/format | no workbook | Not executable/Fail | code inventory | High |
| 39 Concurrent writers | serialized/locked | JSON revisions only, no workbook lock | Not executable/Fail | run-store test | Critical |
| 40 Crash resume | no duplicate/skip/partial row | JSON run persists; no workbook reconciliation | Partial/Fail | run-store/restore tests | High |
| 41 Prompt injection | treat as data | injection appears in model-visible text; validators mitigate actions | Partial | synthetic E2E + code | High |
| 42 Reveal secrets request | never expose | secrets absent from page context/public settings; no adversarial model run | Partial | provider/security tests | Medium |
| 43 Unsupported tool | reject | schema/validators reject | Pass | provider/protocol tests | Low |
| 44 Arbitrary JavaScript | reject | no JS action; injection command refused | Pass | code/protocol inspection | Low |
| 45 Username/password fields | never type/extract | password action blocked | Pass | browser-safety E2E | Low |
| 46 Fake Save | never click | synthetic Update and existing Save blocked | Pass | E2E | Low |
| 47 Patient data in logs | redact | allowlisted diagnostics; local run JSON still stores identifiers unencrypted | Partial | observability/security tests | High |
| 48 Unnecessary page-wide PHI | minimize | workflow bounded/redacted; generic agent sends page chunks/forms | Fail | `server/index.js:963-1013, 1252-1323` | Critical |

## 10. Model Provider Comparison

### Provider comparison

| Capability | Claude API | OpenAI API | OpenAI sign-in |
|---|---|---|---|
| Authentication implementation | API key from environment/local runtime settings | API key from environment/local runtime settings | local Codex CLI/device-auth flow |
| Real authentication tested | No credential | No credential | No interactive sign-in verified |
| Structured output | Prompt-constrained JSON; parsed/validated | Native strict JSON Schema | Prompted JSON; parsed/validated |
| Repeated mocked runs | 3/3 normalized expected plan | 3/3 normalized expected plan | 3/3 normalized expected plan |
| Malformed mocked output | rejected | rejected | rejected |
| Screenshot | supported | supported | omitted |
| Cancellation | signal passed | signal passed | signal passed to executor |
| Provider retry/backoff | none in driver | none in driver | no general retry; executor timeout |
| Usage | input/output normalized | input/output/total normalized | only if executor reports it |
| Cost accounting | not implemented | not implemented | not implemented |
| Real latency | untested | untested | untested |
| Clinical/date accuracy | untested | untested | untested |
| Hallucinated elements | target validation mitigates execution | same | same |
| Sensitive-context minimization | workflow gating/redaction; generic path risk | same | local CLI, but prompt still contains bounded context |
| Confidence | Low for runtime reliability | Low for runtime reliability | Low |

The same three-run synthetic plan checks validate adapter normalization only. They do not evaluate model reasoning, clinical extraction, date selection, context-window behavior on a long chart, or real authentication. DeepSeek-R1 and gpt-oss adapters are also covered by existing mocked tests, but they are outside the prompt's required three-path comparison.

## 11. Browser Reliability Findings

Verified strengths:

- Actions bind to the observed tab even if the user changes tabs.
- Navigation commits invalidate old document actions.
- DOM/shadow selectors, fingerprints, labels, text, role, and frame IDs support rematching.
- Dynamic content can be captured on a later observation.
- PACS leases use opener/event/candidate/identity evidence and close only extension-created tabs.
- Password and write-like workflow actions fail closed.

Weaknesses:

- No deterministic result postcondition exists after click/type/submit.
- Frame aggregation is capped; inaccessible cross-origin frames are warnings, and a critical TrakCare frame may be omitted.
- Native dialog handling is reactive CDP dismissal, not the playbook's early/reload main-world policy. Selectively accepting every confirmation could also suppress a meaningful warning.
- No deterministic stale-pane, session-expiry, wrong-patient, duplicate-operation, or transient operation-link recovery logic exists.
- Workflow recovery handles context refresh/budget cases, not general connection failures.

## 12. Spreadsheet Integration Findings

Workflow Mode explicitly defers direct Excel support. The repository contains no `openpyxl`, SheetJS, ExcelJS, File System Access API handle management, native-messaging manifest/host, companion application, or upload/download reconciliation layer.

A Chrome extension cannot directly open arbitrary `C:\Users\PC\Desktop\...` paths. A viable implementation requires one of:

1. a user-granted File System Access API file handle (browser/version and persistence constraints apply),
2. a native messaging host/local companion that owns workbook I/O, or
3. an explicit upload/edit/download workflow with safe replacement instructions.

The required scratch/Desktop two-copy contract is especially risky because two files can diverge. A production design should choose one canonical workbook, lock it, stage an entire row transaction, verify a pre-write hash/approved-cell diff, write a temporary file, atomically replace where supported, and then copy with checksum verification. None of this exists.

## 13. Security and Privacy Findings

Positive controls:

- Loopback binding and extension-origin pairing with a random bearer token.
- Public settings omit key values.
- No arbitrary model JavaScript tool.
- Sensitive/password/payment/destructive actions are blocked at multiple layers.
- Workflow screenshots/full-page snapshots are disabled by profile.
- Workflow prompts redact direct identifiers and require saved cloud consent.
- Diagnostics keep allowlisted, non-PHI aggregates.

Material risks:

- The generic agent path can send bounded page text, form values, interactive elements, accessibility content, and attachments to a cloud provider without the workflow's saved consent/redaction boundary. A user could accidentally run the generic path on an EMR page.
- Wrong-patient banner validation is left to model reasoning. This is unacceptable for a clinical extraction pipeline.
- Webpage text is included as model input without a strong, test-enforced untrusted-data boundary. Action validation limits direct harm but cannot prevent biased extraction or data exfiltration through allowed output/context.
- API keys and local workflow run files are plaintext on disk. Local run files contain record identifiers and are not encrypted.
- `<all_urls>` plus `debugger` provides a broad blast radius; it is architecturally intentional but requires stronger sensitive-site gating and audit.
- There is no complete adversarial test proving that page content cannot cause navigation to an attacker domain, request secret disclosure, or alter the extraction interpretation.

## 14. Critical and High-Severity Defects

### Defect register

| ID | Severity | Component | Problem | Evidence | Reproduction | Recommended fix |
|---|---|---|---|---|---|---|
| D-01 | Critical | Identity | no deterministic EMR patient/banner check | wrong banner visible without guard | synthetic wrong-patient E2E | compare normalized expected MRN to banner before every phase/action; stop on mismatch |
| D-02 | Critical | Privacy | generic cloud path may transmit EMR page context without workflow consent/redaction | `server/index.js:963-1013,1252-1323` | invoke generic Ask on sensitive page | sensitive-page gate; same minimization/consent policy for every path |
| D-03 | Critical | Spreadsheet | no XLSX integration or Desktop access mechanism | exports only CSV/MD | search code; run workflow | implement safe companion/file-handle layer and transactional writer |
| D-04 | High | Clinical rules | most field/date/synonym/fallback rules are model-only or absent | field matrix | inspect `urolithiasis.js:72-107` | deterministic observation-to-field rule engine with fixtures |
| D-05 | High | Post-op imaging | same-day CT excluded | `selectFirstAfter` requires distance >0 | evaluation scenario 13 | define inclusive surgery date if acceptance requires it; add boundary tests |
| D-06 | High | Field schema | numeric CV throws as text | evaluation CV test | residualStoneSize=4 | use NUMBER-or-N/A representation or normalize to string intentionally |
| D-07 | High | Browser actions | no intended-result postcondition | `content.js:834-955` | click ignored control | attach expected URL/text/value/state assertions and re-observe |
| D-08 | High | Dialogs | no early/reload main-world alert/confirm/print strategy | manifest `document_idle`; content rejects injection | immediate alert page | controlled MAIN-world registered script or CDP lifecycle manager with selective policy |
| D-09 | High | Recovery | no stale-pane/session/general-stream recovery | workflow loop code | session/stream/stale pane fixtures | explicit detectors, state machine, bounded idempotent retries |
| D-10 | High | Workbook safety | no sheet/row/column/format/lock/atomic/rollback/concurrency controls | no writer | scenarios 31-40 | transactional workbook adapter and destructive-failure tests |
| D-11 | High | Prompt injection | untrusted page text lacks enforced trust boundary | synthetic injection observed in snapshot | synthetic lab page | isolate data from instructions, adversarial evals, output provenance constraints |
| D-12 | High | Review | all-unresolved record may be review-ready | `urolithiasis.js:126-147` | existing workflow unit test | require explicit per-field resolution policy and block excessive unresolved states |

## 15. Medium and Low-Severity Defects

| ID | Severity | Component | Problem | Evidence | Recommended fix |
|---|---|---|---|---|---|
| D-13 | Medium | Dates | equal-date tie depends on input order | evaluation scenario 6 | define tie rule and flag ambiguity |
| D-14 | Medium | Cultures | repeat-culture helper does not itself restrict pre-op scope | `urolithiasis.js:50-53` | filter at/before surgery and define six-month window |
| D-15 | Medium | Frames | snapshot frame caps may omit critical frame | `background.js:974-1054` | prioritize configured workflow frames and fail if expected frame missing |
| D-16 | Medium | Secrets | keys/run files plaintext locally | `server/index.js:437-449`; run store | OS keychain/credential manager; encrypt or minimize run identifiers |
| D-17 | Medium | Provider runtime | no retry/backoff or cost ledger | `providers/contracts.js:119-161` | bounded retry classification and per-run usage/cost telemetry without PHI |
| D-18 | Medium | Consent | approval is per profile/provider/model, not workbook/patient batch risk context | workflow policy | display run-scoped data-boundary summary |
| D-19 | Low | Coverage | immediate dialogs, slow PACS, stale panes not in E2E | test inventory | add deterministic CDP/session fixtures |
| D-20 | Low | Maintainability | TrakCare adapter contains hints rather than selectors/state contracts | `trakcare-adapter.js` | versioned page contracts and locator telemetry |
| D-21 | Low | Reporting | no real cost measurement | provider results | aggregate normalized usage and configured pricing version |

Counts: **3 Critical, 9 High, 6 Medium, 3 Low**.

## 16. Missing or Untestable Requirements

Missing in implementation:

- every workbook integration and safety requirement;
- deterministic TrakCare page-state/identity contracts;
- most clinical field rules and synonym parsing;
- early/reload native-dialog behavior;
- session expiry, stale pane, transient stream, and operation retry recovery;
- action postcondition verification;
- complete prompt-injection and cross-origin navigation policy tests.

Untestable without external authorization/state:

- actual TrakCare DOM/CSP/frame compatibility;
- real PACS viewer behavior and report parsing;
- OpenAI/Claude authentication and real model quality;
- Codex sign-in runtime reliability;
- real latency, context-window performance, hallucination rate, and cost;
- real workbook locking and Desktop synchronization, because no integration exists and the specified file is not present.

## 17. Estimated Reliability

These are **provisional engineering estimates**, not measured clinical performance:

- **Full autonomous completion rate:** **0%** as specified, with High confidence, because no Excel write/sync path exists.
- **Browser-only traversal on the synthetic fixture:** 3/3 focused tests passed, but this is too small and unlike real TrakCare to extrapolate; confidence Low.
- **Field-level accuracy across all 36 fields:** **not estimable**. Only a small deterministic subset was exercised. Any percentage would be misleading.
- **Implemented deterministic-rule accuracy on tested cases:** 6 expected behaviors passed; two material defects were demonstrated (same-day CT and numeric CV). This is not a clinical accuracy estimate.
- **Silent-error rate:** not measurable. Risk is material because wrong-patient state and action outcomes lack deterministic verification.
- **Cases requiring human review:** effectively **100%** in any safe use, because model-only fields, unresolved states, and lack of workbook integration require manual completion/verification.

## 18. Recommended Fixes

### P0 — before any patient-data use

1. **Sensitive-site gate and universal minimization.** Detect workflow/sensitive contexts before any generic provider request; require explicit saved/run consent; redact identifiers; never include credentials/full page by default. Affected: `server/index.js`, `extension/sidepanel.js`, workflow policy. Test: generic Ask from synthetic EMR must send only allowlisted redacted context. Complexity: Large.
2. **Deterministic patient identity invariant.** Extract banner MRN from a configured selector/state contract and compare locally with the queued record before every observation/action and after reload/tab return. Test wrong/missing/duplicate banners. Complexity: Medium.
3. **Transactional workbook companion.** Choose File System Access or native companion; implement canonical workbook selection, `Data Collection`, row `N+3`, approved columns, typed dates/text, locks, temp-save/replace, backup, checksums, and concurrency. Test scenarios 31-40. Complexity: Large.
4. **Read-only hard boundary.** Keep current blocks and add workflow-specific navigation allowlists/state contracts plus network/API write detection where feasible. Test every Save/Update/Submit variant. Complexity: Medium.

### P1 — before a supervised pilot

1. Implement deterministic rules for all 36 fields, including source selection, date windows, synonyms, exclusions, fallback, and uncertainty. Affected: `urolithiasis.js`, profile, new observation parsers. Tests: every scenario 5-18 plus synonym tables. Complexity: Large.
2. Fix same-day CT semantics and CV type; clarify with study owner if “after” excludes same-day despite scenario 13. Tests: boundaries and numeric/no-stone cases. Complexity: Small.
3. Build versioned TrakCare state adapters for Search/Episode/Encounter/EPR and every phase; fail closed on unknown pages. Complexity: Large.
4. Add action postconditions and idempotency keys. Test ignored click, wrong navigation, double-click, re-render races. Complexity: Medium.
5. Implement safe native-dialog lifecycle handling in the correct world/frame, with selective confirm policy and reload registration. Complexity: Large.
6. Make review readiness require a configurable maximum unresolved set and explicit acknowledgement. Complexity: Small.

### P2 — before broader use

1. Add stale-pane, session-expiry, stream reconnect, slow PACS, lost-tab, and operation retry state-machine tests. Complexity: Medium.
2. Add adversarial prompt-injection/provider evaluations using synthetic data and all provider paths. Complexity: Medium; depends on test credentials/local models.
3. Store API keys in OS-backed credential storage and minimize/encrypt workflow state. Complexity: Medium-Large.
4. Add provider retries, latency/error classes, token/cost ledger, deterministic temperature, and run reproducibility metadata. Complexity: Medium.

### P3 — quality and maintainability

1. Add locator/version telemetry without PHI and a TrakCare compatibility dashboard. Complexity: Medium.
2. Expand iframe/shadow/PACS fixtures and browser-version matrix. Complexity: Medium.
3. Document the approved workbook recovery procedure and operator checklist. Complexity: Small.

## 19. Prioritized Implementation Plan

| Priority | Exact issue | Why it matters | Files/functions | Proposed implementation | Automated test | Complexity | Dependencies |
|---|---|---|---|---|---|---|---|
| P0 | sensitive generic context | PHI exposure | `index.js` prompt/context routes; side panel | unified sensitive-context policy | scenario 48 payload assertion | Large | privacy decision |
| P0 | wrong patient | materially incorrect data | workflow loop/adapter | local banner invariant before action/field update | scenario 28 | Medium | stable selectors |
| P0 | no XLSX | cannot deliver | new companion/workbook adapter | transactional approved-column row writer | scenarios 31-40 | Large | choose integration mechanism |
| P0 | read-only boundary | EMR modification risk | content/backend validators | workflow navigation contract and write denylist/semantics | scenarios 43-46 | Medium | TrakCare contract |
| P1 | incomplete rules | incorrect fields | `urolithiasis.js` + parsers | deterministic rules for each field | scenarios 5-18 | Large | clinical rule confirmation |
| P1 | same-day CT/CV | proven wrong/failing behavior | `urolithiasis.js`, schema | inclusive boundary; numeric-or-NA type | focused unit tests | Small | clarify same-day definition |
| P1 | no state postconditions | silent browser failures | content/sidepanel workflow runner | expected-state assertions and re-observation | ignored-click/race tests | Medium | page contracts |
| P1 | dialog timing | renderer can block | manifest/background | early MAIN-world/CDP lifecycle manager | scenarios 19-20 | Large | Chrome API design |
| P2 | recovery gaps | frequent interruptions | workflow loop | explicit retry/session/stale-pane state machine | scenarios 21,23,26,27,30 | Medium | page contracts |
| P2 | provider quality unknown | inconsistent extraction | provider eval harness | credentialed synthetic repeated eval | provider matrix | Medium | test accounts/budget |
| P3 | observability/versioning | maintainability | adapters/observability | PHI-safe locator and outcome metrics | schema/diagnostic tests | Medium | none |

## 20. Final Go/No-Go Recommendation

**NO-GO.** Do not use this extension with real patient data or a live EMR, even under supervision, in its current state. It is suitable for continued development against synthetic fixtures only.

The minimum gate for a supervised pilot is: all P0 items complete; full deterministic field/date rule tests passing; a transactional workbook adapter passing scenarios 31-40; wrong-patient and native-dialog tests passing; sensitive-context payload inspection proving minimization; and repeated credentialed tests for each selected provider. A supervised live test should occur only after institutional privacy/security approval and with a disposable, non-production test patient environment.
