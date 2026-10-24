import { tmpdir } from 'node:os';
import { join as temporaryJoin } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { MetadataService } from '../src/dicomweb/MetadataService.js';
import { advancedDicom, encodedElement, sequence, encapsulated } from './fixtures/advanced-dicom.js';

async function file(t, fixture) {
  const directory = await mkdtemp(temporaryJoin(tmpdir(), 'easi-metadata-test-'));
  const record = { ...fixture.record, path: `${directory}/original.dcm` };
  await writeFile(record.path, fixture.bytes);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return record;
}
async function frameBytes(service, record, descriptor) {
  const chunks = []; for await (const chunk of service.frameChunks(record, descriptor)) chunks.push(chunk); return Buffer.concat(chunks);
}

test('complete metadata preserves nested enhanced geometry/reference sequences and binary bulk ranges without pixels', async t => {
  const reference = sequence('00081140', [encodedElement('00081155', 'UI', '1.2.3.4.5')]);
  const geometry = sequence('00289110', [Buffer.concat([encodedElement('00280030', 'DS', '0.7\\0.8'), encodedElement('00180050', 'DS', '2.5')])]);
  const position = sequence('00209113', [encodedElement('00200032', 'DS', '0\\1\\2')]);
  const binary = Buffer.from([9, 8, 7, 6]);
  const nestedBulk = sequence('0040A730', [Buffer.concat([reference, encodedElement('77771001', 'OB', binary)])]);
  const fixture = advancedDicom({ extra: [
    { tag: '00081115', bytes: sequence('00081115', [Buffer.concat([encodedElement('0020000E', 'UI', '1.2.3.4'), reference])]) },
    { tag: '0040A730', bytes: nestedBulk },
    { tag: '52009229', bytes: sequence('52009229', [geometry]) },
    { tag: '52009230', bytes: sequence('52009230', [position, position]) },
    { tag: '77771003', bytes: encodedElement('77771003', 'US', [3, 5]) },
  ] });
  const record = await file(t, fixture), service = new MetadataService();
  const result = await service.read(record);
  assert.deepEqual(result.metadata['52009229'].Value[0]['00289110'].Value[0]['00280030'].Value, [0.7, 0.8]);
  assert.equal(result.metadata['52009230'].Value.length, 2);
  assert.deepEqual(result.metadata['52009230'].Value[1]['00209113'].Value[0]['00200032'].Value, [0, 1, 2]);
  assert.equal(result.metadata['00081115'].Value[0]['00081140'].Value[0]['00081155'].Value[0], '1.2.3.4.5');
  assert.deepEqual(result.metadata['77771003'].Value, [3, 5]);
  const descriptor = result.bulk.get('0040A730/1/77771001');
  assert.deepEqual(fixture.bytes.subarray(descriptor.offset, descriptor.offset + descriptor.length), binary);
  assert.ok(result.metadata['0040A730'].Value[0]['77771001'].BulkDataURI.endsWith('/bulkdata/0040A730/1/77771001'));
  assert.equal(result.metadata['7FE00010'].Value, undefined);
  assert.equal(result.metadata['7FE00010'].InlineBinary, undefined);
  assert.equal(result.metadata['00020010'], undefined, 'File Meta Information is not dataset metadata');
  assert.deepEqual(await readFile(record.path), fixture.bytes, 'metadata extraction preserves originals');
});

test('native RGB multi-frame extraction preserves samples, frame order and metadata', async t => {
  const pixels = Buffer.from(Array.from({ length: 24 }, (_, i) => i + 1));
  const fixture = advancedDicom({ rows: 2, columns: 2, frames: 2, samples: 3, bits: 8, photometric: 'RGB', pixels, extra: [{ tag: '00280006', bytes: encodedElement('00280006', 'US', 0) }] });
  const record = await file(t, fixture), service = new MetadataService();
  const descriptors = await service.frames(record, [2, 1]);
  assert.deepEqual(await frameBytes(service, record, descriptors[0]), pixels.subarray(12));
  assert.deepEqual(await frameBytes(service, record, descriptors[1]), pixels.subarray(0, 12));
  const metadata = (await service.read(record)).metadata;
  assert.equal(metadata['00280002'].Value[0], 3);
  assert.equal(metadata['00280006'].Value[0], 0);
});

test('native implicit and big-endian frames are returned as exact little-endian sample values', async t => {
  for (const syntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.2']) {
    const values = [1, 255, 4096, 65535, 7, 500];
    const pixels = Buffer.alloc(12); values.forEach((value, i) => pixels[syntax.endsWith('.2.2') ? 'writeUInt16BE' : 'writeUInt16LE'](value, i * 2));
    const record = await file(t, advancedDicom({ syntax, pixels })), service = new MetadataService();
    const metadata = await service.read(record);
    assert.equal(metadata.metadata['00280010'].Value[0], 2);
    const [frame] = await service.frames(record, [1]);
    assert.equal(frame.transferSyntaxUid, '1.2.840.10008.1.2.1');
    const bytes = await frameBytes(service, record, frame);
    assert.deepEqual(Array.from({ length: 6 }, (_, i) => bytes.readUInt16LE(i * 2)), values);
  }
});

test('compressed frames exclude BOT/item headers and join frame fragments with validated offsets', async t => {
  const frames = [[Buffer.from([255, 216, 1, 2]), Buffer.from([3, 4, 255, 217])], [Buffer.from([255, 216, 9, 8, 255, 217])]];
  const fixture = advancedDicom({ syntax: '1.2.840.10008.1.2.4.50', frames: 2, bits: 8, pixelElement: encapsulated(frames) });
  const record = await file(t, fixture), service = new MetadataService();
  const descriptors = await service.frames(record, [2, 1]);
  assert.equal(descriptors[0].mediaType, 'image/jpeg');
  assert.deepEqual(await frameBytes(service, record, descriptors[0]), Buffer.concat(frames[1]));
  assert.deepEqual(await frameBytes(service, record, descriptors[1]), Buffer.concat(frames[0]));
  assert.equal((await service.read(record)).pixel.length, 8 + 8 + frames.flat().reduce((sum, bytes) => sum + 8 + bytes.length, 0));
});

test('ambiguous compressed frames and invalid/truncated offsets fail explicitly', async t => {
  const service = new MetadataService(), frames = [[Buffer.from([255, 216, 1, 2]), Buffer.from([3, 4, 255, 217])], [Buffer.from([255, 216, 9, 8, 255, 217])]];
  const ambiguous = await file(t, advancedDicom({ syntax: '1.2.840.10008.1.2.4.50', frames: 2, bits: 8, pixelElement: encapsulated(frames, { emptyTable: true }) }));
  await assert.rejects(() => service.frames(ambiguous, [1]), error => error.code === 'frame-index-unavailable' && error.statusCode === 406);
  const invalid = await file(t, advancedDicom({ syntax: '1.2.840.10008.1.2.4.50', frames: 2, bits: 8, pixelElement: encapsulated(frames, { invalidOffset: true }) }));
  await assert.rejects(() => service.frames(invalid, [1]), error => error.code === 'invalid-pixel-data');
  const truncatedFixture = advancedDicom({ syntax: '1.2.840.10008.1.2.4.50', pixelElement: encapsulated([frames[0]]) });
  const truncated = await file(t, { ...truncatedFixture, bytes: truncatedFixture.bytes.subarray(0, -10) });
  await assert.rejects(() => service.read(truncated), error => error.code === 'invalid-metadata');
});

test('large nonpixel metadata becomes a referenced range and bounded/deep metadata cannot exhaust memory', async t => {
  const fixture = advancedDicom({ extra: [{ tag: '77771002', bytes: encodedElement('77771002', 'UT', 'x'.repeat(70000)) }] });
  const record = await file(t, fixture), service = new MetadataService();
  const result = await service.read(record);
  assert.equal(result.metadata['77771002'].Value, undefined);
  assert.equal(result.bulk.get('77771002').length, 70000);
  await assert.rejects(() => new MetadataService({ maxAttributes: 4 }).read(record), error => error.code === 'metadata-too-large');
  await assert.rejects(() => new MetadataService({ maxMetadataBytes: 128 }).read(record), error => error.code === 'metadata-too-large');
  let nested = encodedElement('00081155', 'UI', '1.2.3');
  for (let i = 0; i < 5; i++) nested = sequence('00081140', [nested]);
  const deep = await file(t, advancedDicom({ extra: [{ tag: '00081140', bytes: nested }] }));
  await assert.rejects(() => new MetadataService({ maxDepth: 3 }).read(deep), error => error.code === 'metadata-too-deep');
});

test('metadata cancellation stops file reading and releases a bounded reader slot', async t => {
  const fixture = advancedDicom({ rows: 1024, columns: 1024, frames: 8 });
  const record = await file(t, fixture), service = new MetadataService({ maxConcurrent: 1 });
  const controller = new AbortController();
  const request = service.read(record, { signal: controller.signal });
  controller.abort(new Error('synthetic cancellation'));
  await assert.rejects(request, /synthetic cancellation/);
  assert.equal(service.active, 0);
  assert.equal((await service.read(record)).metadata['00280010'].Value[0], 1024);
});
