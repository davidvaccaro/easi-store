import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { Archive } from '../src/archive/Archive.js';
import { handleDicomweb } from '../src/dicomweb/router.js';
import { RelatedReader } from '../src/dicomweb/multipart.js';
import { createDicom, uid } from './fixtures/synthetic.js';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp('/private/tmp/easi-store-web-test-');
  const archive = await Archive.open({ dataDir, ...options });
  const server = createServer(async (req, res) => { if (!await handleDicomweb(req, res, { archive })) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { archive, base: `http://127.0.0.1:${server.address().port}/dicomweb` };
}
function related(parts, boundary = 'test-boundary') {
  return Buffer.concat(parts.flatMap(bytes => [Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), bytes, Buffer.from('\r\n')]).concat(Buffer.from(`--${boundary}--\r\n`)));
}
function post(base, parts, suffix = '', extra = {}) {
  return fetch(`${base}/studies${suffix}`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; type="application/dicom"; boundary="test-boundary"', Accept: 'application/dicom+json', ...extra }, body: related(parts) });
}

test('QIDO returns 200 [] for no matches and truthful capabilities', async t => {
  const { base } = await fixture(t);
  const empty = await fetch(`${base}/studies`);
  assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), []);
  const capabilities = await fetch(base, { method: 'OPTIONS' });
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).supported.unchangedTransferSyntaxOnly, true);
  assert.equal((await fetch(`${base}/studies`, { headers: { Accept: 'application/xml' } })).status, 406);
  assert.equal((await fetch(`${base}/studies?fuzzymatching=true`)).status, 400);
});

test('STOW stores durably; QIDO traverses hierarchy and WADO returns identical original', async t => {
  const { archive, base } = await fixture(t);
  const ids = { studyUid: uid(), seriesUid: uid(), sopUid: uid() };
  const bytes = createDicom({ ...ids, patientName: 'Synthetic^Web' });
  const stored = await post(base, [bytes]);
  assert.equal(stored.status, 200);
  assert.equal((await stored.json())['00081199'].Value[0]['00081155'].Value[0], ids.sopUid);
  assert.equal(archive.stats().instances, 1);
  const studies = await (await fetch(`${base}/studies?PatientName=Synthetic*`)).json();
  assert.equal(studies[0]['0020000D'].Value[0], ids.studyUid);
  assert.equal(studies[0]['00201208'].Value[0], 1);
  const series = await (await fetch(`${base}/studies/${ids.studyUid}/series`)).json();
  assert.equal(series[0]['0020000E'].Value[0], ids.seriesUid);
  const instances = await (await fetch(`${base}/studies/${ids.studyUid}/series/${ids.seriesUid}/instances`)).json();
  assert.equal(instances[0]['00080018'].Value[0], ids.sopUid);
  const wado = await fetch(`${base}/studies/${ids.studyUid}/series/${ids.seriesUid}/instances/${ids.sopUid}`, { headers: { Accept: 'multipart/related; type="application/dicom"; transfer-syntax=*' } });
  assert.equal(wado.status, 200);
  const boundary = wado.headers.get('content-type').match(/boundary="([^"]+)"/)[1];
  const parts = [];
  for await (const part of new RelatedReader(Readable.fromWeb(wado.body), boundary).parts()) {
    const chunks = []; for await (const chunk of part.body) chunks.push(chunk);
    parts.push(Buffer.concat(chunks));
  }
  assert.deepEqual(parts, [bytes]);
  const repeat = await post(base, [bytes]); assert.equal(repeat.status, 200);
  assert.equal(archive.stats().instances, 1);
});

test('QIDO supports exact UIDs, date ranges, wildcards, counts and pagination', async t => {
  const { archive, base } = await fixture(t);
  const studyUid = uid();
  for (const modality of ['CT', 'MR']) await archive.ingest(Readable.from([createDicom({ studyUid, modality })]));
  await archive.ingest(Readable.from([createDicom({ patientId: 'OTHER', studyDate: '20251001' })]));
  const response = await fetch(`${base}/studies?Modality=CT&StudyDate=20260101-20261231`);
  const found = await response.json();
  assert.equal(found.length, 1);
  assert.equal(found[0]['00201208'].Value[0], 2, 'counts include the whole matched study');
  assert.deepEqual(new Set(found[0]['00080061'].Value), new Set(['CT', 'MR']));
  const paged = await fetch(`${base}/studies?limit=1`);
  assert.equal((await paged.json()).length, 1);
  assert.ok(paged.headers.get('warning')?.includes('Additional'));
  assert.equal((await (await fetch(`${base}/studies?limit=1&offset=1`)).json()).length, 1);
  assert.equal((await (await fetch(`${base}/studies?StudyInstanceUID=${studyUid}`)).json()).length, 1);
  assert.equal((await fetch(`${base}/studies?limit=1001`)).status, 400);
  assert.equal((await fetch(`${base}/studies?offset=-1`)).status, 400);
  assert.equal((await fetch(`${base}/studies?includefield=all`)).status, 400);
});

test('STOW mixed valid/invalid outcomes are 202, conflicts preserve originals', async t => {
  const { archive, base } = await fixture(t);
  const identity = { studyUid: uid(), seriesUid: uid(), sopUid: uid() };
  const bytes = createDicom(identity);
  const mixed = await post(base, [bytes, Buffer.from('not a DICOM')]);
  assert.equal(mixed.status, 202);
  const result = await mixed.json();
  assert.equal(result['00081199'].Value.length, 1);
  assert.equal(result['00081198'].Value.length, 1);
  const conflict = await post(base, [createDicom({ ...identity, patientName: 'Changed^Synthetic' })]);
  assert.equal(conflict.status, 409);
  assert.equal(archive.stats().instances, 1);
  const wrongStudy = await post(base, [createDicom()], `/${uid()}`);
  assert.equal(wrongStudy.status, 409);
});

test('STOW rejects unsupported media, missing close boundary and unsupported routes', async t => {
  const { archive, base } = await fixture(t);
  assert.equal((await fetch(`${base}/studies`, { method: 'POST', headers: { 'Content-Type': 'application/dicom' }, body: createDicom() })).status, 415);
  const broken = related([createDicom()]).subarray(0, -20);
  assert.equal((await fetch(`${base}/studies`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; type="application/dicom"; boundary=test-boundary' }, body: broken })).status, 400);
  assert.equal(archive.stats().instances, 0);
  assert.equal((await fetch(`${base}/studies/${uid()}/metadata`)).status, 404);
  assert.equal((await fetch(`${base}/studies`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${base}/studies/invalid`)).status, 400);
});

test('multipart parser splits boundaries at every byte and preserves false binary prefixes', async () => {
  const original = Buffer.from('hello\r\n--test-boundaryXQ this is binary\r\nworld');
  const bytes = related([original, Buffer.from('second')]);
  const reader = new RelatedReader(Readable.from(Array.from(bytes, value => Buffer.from([value]))), 'test-boundary');
  const actual = [];
  for await (const part of reader.parts()) {
    const chunks = []; for await (const chunk of part.body) chunks.push(chunk); actual.push(Buffer.concat(chunks));
  }
  assert.deepEqual(actual, [original, Buffer.from('second')]);
});

test('an oversized STOW part is drained so a smaller following instance can still import', async t => {
  const { archive, base } = await fixture(t, { maxInstanceBytes: 40000 });
  const response = await post(base, [createDicom({ frames: 5 }), createDicom()]);
  assert.equal(response.status, 202);
  assert.equal(archive.stats().instances, 1);
});

test('unchanged transfer syntax is explicit; default and unsupported transcoding are rejected', async t => {
  const { base } = await fixture(t);
  const bytes = createDicom();
  await post(base, [bytes]);
  const studies = await (await fetch(`${base}/studies`)).json();
  const url = `${base}/studies/${studies[0]['0020000D'].Value[0]}`;
  assert.equal((await fetch(url, { headers: { Accept: 'application/dicom' } })).status, 406);
  assert.equal((await fetch(url, { headers: { Accept: 'multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2' } })).status, 406);
  assert.equal((await fetch(url, { headers: { Accept: 'multipart/related; type="application/dicom"; transfer-syntax=*;q=0' } })).status, 406);
});
