import crypto from 'node:crypto';

export const SHEET_NAME = 'Data Collection';
export const HEADER_ROW = 3;
export const DATA_START_ROW = 4;
export const ALLOWLIST = Object.freeze(['K','L','M','N','P','Q','R','S','T','V','W','X','Y','AA','AB','AC','AD','AE','AF','AG','AH','AI','AL','BF','BG','BH','BO','BP','CE','CN','CO','CS','CT','CU','CV','CW']);
export const WRITABLE_COLUMNS = ALLOWLIST;
export const ALLOWED_COLUMNS = ALLOWLIST;
export const COLUMN_POLICY = Object.freeze({
 K:'boolean',L:'text',M:'boolean',N:'boolean',P:'boolean',Q:'boolean',R:'boolean',S:'text',T:'date',V:'boolean',W:'text',X:'boolean',Y:'number',AA:'date',AB:'boolean',AC:'text',AD:'text',AE:'text',AF:'enum',AG:'booleanOrNA',AH:'boolean',AI:'date',AL:'date',BF:'boolean',BG:'boolean',BH:'text',BO:'boolean',BP:'boolean',CE:'number',CN:'boolean',CO:'text',CS:'text',CT:'date',CU:'booleanOrNA',CV:'text',CW:'booleanOrNA'
 });
export const DATE_FORMAT = 'd/m/yyyy';
export const EXPECTED_HEADERS = Object.freeze({A:'MRN',B:'Date of Surgery',C:'Surgery Type',D:'Age',K:'DM',L:'HgbA1c (%)',M:'HTN',N:'CVD',P:'Recurrent UTI ≥2/6mo',Q:'Recent Abx <3mo',R:'Indwelling Catheter',S:'Previous Stone Surg.',T:'Date of Prev. Surgery',V:'BPH',W:'Prostatic Medications',X:'Prostatic Surgery',Y:'ASA Score',AA:'Date of Creatinine Test',AB:'UA: Nitrite',AC:'UA: Pyuria (WBC/HPF)',AD:'Urine pH',AE:'Urine Sp. Gravity',AF:'Preop Urine Culture',AG:'Treated with Antibiotic',AH:'Repeat Urine Culture',AI:'Date of Urine Culture',AL:'Date of CT Pre-op',BF:'Perinephric Stranding',BG:'Anatomical Anomaly',BH:'Specify Anomaly',BO:'Prophylactic Abx',BP:'UAS Used',CE:'Est. Blood Loss (mL)',CN:'Discharge on Abx',CO:'Discharge Abx — Specify',CS:'Post-op 1st Image Type',CT:'Date of 1st Post-op Image',CU:'Residual Stone',CV:'Residual Stone Size (mm)',CW:'Post-op Hydronephrosis'});

export function columnNumber(col) { let n=0; for (const c of col) n=n*26+c.charCodeAt(0)-64; return n; }
export function columnLetter(n) { let s=''; while(n){ const r=(n-1)%26; s=String.fromCharCode(65+r)+s; n=Math.floor((n-1)/26);} return s; }
export function schemaFingerprint(headers, version='1') {
  const normalized = headers.map(h => String(h ?? '').trim().replace(/\s+/g,' ').toLowerCase());
  return crypto.createHash('sha256').update(JSON.stringify({headers:normalized,version})).digest('hex');
}
export function hashIdentity(mrn, surgeryDate) {
  return { mrnHash: crypto.createHash('sha256').update(String(mrn).trim()).digest('hex'), surgeryDateHash: crypto.createHash('sha256').update(String(surgeryDate).trim()).digest('hex') };
}
function stable(v) { if (v instanceof Date) return {__date:v.toISOString()}; if (v && typeof v==='object') { if ('formula' in v) return {formula:String(v.formula),result:stable(v.result)}; if ('richText' in v) return {richText:v.richText.map(x=>({text:String(x.text??''),font:x.font??null}))}; if (Array.isArray(v)) return v.map(stable); return Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])); } return v; }
export function hashRow(values) { return crypto.createHash('sha256').update(JSON.stringify(stable(values))).digest('hex'); }

function dateValue(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(Date.UTC(v.getUTCFullYear(),v.getUTCMonth(),v.getUTCDate()));
  if (typeof v === 'number' && Number.isFinite(v)) { const d=new Date(Date.UTC(1899,11,30)+v*86400000); if (d.getUTCFullYear()>1900) return new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()); }
  const s=String(v ?? '').trim(); let m=s.match(/^(\d{1,2})[\\/-](\d{1,2})[\\/-](\d{4})$/); if (!m) m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/) && [null,RegExp.$3,RegExp.$2,RegExp.$1];
  if (!m) throw new Error('Invalid date'); const d=new Date(Date.UTC(Number(m[3]),Number(m[2])-1,Number(m[1]))); if(d.getUTCFullYear()!=Number(m[3])||d.getUTCMonth()!=Number(m[2])-1||d.getUTCDate()!=Number(m[1])) throw new Error('Invalid date'); return d;
}
export function normalizeValue(column, value, {allowFormulaText=false}={}) {
  const policy=COLUMN_POLICY[column]; if (!policy) throw new Error(`Unknown column ${column}`);
  if (value === null || value === undefined || value === '') return {value:null, unresolved:true};
  const raw=String(value); const isRange=/^\d+\s*-\s*\d+$/.test(raw.trim());
  if (typeof value==='string' && !isRange && /^[=+@]/.test(value) && !allowFormulaText) throw new Error('Formula injection rejected');
  if (typeof value==='string' && value.trim()==='N/A') { if (!['text','date','booleanOrNA'].includes(policy)) throw new Error('N/A not permitted'); return {value:'N/A', numberFormat:'@'}; }
  if (policy==='date') return {value:dateValue(value), numberFormat:DATE_FORMAT};
  if (policy==='boolean' || policy==='booleanOrNA') { if (value===true||value===1||String(value).toLowerCase()==='1'||String(value).toLowerCase()==='true') return {value:1}; if (value===false||value===0||String(value).toLowerCase()==='0'||String(value).toLowerCase()==='false') return {value:0}; throw new Error('Invalid boolean'); }
  if (policy==='number') { const n=Number(value); if(!Number.isFinite(n)||(column==='CE'&&n<0)) throw new Error('Invalid number'); return {value:n}; }
  if (policy==='enum') { const s=String(value); if(!['Positive','Negative'].includes(s)) throw new Error('Invalid enum'); return {value:s,numberFormat:'@'}; }
  return {value:String(value), numberFormat:'@'};
}
export function validateHeaders(headers) {
  if (!Array.isArray(headers) || headers.length < 3) throw new Error('Header row must be row 3');
  const normalized=headers.map(h=>String(h??'').trim().replace(/\s+/g,' ').toLowerCase());
  const seen=new Map(); normalized.forEach((h,i)=>{ if(!h) return; if(seen.has(h)) throw new Error(`Duplicate header: ${h}`); seen.set(h,i+1); });
  for (const c of ALLOWLIST) { const i=columnNumber(c)-1; const expected=EXPECTED_HEADERS[c]; if (!normalized[i]) throw new Error(`Missing header ${c}`); if (expected && normalized[i]!==expected.toLowerCase()) throw new Error(`Moved header ${c}`); }
  return {headers:normalized, fingerprint:schemaFingerprint(headers)};
}
export const normalizeCellValue = normalizeValue;
