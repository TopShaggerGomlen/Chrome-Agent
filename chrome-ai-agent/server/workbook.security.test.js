import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { canonicalizeWorkbookPath } from './workbooks/path-policy.js';
import { normalizeValue } from './workbooks/contract.js';
import { validateRow } from './schemas/workbook.js';

test('workbook paths reject traversal, UNC, aliases and non-xlsx input', async () => {
  await assert.rejects(() => canonicalizeWorkbookPath('../secret.xlsx'), e => e.code === 'PATH_NOT_ALLOWED');
  await assert.rejects(() => canonicalizeWorkbookPath('\\\\server\\share\\book.xlsx'), e => e.code === 'PATH_UNSUPPORTED');
  await assert.rejects(() => canonicalizeWorkbookPath('https://example.test/book.xlsx'), e => e.code === 'PATH_UNSUPPORTED');
  await assert.rejects(() => canonicalizeWorkbookPath(path.join(process.cwd(), 'book.xls')), e => e.code === 'UNSUPPORTED_FORMAT');
});

test('contract rejects formula injection and unapproved columns while preserving numeric zero', () => {
  assert.throws(() => normalizeValue('AC', '=HYPERLINK("x")'));
  assert.throws(() => normalizeValue('A', 'x'));
  assert.deepEqual(normalizeValue('CE', 0).value, 0);
  assert.throws(() => validateRow({ workbookId:'w', runId:'r', patientNumber:1, record:{ A:{ status:'found', value:'x' } } }), /column|Invalid/i);
});
