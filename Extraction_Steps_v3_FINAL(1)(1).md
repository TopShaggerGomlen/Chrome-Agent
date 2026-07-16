# Urolithiasis Study — Clinical Data Extraction Playbook (v3, self-contained)

You are a Cowork/Claude agent extracting clinical data from the **KAMC TrakCare EMR** into an Excel study sheet. This document is everything you need to start working immediately.

---

## 1. Goal & deliverable
For each patient row, pull a defined set of fields from TrakCare and write them into the spreadsheet, one patient at a time. After the **first** patient of a run, stop and show the completed row for review; once approved, continue automatically through the rest.

**Spreadsheet:** `C:\Users\PC\Desktop\Stone Study\Stone_Study_Data.xlsx`, sheet **"Data Collection"**.
Working scratch copy (edit here, then copy to the Desktop file so the user can open it): keep both in sync on every save.

**Row mapping:** header is row 3; patient #1 = row 4. **Patient #N = Excel row N+3** (e.g. #21 = row 24).
Each row already contains identification (center, surgery date, surgery type, MRN, age) and some stone-measurement fields pre-filled by the researcher. **Only fill the fields listed in §4. Never overwrite other cells.**

---

## 2. Browser tooling rules (Claude for Chrome)
- Drive the page with **`read_page`** (get element refs), **`find`** (locate by description), and click/interact **by `ref`, not coordinates**.
- Read data with **`get_page_text`** (great for lists/reports) or **`javascript_tool`** (to read form-field input values that `get_page_text` misses).
- **NEVER take screenshots** unless the user explicitly asks.
- **Auto-dismiss native pop-ups:** TrakCare shows blocking "his.kamc.med.sa says" dialogs (eligibility, financially-discharged, etc.). These freeze page tools. **Immediately after the patient's record opens, and again after any full page (workflow) reload, inject this once** so all such dialogs auto-answer OK:
  ```js
  window.alert=function(){};window.confirm=function(){return true;};window.print=function(){};'ok'
  ```
  If a dialog still froze the renderer before you injected (find/get_page_text time out), `navigate` to the current list URL to clear it, inject the override, then retry.
- **Content pane not repainting** after a left-menu (Chartbook) click — the URL changes but the old panel stays. Fix: **`navigate` to that same new URL** to force a repaint.
- Connection drops ("Stream closed") are transient — re-read `tabs_context_mcp` and retry.
- The EMR tab must be inside the automation tab group. Radiology reports open a separate **"XERO Viewer"** browser tab (PACSViewer).
- **Never type into User/Password fields.** Never perform write actions (Save/Update) — this is read-only extraction.

---

## 3. Opening a patient
**Prerequisite:** TrakCare open and logged in.

**First patient of a session** (from Patient Episode Search): type the MRN into the **URN** field → **Find** → click the URN in the Patient List → this opens the **Episode List**.

**Every subsequent patient:** click the **≡ main menu (top-left)** → **Care Provider Review** → this returns to the **Patient Episode Search** (URN field). (If it shows the previous patient, `navigate` to the Care Provider Review workflow URL to force the fresh search form.) Enter the next MRN → Find → click URN.

**Then, from the Episode List:** click the **⋯ action menu** on any recent episode row → **Encounter Record**. In the Encounter Record, click the **EPR** icon (left sidebar) to open the **Chartbook** (left nav with Laboratory, Radiology, Operations, Medication Summary, etc.).

**Re-inject the auto-OK override** now (the record open is a full page load).

Confirm you're on the right patient (URN/name in the banner). Note: banner **age = today's age**, not age at surgery — don't use it to validate the sheet's age.

Read the **Date of Surgery** from the Excel row (column C) — it anchors every "closest before/after surgery" decision below.

---

## 4. Fields to fill (column → rule)

### Section B — Comorbidities (from Active Problems + Anaesthesia Clearance comments)
Open the EPR **Active Problems** panel (Patient Summary). Also read the **Comments** field of the **Anaesthesia Clearance** (see Step 10) — it often lists chronic conditions — and combine both sources.
- **K — DM (0/1)** — Diabetes mellitus present.
- **M — HTN (0/1)** — Hypertension present.
- **N — CVD (0/1)** — cardiovascular disease; count **IHD / Ischemic heart disease**.
- **V — BPH (0/1)** — benign prostatic hyperplasia present.
- **W — Prostatic Medications** — if BPH=1 write **"Tamsulosin"**; if BPH=0 write **"N/A"**.
- **P — Recurrent UTI ≥2/6mo (0/1)** — look at the **latest urine culture**: if **Positive**, check the **culture before it** — if that is **also Positive** → **1**; any other case → **0**.
- **Q — Recent Abx <3mo (0/1)** — enter the **same value as P (Recurrent UTI)**.
- **R — Indwelling Catheter (0/1)** — from the operative notes (Step 8): if an indwelling catheter (e.g. **Foley's**) was used for the surgery → **1**, else **0**.

### Section C — Pre-op labs (Chartbook → Laboratory → Lab Results - All Episode; use the tabular search box)
- **L — HgbA1c (%)** — search "a1c"; value of the result **closest before surgery**. If no HbA1c exists at all → **"N/A"**.
- **AF — Preop Urine Culture** — search "urine" → open **Urine Culture/Sensitivity** closest before surgery; enter **"Negative"** (no growth) or **"Positive"** (growth).
- **AI — Date of Urine Culture** — that culture's collection date.
- **AH — Repeat Urine Culture (0/1)** — **1** if two urine cultures fall within any **7-day span**, else **0**.
- **AG — Treated with Antibiotic** — if the preop culture was **Negative** → **"N/A"**; if **Positive** → **1**.
- **AD / AE / AC / AB** — from **URINE EXAMINATION** (latest before surgery, regardless of age): **Urine pH**, **Urine Sp. Gravity**, **UA: Pyuria (WBC/HPF)** = the "WBC In Urine" value (enter as text, e.g. `0-2`), **UA: Nitrite** = 0 (Neg) / 1 (Pos).
- **AA — Date of Creatinine Test** — date (only) of the **Creatinine, Blood** result closest before surgery; if none, use a **Renal Profile** date.

### Section D — Pre-op CT (Chartbook → Radiology → Radiology Results; open via **PACSViewer** approved report)
Pre-op CT KUB = the **CT KUB closest before** surgery.
- **BF — Perinephric Stranding (0/1)** — perinephric fat stranding present.
- **BG — Anatomical Anomaly (0/1)** — congenital anomaly present (an obstructing stone + hydronephrosis or simple renal cysts are **not** anomalies).
- **BH — Specify Anomaly** — anomaly type if BG=1; if no anomaly → **"N/A"**.
- **AL — Date of CT Pre-op** — that CT's date.

### Section E — Operative (Chartbook → Operations)
From **Anaesthetic and Operation - All Episode**, find the operation matching the Excel surgery date.
- **S — Previous Stone Surg.** — any **PCNL or URS** stone surgery before this date → its type; else **"N/A"**. (A JJ-stent insertion alone is **not** PCNL/URS.)
- **T — Date of Prev. Surgery** — its date, else **"N/A"**.
- Open the index op's **operation-number (OR…) link → Operation Record**:
  - **CE — Est. Blood Loss (mL)** — the Estimated Blood Loss value (0 is valid). *(Read form input values with `javascript_tool`.)*
  - **BP — UAS Used (0/1)** — read the Operation Notes: ureteral/ureteric **access sheath** used → 1, else 0.
  - **R — Indwelling Catheter** — Foley's/indwelling catheter in notes → 1 (see Section B).
- **X — Prostatic Surgery (0/1)** — any prostate-related operation in history → 1, else 0.
- **Y — ASA Score** — Operations → **Operative Forms** → open the **Anaesthesia Clearance** dated on/before surgery (closest). Read **ASA Classification** (e.g. "2 ASA II" → 2). If it's empty/has no ASA, use the **previous** clearance. (Also read its **Comments** for comorbidities — Section B.)
- **BO — Prophylactic Abx (0/1)** — antibiotic given as surgical prophylaxis: the antibiotic started the day before surgery, or (same-day/emergency admission) the pre-op antibiotic on the surgery day (e.g. Ceftriaxone 2g IV before the op). Present → 1, else 0. Check **All Meds** (Medication Summary).

### Section F — Post-op (30 days)
- **Post-op CT KUB** = **first CT KUB after** surgery (open via PACSViewer):
  - **CS — Post-op 1st Image Type** — e.g. "CT KUB".
  - **CT — Date of 1st Post-op Image** — its date.
  - **CU — Residual Stone (0/1)** — residual stone present.
  - **CV — Residual Stone Size (mm)** — size if present.
  - **CW — Post-op Hydronephrosis (0/1)** — hydronephrosis present.
  - **If there is NO post-op CT KUB:** set **CS, CT, CU, CW** all to **"N/A"**; set **CV** to **"N/A"** (also "N/A" if a post-op CT exists but shows no stone). Do not substitute an ultrasound.
- **CN — Discharge on Abx (0/1) + CO — Discharge Abx — Specify** — Medication Summary → **Discharge Meds (All Episodes)** (grouped by episode). Find the **index admission's episode** (discharge meds dated within surgery-date → +5 days). If any is an **antibiotic** → CN=1 and put the drug name in CO (e.g. Ciprofloxacin); else CN=0.

---

## 5. Sheet conventions (match existing rows)
- **Dates:** write real dates, number format `d/m/yyyy` (the "[AUTO]" columns compute day-differences from real dates).
- **0/1 fields:** 1 = yes/present, 0 = no/absent; don't leave blank once determined.
- **"N/A"** (text) is the convention for "not applicable / not found", per the rules above.
- **Pyuria** and similar range values: store as **text** (format cell `@`) so `0-2` / `6-10` aren't converted to dates.
- If a value genuinely can't be found after checking, leave blank and **flag it** in your per-patient summary.

---

## 6. Writing to Excel (openpyxl)
Load the workbook, write only the mapped cells for the patient's row, set `number_format='d/m/yyyy'` on date cells and `'@'` on text-range cells, save, then copy the file to the Desktop path so the user can open it. Ask the user to keep the file **closed** in Excel while you write (Excel locks open files). Example:
```python
import openpyxl, datetime
wb = openpyxl.load_workbook(fn); ws = wb['Data Collection']; r = <row>
ws.cell(row=r, column=<col>).value = <value>   # repeat per field
# date cells: cell.number_format='d/m/yyyy'; pyuria cell: '@'
wb.save(fn)
```

---

## 7. Checkpoint & flow
1. Open patient → inject override.
2. Steps: comorbidities → labs → pre-op CT → operative → post-op CT → medications.
3. Write row, sync to Desktop, give a short summary + flag uncertainties.
4. **First patient of a run: STOP for review.** After approval, loop to the next patient automatically.

---

## 8. Known pitfalls (from validated runs)
- Native "his.kamc.med.sa says" pop-ups block everything → the auto-OK override (§2) is mandatory; without it, clicks/reads time out.
- Chartbook pane doesn't repaint after menu clicks → re-`navigate` to the same URL.
- Operation-number link occasionally throws "An error has occurred…" → dismiss and retry (transient).
- **All Meds** is long and grouped by prescription, not clean date order → for discharge antibiotics use **Discharge Meds (All Episodes)**; for prophylaxis scan All Meds around the surgery date (ceftriaxone STAT is the usual pre-op dose).
- Form field **values** (Operation Record, Anaesthesia Clearance) aren't in `get_page_text` — read them with `javascript_tool` (map label cell → input value). Avoid dumping User/Password fields.
- Banner age = today's age, not age at surgery.
