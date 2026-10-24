import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { Archive } from '../src/archive/Archive.js';
import { handleDicomweb } from '../src/dicomweb/router.js';
import { MetadataService } from '../src/dicomweb/MetadataService.js';
import { RelatedReader } from '../src/dicomweb/multipart.js';
import { createDicom, uid } from './fixtures/synthetic.js';
import { advancedDicom, encodedElement, sequence, encapsulated } from './fixtures/advanced-dicom.js';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp('/private/tmp/easi-web-phase2-');
  const archive = await Archive.open({ dataDir }), metadataService = new MetadataService();
  const server = createServer(async (req, res) => { if (!await handleDicomweb(req, res, { archive, metadataService, ...options })) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { archive, metadataService, base: `http://127.0.0.1:${server.address().port}/dicomweb`, origin: `http://127.0.0.1:${server.address().port}` };
}
async function multipart(response) {
  assert.equal(response.status, 200, await response.clone().text());
  const boundary = response.headers.get('content-type').match(/boundary="([^"]+)"/)[1], parts = [];
  for await (const part of new RelatedReader(Readable.fromWeb(response.body), boundary).parts()) {
    const chunks = []; for await (const chunk of part.body) chunks.push(chunk);
    parts.push({ headers: part.headers, bytes: Buffer.concat(chunks) });
  }
  return parts;
}
const nativeAccept = { Accept: 'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1' };

test('QIDO accepts standalone View return fields and patient accession/issuer/birth/modality filters without schema migration', async t => {
  const { archive, base } = await fixture(t), studyUid = uid();
  await archive.ingest(Readable.from([createDicom({ studyUid, modality: 'CT' })]));
  await archive.ingest(Readable.from([createDicom({ studyUid, modality: 'MR' })]));
  const include = '00080020,00080050,00080061,00081030,00100010,00100020,00100021,00100030,0020000D,00201206,00201208';
  const url = `${base}/studies?includefield=${include}&includefield=StudyTime&AccessionNumber=SYN*&PatientBirthDate=19900101-20010101&IssuerOfPatientID=EASI-DEMO&ModalitiesInStudy=MR`;
  const response = await fetch(url); assert.equal(response.status, 200);
  const studies = await response.json();
  assert.equal(studies.length, 1); assert.equal(studies[0]['00201208'].Value[0], 2);
  assert.deepEqual(new Set(studies[0]['00080061'].Value), new Set(['CT', 'MR']));
  assert.equal(studies[0]['00100030'].Value[0], '20000101');
  assert.equal((await (await fetch(`${base}/studies?AccessionNumber=OTHER`)).json()).length, 0);
  assert.equal((await (await fetch(`${base}/studies?IssuerOfPatientID=OTHER`)).json()).length, 0);
  assert.equal((await fetch(`${base}/studies?fuzzymatching=false`)).status, 200);
  const series = await fetch(`${base}/studies/${studyUid}/series?includefield=00080060,0008103E,0020000D,0020000E,00200011,00201209`);
  assert.equal(series.status, 200); assert.equal((await series.json()).length, 2);
});

test('metadata resources preserve complete nested attributes and give exact authenticated-route bulk references', async t => {
  const { archive, base, origin } = await fixture(t);
  const bytes = Buffer.from([4, 5, 6, 7]);
  const input = advancedDicom({ extra: [{ tag: '0040A730', bytes: sequence('0040A730', [encodedElement('77771001', 'OB', bytes)]) }] });
  await archive.ingest(Readable.from([input.bytes]));
  const path = `${base}/studies/${input.record.studyUid}/series/${input.record.seriesUid}/instances/${input.record.sopUid}`;
  for (const resource of [`${base}/studies/${input.record.studyUid}`, `${base}/studies/${input.record.studyUid}/series/${input.record.seriesUid}`, path]) {
    const response = await fetch(`${resource}/metadata`); assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.equal(metadata.length, 1); assert.equal(metadata[0]['00280100'].Value[0], 16);
    assert.equal(metadata[0]['7FE00010'].InlineBinary, undefined);
    const uri = metadata[0]['0040A730'].Value[0]['77771001'].BulkDataURI;
    assert.ok(uri.startsWith('/dicomweb/studies/'));
    const result = await multipart(await fetch(`${origin}${uri}`, { headers: nativeAccept }));
    assert.deepEqual(result[0].bytes, bytes);
  }
  assert.equal((await fetch(`${path}/metadata`, { headers: { Accept: 'application/dicom+xml' } })).status, 406);
  assert.equal((await fetch(`${path}/bulkdata/../../etc/passwd`)).status, 404);
  assert.equal((await fetch(`${path}/bulkdata/77771001`)).status, 404);
  assert.equal((await fetch(`${path}/metadata`, { method: 'POST' })).status, 405);
});

test('native frame endpoints select exact frames and preserve multi-frame sample order', async t => {
  const { archive, base } = await fixture(t), pixels = Buffer.from(Array.from({ length: 36 }, (_, i) => i + 1));
  const input = advancedDicom({ rows: 2, columns: 2, frames: 3, samples: 3, bits: 8, photometric: 'RGB', pixels });
  await archive.ingest(Readable.from([input.bytes]));
  const path = `${base}/studies/${input.record.studyUid}/series/${input.record.seriesUid}/instances/${input.record.sopUid}`;
  const result = await multipart(await fetch(`${path}/frames/3,1`, { headers: nativeAccept }));
  assert.equal(result.length, 1); assert.deepEqual(result[0].bytes, Buffer.concat([pixels.subarray(24), pixels.subarray(0, 12)]));
  assert.ok(result[0].headers['content-location'].endsWith('/frames/3,1'));
  for (const suffix of ['0', '4', '1,1', '1.0', '-1', '9007199254740999']) assert.equal((await fetch(`${path}/frames/${suffix}`, { headers: nativeAccept })).status, 400, suffix);
  assert.equal((await fetch(`${path}/frames/1`, { headers: { Accept: 'multipart/related; type="image/jpeg"' } })).status, 406);
});

test('selected 1-bit native frames are repacked without padding between frames', async t => {
  const { archive, base } = await fixture(t);
  // Three five-bit frames: [10101], [01110], [11000], LSB first.
  const bits = [1,0,1,0,1, 0,1,1,1,0, 1,1,0,0,0], pixels = Buffer.alloc(2);
  bits.forEach((bit, i) => { if (bit) pixels[i >>> 3] |= 1 << (i & 7); });
  const input = advancedDicom({ rows: 1, columns: 5, frames: 3, bits: 1, pixels });
  await archive.ingest(Readable.from([input.bytes]));
  const path = `${base}/studies/${input.record.studyUid}/series/${input.record.seriesUid}/instances/${input.record.sopUid}`;
  const result = await multipart(await fetch(`${path}/frames/3,1`, { headers: nativeAccept }));
  const expected = Buffer.alloc(2);
  [...bits.slice(10, 15), ...bits.slice(0, 5)].forEach((bit, i) => { if (bit) expected[i >>> 3] |= 1 << (i & 7); });
  assert.deepEqual(result[0].bytes, expected);
});

test('native big-endian bulk is byte-swapped to little-endian, preserving stored originals', async t => {
  const { archive, base } = await fixture(t), pixels = Buffer.alloc(12), expected = Buffer.alloc(12);
  [1, 255, 4096, 8192, 31, 65535].forEach((value, i) => { pixels.writeUInt16BE(value, i * 2); expected.writeUInt16LE(value, i * 2); });
  const input = advancedDicom({ syntax: '1.2.840.10008.1.2.2', pixels });
  await archive.ingest(Readable.from([input.bytes]));
  const path = `${base}/studies/${input.record.studyUid}/series/${input.record.seriesUid}/instances/${input.record.sopUid}`;
  const bulk = await multipart(await fetch(`${path}/bulkdata/7FE00010`, { headers: nativeAccept }));
  assert.deepEqual(bulk[0].bytes, expected);
  const original = await multipart(await fetch(path, { headers: { Accept: 'multipart/related; type="application/dicom"; transfer-syntax=*' } }));
  assert.deepEqual(original[0].bytes, input.bytes);
});

test('compressed bulk and frame resources return per-frame codestreams and truthful media negotiation', async t => {
  const { archive, base } = await fixture(t);
  const frames = [[Buffer.from([255, 216, 1, 2]), Buffer.from([3, 4, 255, 217])], [Buffer.from([255, 216, 9, 8, 255, 217])]];
  const input = advancedDicom({ syntax: '1.2.840.10008.1.2.4.50', frames: 2, bits: 8, pixelElement: encapsulated(frames) });
  await archive.ingest(Readable.from([input.bytes]));
  const path = `${base}/studies/${input.record.studyUid}/series/${input.record.seriesUid}/instances/${input.record.sopUid}`;
  const headers = { Accept: 'multipart/related; type="image/jpeg"; transfer-syntax=*' };
  const bulk = await multipart(await fetch(`${path}/bulkdata/7FE00010`, { headers }));
  assert.equal(bulk.length, 2); assert.deepEqual(bulk.map(part => part.bytes), frames.map(fragments => Buffer.concat(fragments)));
  const selected = await multipart(await fetch(`${path}/frames/2`, { headers }));
  assert.deepEqual(selected[0].bytes, Buffer.concat(frames[1]));
  assert.equal((await fetch(`${path}/frames/1`, { headers: nativeAccept })).status, 406, 'compressed bytes are never mislabeled as native octets');
  assert.equal((await fetch(`${path}/frames/1`, { headers: { Accept: 'multipart/related; type="image/jpeg"; transfer-syntax=*; q=0' } })).status, 406);
});

test('metadata request disconnect releases its reader and leaves subsequent requests functional', async t => {
  const { archive, base, metadataService } = await fixture(t);
  const input = advancedDicom({ rows: 1024, columns: 1024, frames: 16 });
  await archive.ingest(Readable.from([input.bytes]));
  const controller = new AbortController();
  const request = fetch(`${base}/studies/${input.record.studyUid}/metadata`, { signal: controller.signal });
  controller.abort(); await assert.rejects(request);
  const next = await fetch(`${base}/studies/${input.record.studyUid}/metadata`);
  assert.equal(next.status, 200); await next.json(); assert.equal(metadataService.active, 0);
});

test('a trusted public prefix changes response URIs without exposing a second unauthenticated route', async t => {
  const { archive, base, origin } = await fixture(t, { publicBasePath: '/easi-store/dicomweb' });
  const input = advancedDicom(); await archive.ingest(Readable.from([input.bytes]));
  const suffix = `/studies/${input.record.studyUid}/series/${input.record.seriesUid}/instances/${input.record.sopUid}`;
  const metadata = await (await fetch(`${base}${suffix}/metadata`)).json();
  assert.equal(metadata[0]['7FE00010'].BulkDataURI, `/easi-store/dicomweb${suffix}/bulkdata/7FE00010`);
  const frames = await multipart(await fetch(`${base}${suffix}/frames/1`, { headers: nativeAccept }));
  assert.equal(frames[0].headers['content-location'], `/easi-store/dicomweb${suffix}/frames/1`);
  const original = await multipart(await fetch(`${base}${suffix}`, { headers: { Accept: 'multipart/related; type="application/dicom"; transfer-syntax=*' } }));
  assert.equal(original[0].headers['content-location'], `/easi-store/dicomweb${suffix}`);
  assert.equal((await fetch(`${origin}/easi-store/dicomweb${suffix}/metadata`)).status, 404);
});

test('an outbound multipart reader explicitly closes its unread source once without affecting STOW draining', async () => {
  let returned = 0;
  async function* source() {
    try { yield Buffer.from('--synthetic\r\nContent-Type: application/dicom\r\n\r\nfirst\r\n--synthetic\r\nContent-Type: application/dicom\r\n\r\nsecond\r\n--synthetic--\r\n'); }
    finally { returned++; }
  }
  const reader = new RelatedReader(source(), 'synthetic');
  const iterator = reader.parts();
  await iterator.next();
  await reader.close(); await reader.close();
  assert.equal(returned, 1); assert.equal(reader.buffer.length, 0);
});
