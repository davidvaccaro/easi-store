import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { Writable, Readable } from 'node:stream';
import { mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Archive } from '../src/archive/Archive.js';
import { createStudyExportService } from '../src/exports/StudyExport.js';
import { createDicom, uid } from './fixtures/synthetic.js';
import { readZip, crc32 } from './fixtures/independent-zip.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'easi-store-export-')), archive = await Archive.open({ dataDir: directory });
    const service = createStudyExportService(options), failures = [];
    const server = createServer(async (request, response) => {
        try { await service.export(request, response, archive, request.url.slice(1)); }
        catch (error) {
            failures.push({ code: error.code, status: error.statusCode });
            if (response.destroyed) return;
            if (response.headersSent) response.destroy();
            else { response.statusCode = error.statusCode || 500; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: error.message })); }
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await archive.close(); await rm(directory, { recursive: true, force: true }); });
    return { directory, archive, service, failures, base: `http://127.0.0.1:${server.address().port}` };
}
async function ingest(archive, options) { const bytes = createDicom(options); const result = await archive.ingest(Readable.from([bytes])); return { bytes, instance: result.instance }; }
async function idle(service) { for (let index = 0; index < 200 && (service.getState().activeExports || service.getState().activeOriginalReaders); index++) await pause(5); assert.equal(service.getState().activeExports, 0); assert.equal(service.getState().activeOriginalReaders, 0); }

test('streamed study ZIP preserves exact originals, UID-only paths, independent CRCs and a complete SHA256 manifest', async t => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'independent CRC implementation uses a known check vector');
    const f = await fixture(t), studyUid = uid(), seriesUid = uid();
    const first = await ingest(f.archive, { studyUid, seriesUid, instanceNumber: 1, patientName: 'Synthetic^PrivateName', patientId: 'SYNTHETIC-PRIVATE-ID' });
    const second = await ingest(f.archive, { studyUid, seriesUid: uid(), instanceNumber: 2, patientName: 'Synthetic^PrivateName', patientId: 'SYNTHETIC-PRIVATE-ID' });
    await ingest(f.archive, { studyUid: uid(), patientName: 'Synthetic^Unselected' });
    const response = await fetch(f.base + '/' + studyUid);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="easi-study-${studyUid}.zip"`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const zip = readZip(Buffer.from(await response.arrayBuffer())); assert.equal(zip.zip64, false); assert.equal(zip.entries.size, 4);
    const manifest = JSON.parse(zip.entries.get('manifest.json').data);
    assert.equal(manifest.manifestVersion, 1); assert.equal(manifest.anonymized, false); assert.equal(manifest.studyUid, studyUid);
    assert.equal(manifest.instanceCount, 2); assert.equal(manifest.seriesCount, 2); assert.equal(manifest.totalOriginalBytes, first.bytes.length + second.bytes.length);
    assert.equal(manifest.integrity.algorithm, 'SHA-256'); assert.match(zip.entries.get('README.txt').data.toString(), /not\nan anonymized/);
    assert.doesNotMatch(JSON.stringify(manifest), /PrivateName|SYNTHETIC-PRIVATE-ID|objectKey|\/objects\//);
    for (const original of [first, second]) {
        const entry = manifest.instances.find(item => item.sopUid === original.instance.sopUid);
        assert.equal(entry.path, `DICOM/${studyUid}/${original.instance.seriesUid}/${original.instance.sopUid}.dcm`);
        assert.equal(entry.bytes, original.bytes.length); assert.equal(entry.sha256, sha256(original.bytes));
        assert.equal(zip.entries.get(entry.path).method, 0); assert.deepEqual(zip.entries.get(entry.path).data, original.bytes);
    }
    await idle(f.service); assert.equal(f.archive.stats().instances, 3);
});

test('forced small ZIP64 archive is independently readable with ZIP64 directory and data-descriptor sizes', async t => {
    const f = await fixture(t, { forceZip64Format: true }), original = await ingest(f.archive, {});
    const response = await fetch(f.base + '/' + original.instance.studyUid), zip = readZip(Buffer.from(await response.arrayBuffer()));
    assert.equal(zip.zip64, true); const manifest = JSON.parse(zip.entries.get('manifest.json').data);
    assert.deepEqual(zip.entries.get(manifest.instances[0].path).data, original.bytes); assert.equal(manifest.instances[0].sha256, sha256(original.bytes));
});

test('export preflight rejects invalid, absent and over-limit studies before reading originals or starting ZIP output', async t => {
    for (const limits of [{ maxInstances: 1 }, { maxStudyBytes: 100 }, { maxManifestBytes: 1024 }]) {
        const f = await fixture(t, limits), studyUid = uid();
        for (let index = 0; index < 4; index++) await ingest(f.archive, { studyUid, instanceNumber: index + 1 });
        assert.equal((await fetch(f.base + '/bad-uid')).status, 400); assert.equal((await fetch(f.base + '/' + uid())).status, 404);
        const response = await fetch(f.base + '/' + studyUid); assert.equal(response.status, 413); assert.equal(response.headers.get('content-type'), 'application/json');
        assert.equal(f.service.getState().originalsOpened, 0); await idle(f.service);
    }
});

test('changed original bytes abort the HTTP download rather than producing a successful ZIP or integrity manifest', async t => {
    const f = await fixture(t), original = await ingest(f.archive, {}), record = f.archive.getInstance(original.instance.studyUid, original.instance.seriesUid, original.instance.sopUid);
    const file = await open(record.path, 'r+');
    try { const last = Buffer.from([original.bytes.at(-1) ^ 0xff]); await file.write(last, 0, 1, original.bytes.length - 1); } finally { await file.close(); }
    await assert.rejects(async () => { const response = await fetch(f.base + '/' + original.instance.studyUid); await response.arrayBuffer(); });
    await idle(f.service); assert.ok(f.failures.some(item => item.code === 'export-integrity-failed'));
    assert.equal(f.archive.stats().instances, 1, 'failed export never removes the archived instance');
});

test('missing and length-mismatched originals abort promptly and release archive leases', async t => {
    for (const missing of [true, false]) {
        const f = await fixture(t, { operationTimeoutMs: 1000 }), original = await ingest(f.archive, {}), record = f.archive.getInstance(original.instance.studyUid, original.instance.seriesUid, original.instance.sopUid);
        if (missing) await unlink(record.path); else { const file = await open(record.path, 'r+'); try { await file.truncate(original.bytes.length - 1); } finally { await file.close(); } }
        await assert.rejects(async () => { const response = await fetch(f.base + '/' + original.instance.studyUid); await response.arrayBuffer(); });
        await idle(f.service); assert.ok(f.failures.some(item => item.code === 'export-integrity-failed'));
        const release = f.archive.acquireReadLease(); release();
    }
});

test('slow receivers retain backpressure, one lazy original reader and the deletion lease until cancellation', { timeout: 20000 }, async t => {
    const f = await fixture(t), studyUid = uid(), seriesUid = uid();
    for (let index = 0; index < 3; index++) await ingest(f.archive, { studyUid, seriesUid, instanceNumber: index + 1, rows: 1024, columns: 1024 });
    const preview = f.archive.previewStudyDeletion(studyUid), request = new EventEmitter(); let started;
    const arrived = new Promise(resolve => { started = resolve; });
    const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { started(); } }); sink.setHeader = () => {};
    const operation = f.service.export(request, sink, f.archive, studyUid).catch(error => error); await arrived;
    for (let index = 0; index < 100 && !f.service.getState().originalsOpened; index++) await pause(5);
    await pause(30);
    const state = f.service.getState(); assert.equal(state.activeExports, 1); assert.equal(state.activeOriginalReaders, 1); assert.equal(state.originalsOpened, 1);
    assert.ok(state.originalBytesRead < 2 * 1024 * 1024, 'backpressure prevents reading even the first whole original, let alone the whole study');
    await assert.rejects(f.archive.deleteStudy(studyUid, { confirmation: 'DELETE', revision: preview.revision }), error => error.code === 'archive-read-active');
    sink.destroy(); await operation; await idle(f.service);
    assert.equal(f.archive.stats().instances, 3); const release = f.archive.acquireReadLease(); release();
});

test('export concurrency, caller cancellation, deadline and shutdown cannot leave readers or leases active', { timeout: 10000 }, async t => {
    const f = await fixture(t, { maxConcurrent: 1 }), original = await ingest(f.archive, {});
    const request = new EventEmitter(), controller = new AbortController(); let began;
    const arrived = new Promise(resolve => { began = resolve; });
    const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { began(); } }); sink.setHeader = () => {};
    const pending = f.service.export(request, sink, f.archive, original.instance.studyUid, { signal: controller.signal }).catch(error => error); await arrived;
    assert.equal((await fetch(f.base + '/' + original.instance.studyUid)).status, 429);
    controller.abort(); await pending; await idle(f.service);
    const secondSink = new Writable({ write(_chunk, _encoding, _callback) {} }); secondSink.setHeader = () => {};
    const active = f.service.export(new EventEmitter(), secondSink, f.archive, original.instance.studyUid).catch(error => error);
    await pause(10); await f.service.close(); await active; await idle(f.service);
    const release = f.archive.acquireReadLease(); release(); assert.equal((await fetch(f.base + '/' + original.instance.studyUid)).status, 503);
    const timed = createStudyExportService({ operationTimeoutMs: 20 });
    const timedSink = new Writable({ write(_chunk, _encoding, _callback) {} }); timedSink.setHeader = () => {};
    await assert.rejects(timed.export(new EventEmitter(), timedSink, f.archive, original.instance.studyUid), error => error.code === 'export-timeout');
    await idle(timed); await timed.close();
});

test('a browser-style HTTP download cancellation promptly closes original readers and returns its export slot', async t => {
    const f = await fixture(t, { maxConcurrent: 1 }), original = await ingest(f.archive, { rows: 1024, columns: 1024, frames: 2 });
    const controller = new AbortController(), response = await fetch(f.base + '/' + original.instance.studyUid, { signal: controller.signal });
    const reader = response.body.getReader(); assert.equal((await reader.read()).done, false);
    controller.abort(); await reader.cancel().catch(() => {}); reader.releaseLock(); await idle(f.service);
    const release = f.archive.acquireReadLease(); release();
    const retried = await fetch(f.base + '/' + original.instance.studyUid);
    assert.equal(retried.status, 200); const zip = readZip(Buffer.from(await retried.arrayBuffer()));
    assert.equal(JSON.parse(zip.entries.get('manifest.json').data).instanceCount, 1);
});
