import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { Archive } from '../src/archive/Archive.js';
import { createDicom, uid } from './fixtures/synthetic.js';

const stream = bytes => Readable.from([bytes]);
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'easi-store-removal-test-'));
  const archive = await Archive.open({ dataDir });
  t.after(async () => { await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { archive, dataDir };
}
async function add(archive, options = {}) {
  const bytes = createDicom(options), { instance } = await archive.ingest(stream(bytes));
  return { ...instance, path: archive.getInstance(instance.studyUid, instance.seriesUid, instance.sopUid).path, original: bytes };
}
function intent(archive, studyUid) {
  const records = archive.deletion.records(studyUid);
  return { version: 1, kind: 'study-deletion', id: randomUUID(), createdAt: new Date().toISOString(), ...archive.deletion.summary(studyUid, records), records };
}
async function saveIntent(dataDir, journal) {
  const path = join(dataDir, 'journal', `delete-${journal.id}.json`);
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  return path;
}
async function reopened(dataDir, callback) {
  const archive = await Archive.open({ dataDir });
  try { await callback(archive); } finally { await archive.close(); }
}

test('typed study removal reclaims only its originals and audits counts without patient details', async t => {
  const { archive, dataDir } = await fixture(t), studyUid = uid();
  const first = await add(archive, { studyUid }), second = await add(archive, { studyUid }), other = await add(archive);
  const preview = archive.previewStudyDeletion(studyUid);
  assert.deepEqual(preview, { studyUid, revision: preview.revision, seriesCount: 2, instanceCount: 2, bytes: first.bytes + second.bytes, reclaimableBytes: first.bytes + second.bytes });
  assert.match(preview.revision, /^[a-f0-9]{64}$/);
  for (const confirmation of [undefined, 'delete', 'DELETE ', true]) await assert.rejects(archive.deleteStudy(studyUid, { confirmation, revision: preview.revision }), { code: 'confirmation-required', statusCode: 400 });
  const result = await archive.deleteStudy(studyUid, { confirmation: 'DELETE', revision: preview.revision });
  assert.equal(result.deleted, true); assert.equal(result.reclamationPending, false);
  assert.equal(result.reclaimedBytes, preview.reclaimableBytes);
  assert.equal(archive.stats().studies, 1); assert.equal(archive.stats().instances, 1);
  for (const row of [first, second]) await assert.rejects(readFile(row.path), { code: 'ENOENT' });
  assert.deepEqual(await readFile(other.path), other.original);
  assert.deepEqual(await readdir(join(dataDir, 'journal')), []);
  assert.equal(archive.db.prepare('SELECT COUNT(*) AS count FROM study_deletions').get().count, 0);
  const audit = archive.activity().find(row => row.outcome === 'study-deleted');
  assert.equal(audit.source, 'management'); assert.equal(audit.instanceId, null); assert.equal(audit.bytes, preview.bytes);
  assert.deepEqual(JSON.parse(audit.details), { studyUid, seriesCount: 2, instanceCount: 2 });
  assert.ok(!JSON.stringify(audit).includes(first.patientName));
  assert.throws(() => archive.previewStudyDeletion(studyUid), { statusCode: 404 });
});

test('preview revisions reject changed studies while duplicate imports preserve the preview', async t => {
  const { archive } = await fixture(t), first = await add(archive);
  const initial = archive.previewStudyDeletion(first.studyUid);
  await archive.ingest(stream(first.original));
  assert.equal(archive.previewStudyDeletion(first.studyUid).revision, initial.revision);
  await add(archive, { studyUid: first.studyUid });
  await assert.rejects(archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: initial.revision }), { statusCode: 409, code: 'stale-preview' });
  assert.equal(archive.stats().instances, 2);
  await assert.rejects(archive.deleteStudy(first.studyUid, { confirmation: 'DELETE' }), { code: 'preview-required' });
  assert.throws(() => archive.previewStudyDeletion('../../outside'), { code: 'invalid-study' });
  assert.throws(() => archive.previewStudyDeletion(uid()), { statusCode: 404 });
});

test('active read leases are idempotent and block removal until readers finish', async t => {
  const { archive } = await fixture(t), first = await add(archive), preview = archive.previewStudyDeletion(first.studyUid);
  const release = archive.acquireReadLease(), releaseOther = archive.acquireReadLease();
  await assert.rejects(archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision }), { statusCode: 409, code: 'archive-read-active' });
  release(); release();
  assert.equal(archive.readLeases.size, 1);
  await assert.rejects(archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision }), { code: 'archive-read-active' });
  releaseOther();
  assert.equal((await archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision })).deleted, true);
});

test('pending source streams block deletion before their parsing or catalog commit', async t => {
  const { archive } = await fixture(t), first = await add(archive), preview = archive.previewStudyDeletion(first.studyUid);
  const bytes = createDicom({ studyUid: first.studyUid }), source = new PassThrough();
  const importing = archive.ingest(source); source.write(bytes.subarray(0, 160));
  await assert.rejects(archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision }), { statusCode: 409, code: 'archive-import-active' });
  source.end(bytes.subarray(160)); await importing;
  assert.equal(archive.stats().instances, 2);
});

test('a synchronous deletion reservation excludes new readers, imports, jobs and removals', async t => {
  const { archive } = await fixture(t), first = await add(archive), preview = archive.previewStudyDeletion(first.studyUid);
  const original = archive.deletion.verifyObject.bind(archive.deletion);
  let resume, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { resume = resolve; });
  let once = false;
  archive.deletion.verifyObject = async (...args) => { if (!once) { once = true; entered(); await blocked; } return original(...args); };
  const removing = archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision });
  await waiting;
  assert.throws(() => archive.acquireReadLease(), { code: 'archive-deletion-active' });
  assert.throws(() => archive.acquireImportReservation(), { code: 'archive-deletion-active' });
  assert.throws(() => archive.assertAvailableForMutation(), { code: 'archive-deletion-active' });
  await assert.rejects(archive.ingest(stream(createDicom())), { code: 'archive-deletion-active' });
  await assert.rejects(archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision }), { code: 'archive-deletion-active' });
  resume(); await removing;
  assert.equal(archive.readLeases.size, 0);
});

test('queued, running and canceling target transfers block removal; unrelated and finished transfers do not', async t => {
  const { archive } = await fixture(t), first = await add(archive), preview = archive.previewStudyDeletion(first.studyUid);
  archive.db.exec('CREATE TABLE transfer_jobs (selection TEXT,state TEXT)');
  const insert = archive.db.prepare('INSERT INTO transfer_jobs VALUES (?,?)');
  for (const state of ['queued', 'running', 'canceling']) {
    insert.run(JSON.stringify({ studyUid: first.studyUid, seriesUid: first.seriesUid }), state);
    await assert.rejects(archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision }), { code: 'study-transfer-active' });
    archive.db.exec('DELETE FROM transfer_jobs');
  }
  insert.run(JSON.stringify({ studyUid: uid() }), 'running');
  insert.run(JSON.stringify({ studyUid: first.studyUid }), 'completed');
  assert.equal((await archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision })).deleted, true);
});

test('the commit transaction rechecks transfers and rolls back a late conflict', async t => {
  const { archive, dataDir } = await fixture(t), first = await add(archive), preview = archive.previewStudyDeletion(first.studyUid);
  archive.db.exec('CREATE TABLE transfer_jobs (selection TEXT,state TEXT)');
  const verify = archive.deletion.verifyObject.bind(archive.deletion);
  archive.deletion.verifyObject = async (...args) => { await verify(...args); archive.db.prepare('INSERT INTO transfer_jobs VALUES (?,?)').run(JSON.stringify({ studyUid: first.studyUid }), 'queued'); };
  await assert.rejects(archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision }), { code: 'study-transfer-active' });
  assert.equal(archive.stats().instances, 1); assert.deepEqual(await readFile(first.path), first.original);
  assert.deepEqual(await readdir(join(dataDir, 'journal')), []);
  assert.equal(archive.recoveryRequired, undefined);
});

test('shared blob references are retained even when the selected catalog rows are removed', async t => {
  const { archive } = await fixture(t), first = await add(archive), other = await add(archive);
  // Defensive corruption/shared-reference fixture: admission normally prevents
  // distinct DICOM identities from having identical original bytes.
  const key = archive.db.prepare('SELECT objectKey FROM instances WHERE sopUid=?').get(first.sopUid).objectKey;
  archive.db.prepare('UPDATE instances SET objectKey=?,sha256=?,bytes=? WHERE sopUid=?').run(key, first.sha256, first.bytes, other.sopUid);
  const preview = archive.previewStudyDeletion(first.studyUid);
  assert.equal(preview.reclaimableBytes, 0);
  const result = await archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision });
  assert.equal(result.reclaimedBytes, 0);
  assert.deepEqual(await readFile(first.path), first.original); assert.equal(archive.stats().instances, 1);
});

test('integrity mismatch aborts before catalog deletion and leaves all original paths untouched', async t => {
  const { archive, dataDir } = await fixture(t), first = await add(archive), other = await add(archive), preview = archive.previewStudyDeletion(first.studyUid);
  const corrupt = Buffer.from(first.original); corrupt[corrupt.length - 1] ^= 1; await writeFile(first.path, corrupt);
  await assert.rejects(archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision }), { statusCode: 503, code: 'integrity-error' });
  assert.equal(archive.stats().instances, 2); assert.deepEqual(await readFile(first.path), corrupt); assert.deepEqual(await readFile(other.path), other.original);
  assert.deepEqual(await readdir(join(dataDir, 'journal')), []);
});

test('canceling before the commit leaves the catalog and originals intact', async t => {
  const { archive, dataDir } = await fixture(t), first = await add(archive), preview = archive.previewStudyDeletion(first.studyUid), controller = new AbortController();
  const verify = archive.deletion.verifyObject.bind(archive.deletion);
  archive.deletion.verifyObject = async (...args) => { await verify(...args); controller.abort(); };
  await assert.rejects(archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(archive.stats().instances, 1); assert.deepEqual(await readFile(first.path), first.original); assert.deepEqual(await readdir(join(dataDir, 'journal')), []);
});

test('uncommitted durable deletion intent recovers by preserving the entire study', async t => {
  const { archive, dataDir } = await fixture(t), first = await add(archive), journal = intent(archive, first.studyUid);
  await saveIntent(dataDir, journal); await archive.close();
  await reopened(dataDir, async recovered => {
    assert.equal(recovered.stats().instances, 1); assert.deepEqual(await readFile(first.path), first.original);
    assert.deepEqual(await readdir(join(dataDir, 'journal')), []);
  });
});

test('committed deletion with interrupted reclamation returns pending and completes safely on restart', async t => {
  const { archive, dataDir } = await fixture(t), studyUid = uid(), first = await add(archive, { studyUid }), second = await add(archive, { studyUid }), other = await add(archive);
  const preview = archive.previewStudyDeletion(studyUid), reclaim = archive.deletion.reclaim.bind(archive.deletion);
  archive.deletion.reclaim = async journal => { await rm(first.path); throw new Error('simulated interrupted reclamation'); };
  const result = await archive.deleteStudy(studyUid, { confirmation: 'DELETE', revision: preview.revision });
  assert.equal(result.deleted, true); assert.equal(result.reclamationPending, true); assert.equal(result.reclaimedBytes, 0);
  assert.equal(archive.stats().instances, 1); assert.equal(archive.recoveryRequired, true);
  assert.throws(() => archive.acquireReadLease(), { code: 'recovery-required' });
  await assert.rejects(archive.ingest(stream(createDicom())), { code: 'recovery-required' });
  assert.throws(() => archive.previewStudyDeletion(other.studyUid), { code: 'recovery-required' });
  assert.equal((await readdir(join(dataDir, 'journal'))).length, 1);
  archive.deletion.reclaim = reclaim; await archive.close();
  await reopened(dataDir, async recovered => {
    assert.equal(recovered.stats().instances, 1); assert.equal(recovered.getInstance(studyUid, second.seriesUid, second.sopUid), null);
    for (const row of [first, second]) await assert.rejects(readFile(row.path), { code: 'ENOENT' });
    assert.deepEqual(await readFile(other.path), other.original); assert.deepEqual(await readdir(join(dataDir, 'journal')), []);
    assert.equal(recovered.db.prepare('SELECT COUNT(*) AS count FROM study_deletions').get().count, 0);
  });
});

test('a committed marker survives an intent-only file and prevents resurrecting deleted rows', async t => {
  const { archive, dataDir } = await fixture(t), first = await add(archive), journal = intent(archive, first.studyUid);
  await saveIntent(dataDir, journal); archive.deletion.commit(journal); await archive.close();
  await reopened(dataDir, async recovered => {
    assert.equal(recovered.stats().instances, 0); await assert.rejects(readFile(first.path), { code: 'ENOENT' });
  });
});

test('startup refuses ambiguous overlapping ingest journals instead of resurrecting a removed study', async t => {
  const { archive, dataDir } = await fixture(t), first = await add(archive), journal = intent(archive, first.studyUid);
  const record = archive.db.prepare('SELECT * FROM instances WHERE sopUid=?').get(first.sopUid);
  await saveIntent(dataDir, journal); archive.deletion.commit(journal);
  await writeFile(join(dataDir, 'journal', `${randomUUID()}.json`), JSON.stringify({ version: 1, record, spoolName: `${randomUUID()}.partial` }));
  await archive.close();
  await assert.rejects(Archive.open({ dataDir }), /conflicts with an ingest journal/);
  assert.deepEqual(await readFile(first.path), first.original);
  const db = new DatabaseSync(join(dataDir, 'catalog.sqlite')); try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM instances').get().count, 0); } finally { db.close(); }
});

test('startup refuses corrupted reclaim bytes while preserving the durable deletion journal', async t => {
  const { archive, dataDir } = await fixture(t), first = await add(archive), journal = intent(archive, first.studyUid);
  await saveIntent(dataDir, journal); archive.deletion.commit(journal);
  const corrupt = Buffer.from(first.original); corrupt[corrupt.length - 1] ^= 1; await writeFile(first.path, corrupt);
  await archive.close(); await assert.rejects(Archive.open({ dataDir }), { code: 'integrity-error' });
  assert.deepEqual(await readFile(first.path), corrupt); assert.equal((await readdir(join(dataDir, 'journal'))).length, 1);
});

test('deletion journals reject path traversal without touching external files', async t => {
  const { archive, dataDir } = await fixture(t), first = await add(archive), journal = intent(archive, first.studyUid), outside = join(dataDir, 'outside-original');
  await writeFile(outside, first.original);
  journal.records[0].objectKey = '../../outside-original';
  journal.revision = createHash('sha256').update(JSON.stringify(journal.records)).digest('hex');
  await saveIntent(dataDir, journal); await archive.close();
  await assert.rejects(Archive.open({ dataDir }), /removal journal is invalid/);
  assert.deepEqual(await readFile(outside), first.original);
});

test('study removal refuses a symlink original without touching its external target', async t => {
  const { archive, dataDir } = await fixture(t), first = await add(archive), outside = join(dataDir, 'outside-original');
  await writeFile(outside, first.original); await rm(first.path);
  try { await symlink(outside, first.path); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('This Windows account cannot create symbolic links.'); return; } throw error; }
  const preview = archive.previewStudyDeletion(first.studyUid);
  await assert.rejects(archive.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: preview.revision }), { code: 'integrity-error' });
  assert.equal(archive.stats().instances, 1); assert.deepEqual(await readFile(outside), first.original);
});

test('older schema-one archives migrate without changing indexed originals or activity history', async t => {
  const { archive, dataDir } = await fixture(t), first = await add(archive); await archive.close();
  const db = new DatabaseSync(join(dataDir, 'catalog.sqlite'));
  db.exec('DROP TABLE study_deletions; ALTER TABLE activity DROP COLUMN details; PRAGMA user_version=1'); db.close();
  await reopened(dataDir, async recovered => {
    assert.equal(recovered.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(recovered.stats().instances, 1); assert.equal(recovered.activity()[0].outcome, 'stored');
    assert.deepEqual(await readFile(first.path), first.original);
    assert.equal((await recovered.deleteStudy(first.studyUid, { confirmation: 'DELETE', revision: recovered.previewStudyDeletion(first.studyUid).revision })).deleted, true);
  });
});

test('bounded original snapshots avoid patient metadata and shutdown waits for an active read lease', async t => {
  const { archive } = await fixture(t), studyUid = uid(), first = await add(archive, { studyUid }); await add(archive, { studyUid });
  assert.throws(() => archive.snapshotStudyOriginals(studyUid, { maxInstances: 1 }), { statusCode: 413 });
  const rows = archive.snapshotStudyOriginals(studyUid);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.sha256 && row.bytes && row.sopClassUid && row.path && !('patientName' in row) && !('metadata' in row)));
  assert.throws(() => archive.snapshotStudyOriginals(uid()), { statusCode: 404 });
  assert.deepEqual(await readFile(rows.find(row => row.sopUid === first.sopUid).path), first.original);
  const release = archive.acquireReadLease(); let closed = false;
  const closing = archive.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  assert.throws(() => archive.acquireReadLease(), { code: 'closing' }); release(); await closing; assert.equal(closed, true);
});
