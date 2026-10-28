import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile as execute } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Archive } from '../src/archive/Archive.js';
import { createDicom } from './fixtures/synthetic.js';
const execFile = promisify(execute), cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('offline verification writes a private report, detects corruption and distinguishes inventory from hashing', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'easi-store-verify-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'archive'), archive = await Archive.open({ dataDir });
    const original = createDicom(), stored = await archive.ingest([original]);
    const row = archive.getInstance(stored.instance.studyUid, stored.instance.seriesUid, stored.instance.sopUid); await archive.close();
    const reportPath = path.join(root, 'report.json');
    const first = await execFile(process.execPath, [cli, 'verify', '--data-dir', dataDir, '--output', reportPath]);
    assert.equal(JSON.parse(first.stdout).status, 'completed'); assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).progress.indexed, 1);
    const changed = Buffer.from(original); changed[changed.length - 1] ^= 1; await writeFile(row.path, changed);
    const inventory = await execFile(process.execPath, [cli, 'verify', '--data-dir', dataDir, '--inventory-only']);
    assert.equal(JSON.parse(inventory.stdout).verifyHashes, false);
    await assert.rejects(execFile(process.execPath, [cli, 'verify', '--data-dir', dataDir]), error => {
        assert.equal(error.code, 1); const report = JSON.parse(error.stdout); assert.equal(report.status, 'completed'); assert.equal(report.counts.corrupt, 1); return true;
    });
    assert.deepEqual(await readFile(row.path), changed, 'Verification never repairs original bytes.');
    await assert.rejects(execFile(process.execPath, [cli, 'verify', '--data-dir', dataDir, '--output', reportPath]), /EEXIST/);
});

test('offline verification refuses absent archives and reports inside archive storage', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'easi-store-verify-input-')); t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(execFile(process.execPath, [cli, 'verify', '--data-dir', path.join(root, 'missing')]), /existing archive/);
    const dataDir = path.join(root, 'archive'), archive = await Archive.open({ dataDir }); await archive.close();
    await assert.rejects(execFile(process.execPath, [cli, 'verify', '--data-dir', dataDir, '--output', path.join(dataDir, 'report.json')]), /outside the archive/);
});
