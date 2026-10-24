import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { JpegRgbaEncoder } from '@xinonix/easi-js/codecs';
import { renderThumbnail } from '../src/thumbnails/render.js';
import { ThumbnailService } from '../src/thumbnails/ThumbnailService.js';
import { createStoreServer } from '../src/server.js';
import { metadataService } from '../src/dicomweb/MetadataService.js';
import { advancedDicom, encodedElement } from './fixtures/advanced-dicom.js';

// Independent PNG inspection using Node zlib, not the product's PNG decoder.
function decodePng(input) {
  const bytes = Buffer.from(input);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
  let width, height, offset = 8; const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), kind = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); assert.equal(data[9], 6); }
    if (kind === 'IDAT') idat.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat)), pixels = [];
  assert.equal(raw.length, (width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { assert.equal(raw[y * (width * 4 + 1)], 0); for (let x = 0; x < width; x++) pixels.push([...raw.subarray(y * (width * 4 + 1) + 1 + x * 4, y * (width * 4 + 1) + 5 + x * 4)]); }
  return { width, height, pixels };
}
const attribute = (vr, value) => ({ vr, Value: Array.isArray(value) ? value : [value] });
function metadata({ rows = 1, columns = 2, samples = 1, allocated = 8, stored = allocated, high = stored - 1, signed = 0, photometric = 'MONOCHROME2', ...extra } = {}) {
  return { '00280010': attribute('US', rows), '00280011': attribute('US', columns), '00280002': attribute('US', samples),
    '00280100': attribute('US', allocated), '00280101': attribute('US', stored), '00280102': attribute('US', high), '00280103': attribute('US', signed),
    '00280004': attribute('CS', photometric), ...extra };
}
function signedBytes(values, stored = 16, high = stored - 1) {
  const bytes = Buffer.alloc(values.length * 2), shift = high + 1 - stored;
  values.forEach((value, i) => bytes.writeUInt16LE(((value < 0 ? value + 2 ** stored : value) << shift) | (shift ? 0x8003 : 0), i * 2));
  return bytes;
}
const grayscale = image => image.pixels.map(pixel => { assert.equal(pixel[0], pixel[1]); assert.equal(pixel[1], pixel[2]); assert.equal(pixel[3], 255); return pixel[0]; });

test('thumbnail PNG pixels follow signed stored/high-bit extraction, modality rescale, and DICOM LINEAR VOI', () => {
  const set = metadata({ allocated: 16, stored: 12, high: 14, signed: 1, columns: 4,
    '00281052': attribute('DS', -1024), '00281053': attribute('DS', 1), '00281050': attribute('DS', -1024), '00281051': attribute('DS', 4096) });
  const result = decodePng(renderThumbnail(signedBytes([-2048,-1,0,2047], 12, 14), set, '1.2.840.10008.1.2.1', 1, 4));
  assert.deepEqual([result.width, result.height], [4, 1]); assert.deepEqual(grayscale(result), [0, 127, 128, 255]);
});

test('MONOCHROME1 and Presentation LUT Shape select one inversion without double inversion', () => {
  const bytes = Buffer.from([0,255]);
  for (const [photometric, shape, expected] of [
    ['MONOCHROME2', null, [0,255]], ['MONOCHROME1', null, [255,0]],
    ['MONOCHROME1', 'INVERSE', [255,0]], ['MONOCHROME2', 'INVERSE', [255,0]], ['MONOCHROME1', 'IDENTITY', [0,255]],
  ]) {
    const set = metadata({ photometric, ...(shape ? { '20500020': attribute('CS', shape) } : {}), '00281050': attribute('DS', 128), '00281051': attribute('DS', 256) });
    assert.deepEqual(grayscale(decodePng(renderThumbnail(bytes, set, '1.2.840.10008.1.2.1', 1, 2))), expected, `${photometric}/${shape}`);
  }
});

test('LINEAR_EXACT, SIGMOID, threshold windows and pixel padding have numerical expected results', () => {
  for (const [fn, center, width, values, expected] of [
    ['LINEAR_EXACT', 0, 2, [-1,0,1], [0,128,255]], ['SIGMOID', 0, 4, [-2,0,2], [30,128,225]], ['LINEAR', 0, 1, [-1,0,1], [0,255,255]],
  ]) {
    const set = metadata({ allocated: 16, signed: 1, columns: 3, '00281050': attribute('DS', center), '00281051': attribute('DS', width), '00281056': attribute('CS', fn) });
    assert.deepEqual(grayscale(decodePng(renderThumbnail(signedBytes(values), set, '1.2.840.10008.1.2.1', 1, 3))), expected);
  }
  const padded = metadata({ allocated: 16, signed: 1, columns: 3, photometric: 'MONOCHROME1', '00280120': attribute('SS', -2048) });
  assert.deepEqual(grayscale(decodePng(renderThumbnail(signedBytes([-2048,0,100]), padded, '1.2.840.10008.1.2.1', 1, 3))), [0,255,0]);
});

test('enhanced per-frame display transforms and physical pixel aspect ratios are applied', () => {
  const set = metadata({ allocated: 16, columns: 2,
    '00281050': attribute('DS', 50.5), '00281051': attribute('DS', 101),
    '52009230': { vr: 'SQ', Value: [{}, { '00289145': { vr: 'SQ', Value: [{ '00281052': attribute('DS', 10), '00281053': attribute('DS', 2) }] }, '00289132': { vr: 'SQ', Value: [{ '00281050': attribute('DS', 100), '00281051': attribute('DS', 200) }] } }] },
  });
  const bytes = Buffer.from([0,0,100,0]);
  assert.deepEqual(grayscale(decodePng(renderThumbnail(bytes, set, '1.2.840.10008.1.2.1', 2, 2))), [13,255]);
  const aspect = metadata({ rows: 2, columns: 2, '00280034': attribute('IS', [2,1]) });
  const result = decodePng(renderThumbnail(Buffer.from([0,255,0,255]), aspect, '1.2.840.10008.1.2.1', 1, 4));
  assert.deepEqual([result.width, result.height], [2,4]);
});

test('native RGB interleaved/planar and YBR full/422 thumbnails preserve expected colors', () => {
  const native = '1.2.840.10008.1.2.1';
  for (const [planar, bytes] of [[0, Buffer.from([255,0,0,0,255,0])], [1, Buffer.from([255,0,0,255,0,0])]]) {
    const set = metadata({ samples: 3, photometric: 'RGB', '00280006': attribute('US', planar) });
    assert.deepEqual(decodePng(renderThumbnail(bytes, set, native, 1, 2)).pixels, [[255,0,0,255], [0,255,0,255]]);
  }
  const ybr = metadata({ samples: 3, photometric: 'YBR_FULL' });
  assert.deepEqual(decodePng(renderThumbnail(Buffer.from([76,85,255,200,128,128]), ybr, native, 1, 2)).pixels, [[254,0,0,255], [200,200,200,255]]);
  const subsampled = metadata({ samples: 3, photometric: 'YBR_FULL_422' });
  assert.deepEqual(decodePng(renderThumbnail(Buffer.from([10,200,128,128]), subsampled, native, 1, 2)).pixels, [[10,10,10,255], [200,200,200,255]]);
});

test('baseline JPEG uses EASI codec, validates dimensions and produces a real PNG preview', () => {
  const rgba = new Uint8Array(8 * 8 * 4); for (let i = 0; i < rgba.length; i += 4) rgba.set([200,40,20,255], i);
  const jpeg = new JpegRgbaEncoder().encode(rgba, 8, 8, { quality: 95 }).bytes;
  const set = metadata({ rows: 8, columns: 8, samples: 3, photometric: 'YBR_FULL' });
  const result = decodePng(renderThumbnail(jpeg, set, '1.2.840.10008.1.2.4.50', 1, 8));
  for (const pixel of result.pixels) { assert.ok(Math.abs(pixel[0] - 200) <= 4); assert.ok(Math.abs(pixel[1] - 40) <= 4); assert.ok(Math.abs(pixel[2] - 20) <= 4); assert.equal(pixel[3], 255); }
  assert.throws(() => renderThumbnail(jpeg, { ...set, '00280010': attribute('US', 7) }, '1.2.840.10008.1.2.4.50'), error => error.statusCode === 415);
});

test('unsupported LUTs, malformed windows/layouts and unbounded output sizes fail explicitly', () => {
  const set = metadata(), native = '1.2.840.10008.1.2.1';
  for (const extra of [{ '00281050': attribute('DS', 0), '00281051': attribute('DS', 0) }, { '00283010': { vr: 'SQ', Value: [] } }, { '00280102': attribute('US', 20) }]) {
    assert.throws(() => renderThumbnail(Buffer.from([0,255]), { ...set, ...extra }, native), error => error.statusCode === 415);
  }
  assert.throws(() => renderThumbnail(Buffer.from([0]), set, native), error => error.statusCode === 415);
  assert.throws(() => renderThumbnail(Buffer.from([0,255]), set, native, 1, 100000), error => error.statusCode === 415);
});

test('thumbnail worker cancellation/shutdown releases both worker and pixel reader slots', async t => {
  const directory = await mkdtemp('/private/tmp/easi-thumbnail-worker-'), service = new ThumbnailService();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const input = advancedDicom({ rows: 1024, columns: 1024 }), record = { ...input.record, path: `${directory}/synthetic.dcm` }; await writeFile(record.path, input.bytes);
  const controller = new AbortController(); controller.abort(new Error('synthetic cancellation'));
  await assert.rejects(service.render(record, { signal: controller.signal }), /synthetic cancellation/);
  const pending = service.render(record); const rejected = assert.rejects(pending, /shutting down/); await service.close(); await rejected;
  assert.equal(service.active, 0); assert.equal(service.workers.size, 0); assert.equal(metadataService.activePixelResponses, 0);
  await assert.rejects(service.render(record), /shutting down/);
});

test('authenticated thumbnail HTTP endpoints produce PNGs for original native frames and block unauthenticated access', async t => {
  const dataDir = await mkdtemp('/private/tmp/easi-thumbnail-http-');
  const app = await createStoreServer({ dataDir, port: 0 }); const address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await app.auth.setup({ username: 'synthetic', password: 'synthetic-thumbnail-password' }, '127.0.0.1');
  const token = await app.auth.issueApiToken('Synthetic thumbnail test'), headers = { Authorization: `Bearer ${token}` };
  const input = advancedDicom({ frames: 2, pixels: Buffer.from([0,0,255,0,0,0,255,0,0,0,255,0, 255,0,0,0,255,0,0,0,255,0,0,0]), extra: [{ tag: '00281050', bytes: encodedElement('00281050', 'DS', '128') }, { tag: '00281051', bytes: encodedElement('00281051', 'DS', '256') }] });
  const imported = await fetch(`${base}/api/v1/instances`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/dicom' }, body: input.bytes }); assert.equal(imported.status, 201);
  const series = `${base}/api/v1/studies/${input.record.studyUid}/series/${input.record.seriesUid}`;
  const instance = `${series}/instances/${input.record.sopUid}`;
  assert.equal((await fetch(`${series}/thumbnail`)).status, 401);
  assert.equal((await fetch(`${instance}/thumbnail`)).status, 401);
  for (const resource of [`${series}/thumbnail`, `${instance}/thumbnail?frame=2`]) {
    const response = await fetch(resource, { headers }); assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get('content-type'), 'image/png');
    const png = decodePng(new Uint8Array(await response.arrayBuffer())); assert.ok(png.width > 0 && png.width <= 128); assert.ok(png.height > 0 && png.height <= 128);
    assert.ok(grayscale(png).includes(0)); assert.ok(grayscale(png).includes(255));
  }
  assert.equal((await fetch(`${instance}/thumbnail?frame=0`, { headers })).status, 400);
  assert.equal((await fetch(`${instance}/thumbnail?frame=3`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/dicomweb/studies/${input.record.studyUid}/series/${input.record.seriesUid}/instances/${input.record.sopUid}/metadata`)).status, 401);
});
