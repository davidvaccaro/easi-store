import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { Archive } from '../src/archive/Archive.js';
import { createStoreServer } from '../src/server.js';
import { createDicom, uid } from './fixtures/synthetic.js';
import { readZip } from './fixtures/independent-zip.js';

test('management export/removal remain protected in research mode, reject stale confirmation, reclaim only selected originals and persist across restart', async t => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'easi-store-management-'));
    let app = await createStoreServer({ dataDir, port: 0, accessProfile: 'local-research' });
    let address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
    t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
    const credentials = { username: 'research', password: 'synthetic-test-password' };
    const setup = await fetch(base + '/api/v1/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EASI-Store': '1' }, body: JSON.stringify(credentials) });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get('set-cookie').split(';')[0], headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-EASI-Store': '1' };
    const studyUid = uid(), seriesUid = uid(), retained = createDicom({ studyUid: uid(), seriesUid: uid() });
    const originals = [createDicom({ studyUid, seriesUid, instanceNumber: 1 }), createDicom({ studyUid, seriesUid, instanceNumber: 2 })];
    const kept = (await app.archive.ingest(Readable.from([retained]))).instance;
    for (const bytes of originals) await app.archive.ingest(Readable.from([bytes]));
    const endpoint = base + '/api/v1/studies/' + studyUid;
    assert.equal((await fetch(base + '/dicomweb/studies')).status, 200);
    for (const route of ['/export', '/deletion-preview']) assert.equal((await fetch(endpoint + route)).status, 401);
    assert.equal((await fetch(endpoint, { method: 'DELETE', headers: { 'X-EASI-Store': '1' }, body: '{}' })).status, 401);
    const preview = await (await fetch(endpoint + '/deletion-preview', { headers })).json();
    assert.equal(preview.instanceCount, 2); assert.equal(preview.seriesCount, 1);
    assert.equal(preview.bytes, originals.reduce((sum, bytes) => sum + bytes.length, 0));
    const remove = (body, overrides = {}) => fetch(endpoint, { method: 'DELETE', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
    assert.equal((await remove({ confirmation: 'DELETE', revision: preview.revision }, { 'X-EASI-Store': '' })).status, 403);
    assert.equal((await remove({ confirmation: 'DELETE', revision: preview.revision }, { Origin: 'https://unrelated.invalid' })).status, 403);
    assert.equal((await remove({ confirmation: 'delete', revision: preview.revision })).status, 400);
    assert.equal((await remove({ confirmation: 'DELETE' })).status, 400);
    assert.equal((await remove({ confirmation: 'DELETE', revision: preview.revision, unexpected: true })).status, 400);
    assert.equal(app.archive.stats().instances, 3);
    originals.push(createDicom({ studyUid, seriesUid, instanceNumber: 3 }));
    await app.archive.ingest(Readable.from([originals.at(-1)]));
    assert.equal((await remove({ confirmation: 'DELETE', revision: preview.revision })).status, 409);
    const fresh = await (await fetch(endpoint + '/deletion-preview', { headers })).json();
    const download = await fetch(endpoint + '/export', { headers });
    assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/zip');
    const zip = readZip(Buffer.from(await download.arrayBuffer())), manifest = JSON.parse(zip.entries.get('manifest.json').data);
    assert.equal(manifest.instanceCount, 3); assert.equal(manifest.anonymized, false);
    for (const item of manifest.instances) {
        const bytes = zip.entries.get(item.path).data;
        assert.ok(originals.some(original => original.equals(bytes)));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    }
    const release = app.archive.acquireReadLease();
    assert.equal((await remove({ confirmation: 'DELETE', revision: fresh.revision })).status, 409); release();
    const removedRecords = app.archive.snapshotStudyOriginals(studyUid);
    const result = await remove({ confirmation: 'DELETE', revision: fresh.revision });
    assert.equal(result.status, 200); const outcome = await result.json();
    assert.equal(outcome.deleted, true); assert.equal(outcome.reclamationPending, false); assert.equal(outcome.reclaimedBytes, fresh.bytes);
    assert.equal(app.archive.stats().instances, 1); assert.equal(app.archive.stats().studies, 1);
    for (const record of removedRecords) await assert.rejects(readFile(record.path), { code: 'ENOENT' });
    const retainedRecord = app.archive.getInstance(kept.studyUid, kept.seriesUid, kept.sopUid);
    assert.deepEqual(await readFile(retainedRecord.path), retained);
    const event = app.archive.activity().find(item => item.outcome === 'study-deleted');
    assert.equal(JSON.parse(event.details).instanceCount, 3); assert.equal(JSON.parse(event.details).studyUid, studyUid);
    assert.equal((await fetch(endpoint + '/export', { headers })).status, 404);
    await app.close(); app = await createStoreServer({ dataDir, port: 0 }); address = await app.listen(); base = `http://127.0.0.1:${address.port}`;
    assert.equal(app.archive.stats().instances, 1); assert.deepEqual(await readFile(app.archive.getInstance(kept.studyUid, kept.seriesUid, kept.sopUid).path), retained);
    assert.equal(app.archive.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(app.archive.db.prepare('SELECT COUNT(*) AS n FROM study_deletions').get().n, 0);
});

for (const route of ['original', 'wado']) test(`shutdown cancels a paused large ${route} response and drains its archive read lease`, { timeout: 15000 }, async t => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'easi-store-paused-reader-'));
    const app = await createStoreServer({ dataDir, port: 0 }), address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
    let request, response, closing;
    t.after(async () => { response?.destroy(); request?.destroy(); await (closing || app.close()); await rm(dataDir, { recursive: true, force: true }); });
    const setup = await fetch(base + '/api/v1/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EASI-Store': '1' },
        body: JSON.stringify({ username: 'synthetic', password: 'synthetic-test-password' }) });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    // Larger than ordinary loopback send/receive buffers: pausing the client
    // must leave the server's original-file reader under backpressure.
    const original = createDicom({ rows: 512, columns: 512, frames: 32 });
    const { instance } = await app.archive.ingest(Readable.from([original]));
    const endpoint = route === 'original' ? `/api/v1/download/${instance.studyUid}/${instance.seriesUid}/${instance.sopUid}`
        : `/dicomweb/studies/${instance.studyUid}/series/${instance.seriesUid}/instances/${instance.sopUid}`;
    response = await new Promise((resolve, reject) => {
        request = get(base + endpoint, { headers: { Cookie: cookie } }, incoming => { incoming.on('error', () => {}); incoming.pause(); resolve(incoming); });
        request.on('error', reject);
    });
    assert.equal(response.statusCode, 200);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(app.archive.readLeases.size, 1, 'the paused response retains a lease while its original is being read');
    assert.equal(response.complete, false);
    closing = app.close();
    let deadline;
    try { await Promise.race([closing, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Shutdown retained a paused archive read lease.')), 3000); })]); }
    finally { clearTimeout(deadline); }
    assert.equal(app.archive.readLeases.size, 0); assert.equal(app.archive.closed, true);
    const recovered = await Archive.open({ dataDir });
    try {
        assert.equal(recovered.stats().instances, 1);
        assert.deepEqual(await readFile(recovered.getInstance(instance.studyUid, instance.seriesUid, instance.sopUid).path), original);
    } finally { await recovered.close(); }
});
