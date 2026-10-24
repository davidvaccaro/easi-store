import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execute } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Archive } from '../src/archive/Archive.js';
import { Auth } from '../src/http/Auth.js';
import { createDicom, uid } from './fixtures/synthetic.js';
const execFile = promisify(execute);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('offline backup and restore verify original hashes, account data, and reject active or corrupt sources', async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'easi-store-backup-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const dataDir = path.join(dir, 'source'), backup = path.join(dir, 'backup'), restored = path.join(dir, 'restored');
    let archive = await Archive.open({ dataDir });
    const studyUid = uid(), seriesUid = uid(), sopUid = uid(), original = createDicom({ studyUid, seriesUid, sopUid });
    await archive.ingest(Readable.from([original]));
    const auth = await new Auth(dataDir).open(); await auth.setup({ username: 'synthetic', password: 'synthetic-test-password' }, '127.0.0.1');
    await assert.rejects(execFile(process.execPath, [cli, 'backup', '--data-dir', dataDir, '--output', backup]), /owns this archive/);
    await archive.close();
    await execFile(process.execPath, [cli, 'backup', '--data-dir', dataDir, '--output', backup]);
    await execFile(process.execPath, [cli, 'restore', '--input', backup, '--data-dir', restored]);
    archive = await Archive.open({ dataDir: restored });
    try { assert.equal(archive.stats().instances, 1); assert.deepEqual(await readFile(archive.getInstance(studyUid, seriesUid, sopUid).path), original); }
    finally { await archive.close(); }
    const restoredAuth = await new Auth(restored).open(); assert.ok(await restoredAuth.login({ username: 'synthetic', password: 'synthetic-test-password' }, '127.0.0.1'));
    const manifest = JSON.parse(await readFile(path.join(backup, 'backup-manifest.json'), 'utf8'));
    const object = manifest.files.find(file => file.path.startsWith('objects/')); assert.ok(object);
    await writeFile(path.join(backup, object.path), Buffer.from('Corrupted synthetic backup'));
    await assert.rejects(execFile(process.execPath, [cli, 'restore', '--input', backup, '--data-dir', path.join(dir, 'corrupt-restored')]), /integrity verification failed/);
});
