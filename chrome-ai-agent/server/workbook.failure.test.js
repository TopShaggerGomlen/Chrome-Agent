import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recoverTransactions } from './workbooks/recovery.js';
import { syncCanonicalToDesktop } from './workbooks/sync.js';

test('malformed transaction journals are quarantined and recover scan is resumable', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'wb-failure-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const bad=path.join(dir,'bad.journal.json'); await writeFile(bad,'not-json'); const result=await recoverTransactions(dir); assert.equal(result[0].state,'quarantined');
  const canonical=path.join(dir,'book.xlsx'), desktop=path.join(dir,'Desktop.xlsx'); await writeFile(canonical,'canonical'); await writeFile(desktop,'different');
  const sync=await syncCanonicalToDesktop(canonical,desktop,{expectedExistingHash:'wrong'}); assert.equal(sync.state,'sync_pending'); assert.equal(await readFile(desktop,'utf8'),'different');
});

test('recovery scan quarantines invalid temporary artifacts without exposing paths', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'wb-quarantine-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const journal=path.join(dir,'tx.journal.json'); await writeFile(journal,JSON.stringify({phase:'writing',canonicalPath:path.join(dir,'missing.xlsx'),temp:path.join(dir,'missing.tmp'),transactionId:'tx'}));
  const [entry]=await recoverTransactions(dir); assert.equal(entry.state,'recovery_required'); assert.equal(entry.transactionId,'tx');
});
