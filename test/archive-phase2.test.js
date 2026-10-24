import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { Archive } from '../src/archive/Archive.js';
import { createDicom, uid } from './fixtures/synthetic.js';

test('remote retrieval validates study, series and instance identities before durable catalog admission', async t => {
  const dataDir = await mkdtemp('/private/tmp/easi-scope-identity-'), archive = await Archive.open({ dataDir });
  t.after(async () => { await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
  const identity = { studyUid: uid(), seriesUid: uid(), sopUid: uid() }, bytes = createDicom(identity);
  await assert.rejects(archive.ingest(Readable.from([bytes]), {
    source: 'synthetic-remote', expectedStudyUid: identity.studyUid, expectedSeriesUid: uid(), expectedSopUid: identity.sopUid,
  }), error => error.statusCode === 409 && error.code === 'series-mismatch');
  assert.equal(archive.stats().instances, 0);
  assert.deepEqual(await readdir(`${dataDir}/spool`), []);
  assert.deepEqual(await readdir(`${dataDir}/journal`), []);
  const stored = await archive.ingest(Readable.from([bytes]), { source: 'synthetic-remote', expectedStudyUid: identity.studyUid, expectedSeriesUid: identity.seriesUid, expectedSopUid: identity.sopUid });
  assert.equal(stored.status, 'stored'); assert.equal(archive.stats().instances, 1);
  await assert.rejects(archive.ingest(Readable.from([bytes]), { source: 'synthetic-remote', expectedSeriesUid: uid() }), error => error.code === 'series-mismatch');
  assert.equal(archive.stats().instances, 1, 'an existing correct object is preserved');
});
