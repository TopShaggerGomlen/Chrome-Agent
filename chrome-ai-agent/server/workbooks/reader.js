import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import {SHEET_NAME,HEADER_ROW,DATA_START_ROW,ALLOWLIST,schemaFingerprint,hashIdentity,hashRow,validateHeaders} from './contract.js';

const sha256 = async p => { const b=await fs.readFile(p); return crypto.createHash('sha256').update(b).digest('hex'); };
function cellText(c){ if(c?.value instanceof Date) return c.value.toISOString().slice(0,10); if(c?.value && typeof c.value==='object' && 'result' in c.value) return cellText({value:c.value.result}); return c?.value ?? ''; }
export class WorkbookReader {
  constructor(filePath, options={}) { this.filePath=path.resolve(filePath); this.version=options.version||'1'; this.workbook=null; this.fileHash=null; }
  async open() {
    if(path.extname(this.filePath).toLowerCase()!=='.xlsx') throw new Error('Unsupported workbook format');
    const stat=await fs.stat(this.filePath); if(!stat.isFile()) throw new Error('Workbook not found');
    if (stat.size > 50 * 1024 * 1024) throw new Error('Workbook exceeds size limit');
    const raw=await fs.readFile(this.filePath); if(raw.length<4 || raw.readUInt32LE(0)!==0x04034b50) throw new Error('Malformed workbook ZIP');
    const text=raw.toString('latin1'); if (/externalLinks?[\\/]|externalReferences/i.test(text)) throw new Error('External links are not supported');
    this.workbook=new ExcelJS.Workbook(); try { await this.workbook.xlsx.readFile(this.filePath); } catch(e){ throw new Error(`Invalid workbook: ${e.message}`); }
    const ws=this.workbook.getWorksheet(SHEET_NAME); if(!ws) throw new Error('Worksheet Data Collection not found');
    if(ws.state!=='visible') throw new Error('Target worksheet hidden'); if(ws.protection?.sheet) throw new Error('Protected worksheet');
    const headers=[]; for(let i=1;i<=ws.columnCount;i++) headers.push(cellText(ws.getCell(HEADER_ROW,i)));
    validateHeaders(headers); this.headers=headers; this.schemaFingerprint=schemaFingerprint(headers,this.version); this.fileHash=await sha256(this.filePath); this.sheet=ws;
    this.identityColumns={mrn:this.findHeader(/mrn|medical record/i), surgeryDate:this.findHeader(/surgery.*date|date.*surgery/i)};
    if(!this.identityColumns.mrn||!this.identityColumns.surgeryDate) throw new Error('Identity columns missing');
    return this.metadata();
  }
  findHeader(re){ const i=this.headers.findIndex(h=>re.test(String(h))); return i<0?null:i+1; }
  metadata(){ return {workbookId:this.fileHash?.slice(0,16),fileHash:this.fileHash,schemaFingerprint:this.schemaFingerprint,sheet:SHEET_NAME,rowStart:DATA_START_ROW}; }
  rowNumber(patientNumber){ if(!Number.isInteger(patientNumber)||patientNumber<1) throw new Error('Invalid patient number'); return patientNumber+3; }
  identity(patientNumber){ const r=this.rowNumber(patientNumber); const mrn=cellText(this.sheet.getCell(r,this.identityColumns.mrn)); const surgeryDate=cellText(this.sheet.getCell(r,this.identityColumns.surgeryDate)); return {row:r,mrn,surgeryDate,...hashIdentity(mrn,surgeryDate),rowHash:hashRow(this.rowValues(r))}; }
  rowValues(r){ const a=[]; for(let i=1;i<=this.sheet.columnCount;i++) a.push(this.sheet.getCell(r,i).value); return a; }
  patientRow(patientNumber){ const id=this.identity(patientNumber); const values={}; for(const c of ALLOWLIST) values[c]=this.sheet.getCell(id.row, this.columnIndex(c)).value; return {...id,values,completion:this.completion(patientNumber),partial:this.partial(patientNumber)}; }
  columnIndex(c){ let n=0; for(const x of c)n=n*26+x.charCodeAt(0)-64; return n; }
  patients(){ const out=[]; const seen=new Set(); let gap=false; for(let r=DATA_START_ROW,n=1;r<=this.sheet.rowCount;r++,n++){ const id=this.identity(n); if(!id.mrn&&!id.surgeryDate){ if(out.length) gap=true; continue; } if(gap) throw new Error('Blank row gap'); if(!id.mrn||!id.surgeryDate) throw new Error('Incomplete identity'); const key=`${id.mrnHash}:${id.surgeryDateHash}`; if(seen.has(key)) throw new Error('Duplicate identity'); seen.add(key); out.push({patientNumber:n,...id,completion:this.completion(n)}); } return out; }
  completion(n){ const id=this.identity(n); const vals=ALLOWLIST.map(c=>this.sheet.getCell(id.row,this.columnIndex(c)).value); return vals.some(v=>v!==null&&v!=='')?'partial':'empty'; }
  partial(n){ return this.completion(n)==='partial'; }
  externalChange(){ return sha256(this.filePath).then(h=>({changed:h!==this.fileHash,fileHash:h})); }
  compareCheckpoint(expected,n){ const id=this.identity(n); return id.row===expected.row&&id.mrnHash===expected.mrnHash&&id.surgeryDateHash===expected.surgeryDateHash&&id.rowHash===expected.rowHash; }
  resume(n){ return this.patientRow(n); }
}
export async function openWorkbook(filePath, options){ const r=new WorkbookReader(filePath,options); await r.open(); return r; }
