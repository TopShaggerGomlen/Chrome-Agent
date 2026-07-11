import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {SHEET_NAME,ALLOWLIST,normalizeValue,hashRow,validateHeaders,HEADER_ROW} from './contract.js';

function idx(col){let n=0;for(const c of col)n=n*26+c.charCodeAt(0)-64;return n;}
export class ExcelJSAdapter {
  constructor(filePath){this.filePath=path.resolve(filePath);}
  async load(){ const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile(this.filePath); const ws=wb.getWorksheet(SHEET_NAME); if(!ws) throw new Error('Worksheet Data Collection not found'); if(ws.state!=='visible'||ws.protection?.sheet) throw new Error('Target worksheet unavailable'); const headers=[]; for(let i=1;i<=ws.columnCount;i++) headers.push(ws.getCell(HEADER_ROW,i).value); validateHeaders(headers); return {wb,ws}; }
  async readRow(row){ const {ws}=await this.load(); const values={}; for(const c of ALLOWLIST) values[c]=ws.getCell(row,idx(c)).value; return values; }
  async stageWrite({row,record,approvedColumns=ALLOWLIST,expectedRowHash}) {
    const unknown=approvedColumns.filter(c=>!ALLOWLIST.includes(c)); if(unknown.length) throw new Error('Unapproved column');
    const {wb,ws}=await this.load(); const before=[]; for(let i=1;i<=ws.columnCount;i++) before.push(ws.getCell(row,i).value);
    if(expectedRowHash && hashRow(before)!==expectedRowHash) throw new Error('Row conflict');
    const diff=[];
    for(const c of approvedColumns){ if(!(c in record)) continue; const cell=ws.getCell(row,idx(c)); const old=cell.value; const n=normalizeValue(c,record[c]); if(n.unresolved){cell.value=null;} else {cell.value=n.value; if(n.numberFormat) cell.numFmt=n.numberFormat;} diff.push({column:c,row,before:old,after:cell.value,formatChanged:Boolean(n.numberFormat)}); }
    return {workbook:wb,worksheet:ws,diff,beforeSnapshot:snapshotWorkbook(wb)};
  }
  async writeRow(args){ const staged=await this.stageWrite(args); const temp=`${this.filePath}.${Date.now()}.tmp`; await staged.workbook.xlsx.writeFile(temp); const verify=new ExcelJS.Workbook(); await verify.xlsx.readFile(temp); const ws=verify.getWorksheet(SHEET_NAME); for(const d of staged.diff){ const cell=ws.getCell(d.row,idx(d.column)); const got=cell.value; const same=got instanceof Date&&d.after instanceof Date ? got.getTime()===d.after.getTime() : String(got)===String(d.after); if(!same || (d.formatChanged && !['d/m/yyyy','@'].includes(cell.numFmt))) { await fs.rm(temp,{force:true}); throw new Error('Verification failed'); } } const after=snapshotWorkbook(verify); for(const [name,snap] of Object.entries(staged.beforeSnapshot.sheets)){ if(name!==SHEET_NAME && JSON.stringify(snap)!==JSON.stringify(after.sheets[name])) { await fs.rm(temp,{force:true}); throw new Error('Non-target sheet changed'); } } await fs.rename(temp,this.filePath); return {diff:staged.diff}; }
}
function snapshotWorkbook(wb){ const sheets={}; for(const ws of wb.worksheets){ const cells=[]; for(let r=1;r<=ws.rowCount;r++) for(let c=1;c<=ws.columnCount;c++){ const x=ws.getCell(r,c); if(x.value!==null||x.styleId||x.numFmt) cells.push([r,c,x.value,x.numFmt,x.styleId]); } sheets[ws.name]={state:ws.state,cells}; } return {sheets}; }
export async function writeApprovedRow(filePath,args){ return new ExcelJSAdapter(filePath).writeRow(args); }
