import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Archive } from '../src/archive/Archive.js';
import { createDicom, uid } from './fixtures/synthetic.js';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp('/private/tmp/easi-store-archive-test-');
  const archive = await Archive.open({ dataDir, ...options });
  t.after(async () => { await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { archive, dataDir };
}
const stream = bytes => Readable.from([bytes]);

test('disk-backed ingestion preserves original bytes and indexes without pixel retention', async t => {
  const { archive } = await fixture(t);
  const bytes = createDicom({ patientName: 'Synthetic^Müller', rows: 64, columns: 96, frames: 3 });
  const result = await archive.ingest(stream(bytes));
  assert.equal(result.status, 'stored');
  assert.equal(result.instance.patientName, 'Synthetic^Müller');
  assert.equal(result.instance.rows, 64);
  assert.equal(result.instance.columns, 96);
  assert.equal(result.instance.frames, 3);
  assert.equal(result.instance.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(!result.instance.metadata['7FE00010']);
  assert.ok(!('path' in result.instance));
  const stored = archive.getInstance(result.instance.studyUid, result.instance.seriesUid, result.instance.sopUid);
  assert.deepEqual(await readFile(stored.path), bytes);
  assert.deepEqual(archive.stats(), { patients: 1, studies: 1, series: 1, instances: 1, bytes: bytes.length });
  assert.equal(archive.activity()[0].outcome, 'stored');
});

test('concurrent identical imports store once and duplicate safely', async t => {
  const { archive, dataDir } = await fixture(t);
  const bytes = createDicom();
  const results = await Promise.all(Array.from({ length: 4 }, () => archive.ingest(stream(bytes))));
  assert.equal(results.filter(item => item.status === 'stored').length, 1);
  assert.equal(results.filter(item => item.status === 'duplicate').length, 3);
  assert.equal(archive.stats().instances, 1);
  assert.deepEqual(await readdir(join(dataDir, 'spool')), []);
  assert.deepEqual(await readdir(join(dataDir, 'journal')), []);
});

test('same SOP UID with different bytes conflicts without replacing its original', async t => {
  const { archive } = await fixture(t);
  const identity = { sopUid: uid(), studyUid: uid(), seriesUid: uid() };
  const original = createDicom(identity);
  await archive.ingest(stream(original));
  await assert.rejects(archive.ingest(stream(createDicom({ ...identity, patientName: 'Other^Synthetic' }))), { statusCode: 409, code: 'uid-conflict' });
  const stored = archive.getInstance(identity.studyUid, identity.seriesUid, identity.sopUid);
  assert.deepEqual(await readFile(stored.path), original);
});

test('invalid, truncated, oversized, and expected-UID mismatches never enter catalog', async t => {
  const { archive, dataDir } = await fixture(t, { maxInstanceBytes: 50000 });
  const bytes = createDicom();
  await assert.rejects(archive.ingest(stream(Buffer.alloc(200))), { statusCode: 400 });
  await assert.rejects(archive.ingest(stream(bytes.subarray(0, bytes.length - 7))), { statusCode: 400 });
  await assert.rejects(archive.ingest(stream(createDicom({ frames: 3 }))), { statusCode: 413 });
  await assert.rejects(archive.ingest(stream(bytes), { expectedStudyUid: uid() }), { statusCode: 409 });
  await assert.rejects(archive.ingest(stream(bytes), { expectedSopUid: uid() }), { statusCode: 409 });
  await assert.rejects(archive.ingest(stream(bytes), { expectedSopClassUid: uid() }), { statusCode: 409 });
  assert.equal(archive.stats().instances, 0);
  assert.deepEqual(await readdir(join(dataDir, 'spool')), []);
});

test('study/series hierarchy conflicts are rejected', async t => {
  const { archive } = await fixture(t);
  const studyUid = uid(), seriesUid = uid();
  await archive.ingest(stream(createDicom({ studyUid, seriesUid })));
  await assert.rejects(archive.ingest(stream(createDicom({ studyUid: uid(), seriesUid }))), { code: 'hierarchy-conflict' });
  await assert.rejects(archive.ingest(stream(createDicom({ studyUid, patientId: 'DIFFERENT' }))), { code: 'patient-conflict' });
});

test('patient identity uses issuer or source namespace, never names alone', async t => {
  const { archive } = await fixture(t);
  await archive.ingest(stream(createDicom({ issuer: '', patientId: '42' })), { source: 'hospital-a' });
  await archive.ingest(stream(createDicom({ issuer: '', patientId: '42' })), { source: 'hospital-b' });
  await archive.ingest(stream(createDicom({ issuer: 'GLOBAL', patientId: '42' })), { source: 'hospital-a' });
  await archive.ingest(stream(createDicom({ issuer: 'GLOBAL', patientId: '42' })), { source: 'hospital-b' });
  assert.equal(archive.stats().patients, 3);
});

test('queries search literals safely and paginate while grouping stable studies/series', async t => {
  const { archive } = await fixture(t);
  const studyUid = uid(), seriesUid = uid();
  await archive.ingest(stream(createDicom({ studyUid, seriesUid, patientName: 'Percent%_Patient', instanceNumber: 2 })));
  await archive.ingest(stream(createDicom({ studyUid, seriesUid, patientName: 'Percent%_Patient', instanceNumber: 1 })));
  await archive.ingest(stream(createDicom({ patientName: 'Other^Synthetic' })));
  assert.equal(archive.listStudies({ search: '%_' }).total, 1);
  assert.equal(archive.listStudies({ limit: 1, offset: 1 }).items.length, 1);
  assert.equal(archive.listSeries(studyUid)[0].instanceCount, 2);
  assert.equal(archive.listInstances(studyUid, seriesUid)[0].instanceNumber, '1');
});

test('archive prevents two owners and survives ordinary restart', async t => {
  const { archive, dataDir } = await fixture(t);
  await archive.ingest(stream(createDicom()));
  await assert.rejects(Archive.open({ dataDir }), { code: 'archive-locked' });
  await archive.close();
  const reopened = await Archive.open({ dataDir });
  try { assert.equal(reopened.stats().instances, 1); } finally { await reopened.close(); }
});

test('durable recovery journal repairs a crash window between object rename and SQL commit', async t => {
  const { archive, dataDir } = await fixture(t);
  const bytes = createDicom();
  archive.commitRecord = () => { throw new Error('simulated SQL interruption'); };
  await assert.rejects(archive.ingest(stream(bytes)), /simulated SQL interruption/);
  assert.equal(archive.stats().instances, 0);
  assert.equal((await readdir(join(dataDir, 'journal'))).length, 1);
  await archive.close();
  const recovered = await Archive.open({ dataDir });
  try {
    assert.equal(recovered.stats().instances, 1);
    assert.equal(recovered.activity()[0].outcome, 'recovered');
    const row = recovered.queryRecords()[0];
    assert.deepEqual(await readFile(recovered.getInstance(row.studyUid, row.seriesUid, row.sopUid).path), bytes);
    assert.deepEqual(await readdir(join(dataDir, 'journal')), []);
  } finally { await recovered.close(); }
});

test('recovery refuses corrupted stored bytes instead of reporting a healthy archive', async t => {
  const { archive, dataDir } = await fixture(t);
  archive.commitRecord = () => { throw new Error('simulated SQL interruption'); };
  await assert.rejects(archive.ingest(stream(createDicom())));
  const name = (await readdir(join(dataDir, 'journal')))[0];
  const { record } = JSON.parse(await readFile(join(dataDir, 'journal', name), 'utf8'));
  await writeFile(join(dataDir, 'objects', record.objectKey), 'corrupt');
  await archive.close();
  await assert.rejects(Archive.open({ dataDir }), /integrity hash/);
});

test('dead process locks recover while unsupported future schemas remain unchanged', async t => {
  const { archive, dataDir } = await fixture(t);
  await archive.close();
  await mkdir(join(dataDir, '.archive-lock'));
  await writeFile(join(dataDir, '.archive-lock', 'owner.json'), JSON.stringify({ pid: 2147483647, hostname: hostname(), token: 'abandoned-test-lock' }));
  const reopened = await Archive.open({ dataDir });
  await reopened.close();
  const db = new DatabaseSync(join(dataDir, 'catalog.sqlite'));
  db.exec('PRAGMA user_version=99'); db.close();
  await assert.rejects(Archive.open({ dataDir }), /newer EASI Store version/);
  const untouched = new DatabaseSync(join(dataDir, 'catalog.sqlite'));
  assert.equal(untouched.prepare('PRAGMA user_version').get().user_version, 99);
  untouched.close();
});
