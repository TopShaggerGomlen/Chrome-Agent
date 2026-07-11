import test from 'node:test'; import assert from 'node:assert/strict';
import {ALLOWLIST,COLUMN_POLICY,normalizeValue,hashIdentity,schemaFingerprint} from './contract.js';
test('contract defines all 36 columns and policies',()=>{assert.equal(ALLOWLIST.length,36); for(const c of ALLOWLIST) assert.ok(COLUMN_POLICY[c]); assert.equal(new Set(ALLOWLIST).size,36);});
test('normalization preserves zero, ranges, dates and N/A',()=>{assert.equal(normalizeValue('CE',0).value,0); assert.equal(normalizeValue('AC','0-2').value,'0-2'); assert.equal(normalizeValue('AC','0-2').numberFormat,'@'); assert.equal(normalizeValue('T','31/12/2025').value.getDate(),31); assert.equal(normalizeValue('S','N/A').value,'N/A');});
test('rejects invalid dates and formula injection',()=>{assert.throws(()=>normalizeValue('T','31/02/2025')); assert.throws(()=>normalizeValue('CO','=CMD()'));});
test('identity and schema hashes deterministic',()=>{assert.equal(hashIdentity('1','2025-01-01').mrnHash.length,64); assert.equal(schemaFingerprint(['A','B']),schemaFingerprint(['A','B']));});
