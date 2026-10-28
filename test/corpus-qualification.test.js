import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { qualifyCorpus } from '../scripts/qualify-corpus.mjs';
import { createDicom } from './fixtures/synthetic.js';

test('local corpus qualification distinguishes duplicates, conflicts and non-Part10 files while verifying retained originals', { timeout: 20000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'easi-store-corpus-test-')); t.after(() => rm(root, { recursive: true, force: true }));
    const input = path.join(root, 'input'), output = path.join(root, 'private-report'); await mkdir(input);
    const original = createDicom(), hash = createHash('sha256').update(original).digest('hex');
    await writeFile(path.join(input, '1-original'), original); await writeFile(path.join(input, '2-duplicate.dcm'), original);
    const conflict = Buffer.from(original); conflict[conflict.length - 1] ^= 1; await writeFile(path.join(input, '3-conflict.dcm'), conflict);
    await writeFile(path.join(input, 'readme.txt'), 'Independent generated non-imaging file');
    const report = await qualifyCorpus({ inputs: [input], output });
    assert.equal(report.completed, true); assert.equal(report.passedIntegrity, true);
    assert.deepEqual(report.outcomes, { stored: 1, duplicate: 1, conflict: 1, 'not-part10': 1 });
    assert.equal(report.archive.instances, 1); assert.equal(report.integrityAudit.status, 'completed');
    assert.equal(createHash('sha256').update(await readFile(path.join(input, '1-original'))).digest('hex'), hash);
    const details = (await readFile(path.join(output, 'instances.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(details[0].verifiedSha256, hash); assert.ok(!JSON.stringify(report).includes(input));
    await assert.rejects(access(path.join(output, 'archive')), { code: 'ENOENT' });
    await assert.rejects(qualifyCorpus({ inputs: [input], output }), { code: 'EEXIST' });
});
