import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { ArchiveError, validUid } from '../archive/errors.js';
import { RelatedReader, parseRelatedType } from './multipart.js';
import { metadataService as defaultMetadataService } from './MetadataService.js';

export const dicomwebCapabilities = Object.freeze({
  profile: 'EASI Store phase 2 preview — indexed search and streaming metadata/pixel retrieval',
  standardReference: 'DICOM PS3.18 2026d',
  basePath: '/dicomweb',
  supported: {
    qido: ['studies', 'series-in-study', 'instances-in-series'],
    stow: ['multipart/related application/dicom Part 10; per-instance durable persistence'],
    wado: ['original instance', 'original series multipart', 'original study multipart', 'study/series/instance JSON metadata', 'native little-endian frames (including conversion from native implicit and big-endian)', 'original compressed frames with Basic Offset Table or unambiguous fragment boundaries', 'protected referenced bulk values'],
    qidoMatching: ['PatientName', 'PatientID', 'IssuerOfPatientID', 'PatientBirthDate', 'AccessionNumber', 'StudyInstanceUID', 'StudyDate', 'StudyDescription', 'Modality', 'ModalitiesInStudy', 'SeriesInstanceUID', 'SOPInstanceUID', 'SeriesDescription', 'SeriesNumber', 'InstanceNumber'],
    qidoPagination: { limit: 1000, defaultLimit: 100, offset: true },
    unchangedTransferSyntaxOnly: true,
  },
  notYetSupported: ['XML metadata', 'rendered resources', 'whole-instance transcoding', 'compressed pixel decoding/transcoding', 'empty offset tables with ambiguous multi-fragment frames', 'JSON/XML metadata STOW', 'fuzzy matching', 'UPS', 'storage commitment', 'nonpatient services'],
  conformance: 'A limited preview profile; not a claim of complete DICOMweb conformance.',
});

function sendJson(res, status, body, type = 'application/dicom+json') {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
}
function fail(res, error) {
  if (res.headersSent) { res.destroy(error); return; }
  sendJson(res, error.statusCode ?? 500, { error: error.statusCode ? error.message : 'The archive could not complete this request.', code: error.code ?? 'server-error' }, 'application/json');
}
function acceptJson(req) {
  const accept = req.headers.accept ?? '*/*';
  if (!accept.split(',').some(item => /^\s*(application\/dicom\+json|application\/json|\*\/\*)(?:\s*;|\s*$)/i.test(item) && !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(item))) throw new ArchiveError('This QIDO profile returns application/dicom+json.', 406, 'not-acceptable');
}
function attribute(vr, value) { return { vr, ...(value === '' || value == null ? {} : { Value: Array.isArray(value) ? value : [value] }) }; }
function selectedMetadata(record, ids) {
  const result = {};
  for (const id of ids) if (record.metadata[id]) result[id] = record.metadata[id];
  return result;
}
const studyIds = ['00080005', '00080020', '00080030', '00080050', '00080090', '00081030', '00100010', '00100020', '00100021', '00100030', '00100040', '0020000D', '00200010'];
const seriesIds = [...studyIds, '00080060', '0008103E', '0020000E', '00200011'];
const instanceIds = [...seriesIds, '00080016', '00080018', '00200013', '00280008', '00280010', '00280011'];
const keys = { PatientName: ['patientName', '00100010'], PatientID: ['patientId', '00100020'], IssuerOfPatientID: ['issuer', '00100021'], PatientBirthDate: ['birthDate', '00100030'], AccessionNumber: ['accessionNumber', '00080050'], StudyInstanceUID: ['studyUid', '0020000D'], StudyDate: ['studyDate', '00080020'], StudyDescription: ['studyDescription', '00081030'], Modality: ['modality', '00080060'], ModalitiesInStudy: ['modalitiesInStudy', '00080061'], SeriesInstanceUID: ['seriesUid', '0020000E'], SOPInstanceUID: ['sopUid', '00080018'], SeriesDescription: ['seriesDescription', '0008103E'], SeriesNumber: ['seriesNumber', '00200011'], InstanceNumber: ['instanceNumber', '00200013'] };
const returnKeys = { ...Object.fromEntries([...studyIds, ...seriesIds, ...instanceIds, '00080061', '00201206', '00201208', '00201209'].map(id => [id, id])), ...Object.fromEntries(Object.entries(keys).map(([keyword, [, id]]) => [keyword, id])), StudyTime: '00080030', ReferringPhysicianName: '00080090', PatientSex: '00100040', StudyID: '00200010', NumberOfStudyRelatedSeries: '00201206', NumberOfStudyRelatedInstances: '00201208', NumberOfSeriesRelatedInstances: '00201209', SOPClassUID: '00080016', NumberOfFrames: '00280008', Rows: '00280010', Columns: '00280011', SpecificCharacterSet: '00080005' };

function queryOptions(url) {
  const clauses = [], values = [];
  let limit = 100, offset = 0;
  const includes = new Set();
  for (const [key, value] of url.searchParams) {
    if (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new ArchiveError('QIDO parameters must be short printable text.');
    if (key === 'fuzzymatching' && value === 'false') continue;
    if (key === 'limit' || key === 'offset') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || key === 'limit' && (Number(value) < 1 || Number(value) > 1000)) throw new ArchiveError('QIDO limit must be 1–1000; offset must be a nonnegative safe integer.');
      if (key === 'limit') limit = Number(value); else offset = Number(value);
      continue;
    }
    if (key === 'includefield') {
      for (const field of value.split(',')) {
        if (field === 'all') throw new ArchiveError('This profile returns indexed includefield values; use Retrieve Metadata for complete metadata.', 400, 'unsupported-query');
        const id = returnKeys[field] ?? returnKeys[field.toUpperCase()];
        if (!id) throw new ArchiveError('The requested includefield is not indexed by this profile.', 400, 'unsupported-query');
        includes.add(id);
      }
      continue;
    }
    const match = Object.entries(keys).find(([keyword, [, id]]) => keyword === key || id === key.toUpperCase());
    if (!match) throw new ArchiveError(`Unsupported QIDO matching field: ${key.slice(0, 64)}.`, 400, 'unsupported-query');
    if (!value) continue;
    const name = match[1][0];
    const column = name === 'birthDate' ? `COALESCE(json_extract(metadata,'$."00100030".Value[0]'),'')` : name === 'accessionNumber' ? `COALESCE(json_extract(metadata,'$."00080050".Value[0]'),'')` : name;
    if (name === 'modalitiesInStudy') {
      const modalities = value.split('\\');
      if (modalities.length > 100 || modalities.some(item => !/^[A-Z0-9_ ]{1,16}$/.test(item))) throw new ArchiveError('Invalid ModalitiesInStudy matching value.');
      clauses.push(`studyUid IN (SELECT studyUid FROM instances WHERE modality IN (${modalities.map(() => '?').join(',')}))`); values.push(...modalities);
    } else if ((name === 'studyDate' || name === 'birthDate') && value.includes('-')) {
      const [start, end, extra] = value.split('-');
      if (extra !== undefined || start && !/^\d{8}$/.test(start) || end && !/^\d{8}$/.test(end)) throw new ArchiveError('Invalid StudyDate range.');
      if (start) { clauses.push(`${column}>=?`); values.push(start); }
      if (end) { clauses.push(`${column}<=?`); values.push(end); }
    } else if (['studyUid', 'seriesUid', 'sopUid'].includes(column)) {
      const uids = value.split('\\');
      if (uids.length > 100 || !uids.every(validUid)) throw new ArchiveError('Invalid UID matching value.');
      clauses.push(`${column} IN (${uids.map(() => '?').join(',')})`); values.push(...uids);
    } else {
      clauses.push(`${column} LIKE ? ESCAPE '\\'`);
      values.push(value.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%').replace(/\?/g, '_'));
    }
  }
  return { clauses, values, limit, offset, includes };
}

function qido(req, res, archive, url, scope) {
  acceptJson(req);
  const options = queryOptions(url);
  if (scope.studyUid) { options.clauses.push('studyUid=?'); options.values.push(scope.studyUid); }
  if (scope.seriesUid) { options.clauses.push('seriesUid=?'); options.values.push(scope.seriesUid); }
  const matching = archive.queryGroups(options.clauses.join(' AND '), options.values, { ...options, level: scope.level });
  const items = matching.groups.map(group => {
    const { record } = group;
    const ids = scope.level === 'study' ? studyIds : scope.level === 'series' ? seriesIds : instanceIds;
    const result = selectedMetadata(record, new Set([...ids, ...options.includes]));
    if (scope.level === 'study') {
      result['00080061'] = attribute('CS', group.modalities);
      result['00201206'] = attribute('IS', group.seriesCount);
      result['00201208'] = attribute('IS', group.instanceCount);
    } else if (scope.level === 'series') result['00201209'] = attribute('IS', group.instanceCount);
    return result;
  });
  if (matching.hasMore) res.setHeader('Warning', '299 EASIStore "Additional results available; use offset and limit"');
  sendJson(res, 200, items);
}

function scopedRecords(archive, scope) {
  const clauses = ['studyUid=?'], values = [scope.studyUid];
  if (scope.seriesUid) { clauses.push('seriesUid=?'); values.push(scope.seriesUid); }
  if (scope.sopUid) { clauses.push('sopUid=?'); values.push(scope.sopUid); }
  const records = archive.originalRecords(clauses.join(' AND '), values);
  if (!records.length) throw new ArchiveError('The requested DICOM resource was not found.', 404, 'not-found');
  return records;
}

function cancellation(req, res) {
  const controller = new AbortController();
  const close = () => { if (!res.writableFinished) controller.abort(new Error('Client disconnected.')); };
  req.once('aborted', close); res.once('close', close);
  return { signal: controller.signal, dispose: () => { req.removeListener('aborted', close); res.removeListener('close', close); } };
}

async function retrieveMetadata(req, res, archive, service, scope, basePath) {
  acceptJson(req);
  const records = scopedRecords(archive, scope);
  if (records.length > 10000) throw new ArchiveError('This metadata request contains too many instances; request individual series or instances.', 413, 'metadata-too-large');
  const release = service.acquireMetadataResponse();
  const lifecycle = cancellation(req, res), values = [];
  let bytes = 2;
  try {
    for (const record of records) {
      const result = await service.read(record, { basePath, signal: lifecycle.signal });
      bytes += Buffer.byteLength(JSON.stringify(result.metadata)) + 1;
      if (bytes > service.maxMetadataBytes) throw new ArchiveError('The metadata response exceeds 8 MiB; request smaller series or individual instances.', 413, 'metadata-too-large');
      values.push(result.metadata);
    }
    lifecycle.signal.throwIfAborted();
    const completion = finished(res, { cleanup: true });
    sendJson(res, 200, values);
    await completion;
  } finally { lifecycle.dispose(); release(); }
}

const mediaDefaultSyntax = { 'application/octet-stream': '1.2.840.10008.1.2.1', 'image/jpeg': '1.2.840.10008.1.2.4.70', 'image/dicom-rle': '1.2.840.10008.1.2.5', 'image/jls': '1.2.840.10008.1.2.4.80', 'image/jp2': '1.2.840.10008.1.2.4.90', 'image/jpx': '1.2.840.10008.1.2.4.92', 'image/jphc': '1.2.840.10008.1.2.4.201' };
function pixelAccept(req, mediaType, syntax) {
  const accepted = (req.headers.accept ?? '*/*').split(',').some(item => {
    if (/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(item)) return false;
    if (/^\s*\*\/\*\s*(?:;|$)/.test(item)) return mediaType === 'application/octet-stream';
    if (!/^\s*multipart\/related\s*(?:;|$)/i.test(item)) return false;
    const type = item.match(/;\s*type\s*=\s*"?([^";\s]+)/i)?.[1]?.toLowerCase() ?? 'application/octet-stream';
    const requestedSyntax = item.match(/;\s*transfer-syntax\s*=\s*"?([^";\s]+)/i)?.[1] ?? mediaDefaultSyntax[type];
    return type === mediaType && (requestedSyntax === '*' || requestedSyntax === syntax);
  });
  if (!accepted) throw new ArchiveError('This pixel/bulk representation is unavailable in the requested media type or transfer syntax. Native output is little-endian; compressed output preserves its original encoding.', 406, 'not-acceptable');
}
function multipartStart(res, mediaType) {
  const boundary = `easi-${randomUUID()}`;
  res.writeHead(200, { 'Content-Type': `multipart/related; type="${mediaType}"; boundary="${boundary}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  return boundary;
}
async function multipartHeader(res, boundary, type, syntax, location) {
  await write(res, Buffer.from(`--${boundary}\r\nContent-Type: ${type}; transfer-syntax=${syntax}\r\nContent-Location: ${location}\r\n\r\n`));
}

async function writeFrames(req, res, service, record, frames, signal, location) {
  const { mediaType, transferSyntaxUid } = frames[0];
  pixelAccept(req, mediaType, transferSyntaxUid);
  const boundary = multipartStart(res, mediaType);
  if (mediaType !== 'application/octet-stream') {
    for (const frame of frames) {
      await multipartHeader(res, boundary, mediaType, transferSyntaxUid, `${location}/frames/${frame.frame}`);
      for await (const chunk of service.frameChunks(record, frame, { signal })) await write(res, chunk);
      await write(res, Buffer.from('\r\n'));
    }
  } else {
    // Uncompressed multi-frame bulk is one octet stream. For 1-bit images the
    // selected frames are packed successively without inter-frame padding.
    await multipartHeader(res, boundary, mediaType, transferSyntaxUid, `${location}/frames/${frames.map(frame => frame.frame).join(',')}`);
    let carry = 0, carryBits = 0, output = Buffer.alloc(65536), used = 0;
    for (const frame of frames) {
      let remainingBits = frame.frameBits;
      for await (const chunk of service.frameChunks(record, frame, { signal })) {
        if (frame.frameBits % 8 === 0 && !carryBits) { await write(res, chunk); remainingBits -= chunk.length * 8; continue; }
        for (const byte of chunk) {
          const count = Math.min(8, remainingBits);
          if (count <= 0) break;
          carry |= (byte & (count === 8 ? 255 : (1 << count) - 1)) << carryBits;
          carryBits += count; remainingBits -= count;
          if (carryBits >= 8) {
            output[used++] = carry & 255; carry >>>= 8; carryBits -= 8;
            if (used === output.length) { await write(res, output); output = Buffer.alloc(65536); used = 0; }
          }
        }
      }
    }
    if (carryBits) output[used++] = carry;
    if (used) await write(res, output.subarray(0, used));
    await write(res, Buffer.from('\r\n'));
  }
  res.end(`--${boundary}--\r\n`);
}

async function retrieveFrames(req, res, archive, service, scope, requested, basePath) {
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(requested) || requested.length > 10000) throw new ArchiveError('Frames must be a comma-separated list of positive 1-based numbers.', 400, 'invalid-frame');
  const frames = requested.split(',').map(Number);
  if (new Set(frames).size !== frames.length) throw new ArchiveError('A frame may be requested only once.', 400, 'invalid-frame');
  const record = archive.getInstance(scope.studyUid, scope.seriesUid, scope.sopUid);
  if (!record) throw new ArchiveError('The requested instance was not found.', 404, 'not-found');
  const release = service.acquirePixelResponse();
  const lifecycle = cancellation(req, res);
  try {
    const descriptors = await service.frames(record, frames, { basePath, signal: lifecycle.signal });
    await writeFrames(req, res, service, record, descriptors, lifecycle.signal, `${basePath}/studies/${scope.studyUid}/series/${scope.seriesUid}/instances/${scope.sopUid}`);
  } finally { lifecycle.dispose(); release(); }
}

async function retrieveBulk(req, res, archive, service, scope, path, basePath) {
  if (!/^[0-9A-F]{8}(?:\/[1-9]\d*\/[0-9A-F]{8})*$/.test(path) || path.length > 2048) throw new ArchiveError('Invalid bulk data attribute path.', 400, 'invalid-bulk-path');
  const record = archive.getInstance(scope.studyUid, scope.seriesUid, scope.sopUid);
  if (!record) throw new ArchiveError('The requested instance was not found.', 404, 'not-found');
  const release = service.acquirePixelResponse();
  const lifecycle = cancellation(req, res);
  try {
    const result = await service.read(record, { basePath, signal: lifecycle.signal });
    const bulk = result.bulk.get(path);
    if (!bulk) throw new ArchiveError('This metadata attribute has no referenced bulk value.', 404, 'not-found');
    if (bulk.undefinedLength) {
      if (path !== '7FE00010') throw new ArchiveError('This undefined-length bulk representation is outside the current profile.', 406, 'unsupported-bulk');
      const count = Number(result.metadata['00280008']?.Value?.[0] ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 1000) throw new ArchiveError('Retrieve at most 1000 explicit frames per request for this image.', 413, 'too-many-frames');
      const frames = await service.frames(record, Array.from({ length: count }, (_, i) => i + 1), { basePath, signal: lifecycle.signal });
      await writeFrames(req, res, service, record, frames, lifecycle.signal, `${basePath}/studies/${scope.studyUid}/series/${scope.seriesUid}/instances/${scope.sopUid}`);
      return;
    }
    pixelAccept(req, 'application/octet-stream', '1.2.840.10008.1.2.1');
    const wordBytes = bulk.littleEndian ? 1 : ({ OW: 2, OF: 4, OL: 4, OD: 8, OV: 8 }[bulk.vr] ?? 1);
    if (bulk.length % wordBytes) throw new ArchiveError('The bulk value has an invalid numeric word length.', 422, 'invalid-bulk');
    const boundary = multipartStart(res, 'application/octet-stream');
    await multipartHeader(res, boundary, 'application/octet-stream', '1.2.840.10008.1.2.1', `${basePath}/studies/${scope.studyUid}/series/${scope.seriesUid}/instances/${scope.sopUid}/bulkdata/${path}`);
    if (bulk.length) {
      const stream = createReadStream(record.path, { start: bulk.offset, end: bulk.offset + bulk.length - 1, highWaterMark: 65536, signal: lifecycle.signal });
      let tail = Buffer.alloc(0);
      try {
        for await (const chunk of stream) {
          const bytes = tail.length ? Buffer.concat([tail, chunk]) : chunk;
          const end = bytes.length - bytes.length % wordBytes;
          const ready = bytes.subarray(0, end); tail = bytes.subarray(end);
          if (wordBytes === 2) ready.swap16(); else if (wordBytes === 4) ready.swap32(); else if (wordBytes === 8) ready.swap64();
          if (ready.length) await write(res, ready);
        }
      } finally { stream.destroy(); }
    }
    await write(res, Buffer.from('\r\n')); res.end(`--${boundary}--\r\n`);
  } finally { lifecycle.dispose(); release(); }
}

function retrievalSyntax(req, records) {
  const accept = req.headers.accept ?? '*/*';
  const supported = accept.split(',').some(item => {
    if (/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(item)) return false;
    if (/^\s*\*\/\*\s*(?:;|$)/.test(item)) return records.every(record => record.transferSyntaxUid === '1.2.840.10008.1.2.1');
    if (!/^\s*multipart\/related\s*(?:;|$)/i.test(item)) return false;
    const type = item.match(/;\s*type\s*=\s*"?([^";\s]+)/i)?.[1];
    if (type && type.toLowerCase() !== 'application/dicom') return false;
    const syntax = item.match(/;\s*transfer-syntax\s*=\s*"?([^";\s]+)/i)?.[1] ?? '1.2.840.10008.1.2.1';
    return syntax === '*' || records.every(record => record.transferSyntaxUid === syntax);
  });
  if (!supported) throw new ArchiveError('This preview retrieves original multipart DICOM only. Request transfer-syntax=* or the stored transfer syntax; transcoding is not available.', 406, 'not-acceptable');
  return true;
}
async function write(res, bytes) {
  if (res.destroyed) throw new Error('Client disconnected.');
  if (!res.write(bytes)) await new Promise((resolve, reject) => {
    const cleanup = () => { res.removeListener('drain', drained); res.removeListener('close', closed); res.removeListener('error', errored); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('Client disconnected.')); };
    const errored = error => { cleanup(); reject(error); };
    res.once('drain', drained); res.once('close', closed); res.once('error', errored);
    if (res.destroyed) closed();
  });
}
async function retrieve(req, res, archive, scope, basePath) {
  const clauses = ['studyUid=?'], values = [scope.studyUid];
  if (scope.seriesUid) { clauses.push('seriesUid=?'); values.push(scope.seriesUid); }
  if (scope.sopUid) { clauses.push('sopUid=?'); values.push(scope.sopUid); }
  const records = archive.originalRecords(clauses.join(' AND '), values);
  if (!records.length) throw new ArchiveError('The requested DICOM resource was not found.', 404, 'not-found');
  retrievalSyntax(req, records);
  const boundary = `easi-${randomUUID()}`;
  res.writeHead(200, { 'Content-Type': `multipart/related; type="application/dicom"; boundary="${boundary}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  for (const record of records) {
    await write(res, Buffer.from(`--${boundary}\r\nContent-Type: application/dicom; transfer-syntax=${record.transferSyntaxUid}\r\nContent-Location: ${basePath}/studies/${record.studyUid}/series/${record.seriesUid}/instances/${record.sopUid}\r\n\r\n`));
    const stream = createReadStream(record.path);
    const abort = () => stream.destroy();
    res.once('close', abort);
    try { for await (const chunk of stream) await write(res, chunk); }
    finally { res.removeListener('close', abort); stream.destroy(); }
    await write(res, Buffer.from('\r\n'));
  }
  res.end(`--${boundary}--\r\n`);
}

async function stow(req, res, archive, expectedStudyUid, basePath) {
  acceptJson(req);
  const boundary = parseRelatedType(req.headers['content-type']);
  const successful = [], failed = [], failureStatuses = [];
  for await (const { headers, body } of new RelatedReader(req, boundary).parts()) {
    try {
      if (!/^application\/dicom(?:\s*;|\s*$)/i.test(headers['content-type'] ?? '')) throw new ArchiveError('Each STOW part must have Content-Type: application/dicom.', 415);
      const outcome = await archive.ingest(body, { source: 'dicomweb-stow', expectedStudyUid });
      const record = outcome.instance;
      successful.push({
        '00081150': attribute('UI', record.sopClassUid), '00081155': attribute('UI', record.sopUid),
        '00081190': attribute('UR', `${basePath}/studies/${record.studyUid}/series/${record.seriesUid}/instances/${record.sopUid}`),
      });
    } catch (error) {
      if (!error.statusCode) throw error;
      failed.push({
        '00081150': attribute('UI', error.sopClassUid), '00081155': attribute('UI', error.sopUid),
        '00081197': attribute('US', error.code === 'uid-conflict' ? 0x0111 : error.statusCode === 409 ? 0xA900 : 0xC000),
        '00000902': attribute('LO', error.code ?? 'invalid-dicom'),
      });
      failureStatuses.push(error.statusCode);
      // Fully drain this body before advancing to its sibling.
      for await (const _chunk of body) {}
    }
  }
  if (!successful.length && !failed.length) throw new ArchiveError('The STOW request contains no DICOM instances.');
  const result = { '00081199': { vr: 'SQ', Value: successful }, ...(failed.length ? { '00081198': { vr: 'SQ', Value: failed } } : {}) };
  sendJson(res, failed.length ? successful.length ? 202 : failureStatuses.every(status => status === 400) ? 400 : 409 : 200, result);
}

export async function handleDicomweb(req, res, { archive, basePath = '/dicomweb', publicBasePath = basePath, metadataService = defaultMetadataService }) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return false;
  try {
    const route = url.pathname.slice(basePath.length).replace(/\/$/, '');
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      sendJson(res, 200, dicomwebCapabilities, 'application/json'); return true;
    }
    const resource = route.match(/^\/studies\/([^/]+)(?:\/series\/([^/]+)(?:\/instances\/([^/]+))?)?\/(metadata|frames\/([^/]+)|bulkdata\/(.+))$/);
    if (resource) {
      const [, studyUid, seriesUid, sopUid, suffix, frameList, bulkPath] = resource;
      for (const uid of [studyUid, seriesUid, sopUid].filter(Boolean)) if (!validUid(uid)) throw new ArchiveError('Invalid DICOM resource UID.');
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); throw new ArchiveError('This resource supports retrieval only.', 405, 'method-not-allowed'); }
      const scope = { studyUid, seriesUid, sopUid };
      if (suffix === 'metadata') await retrieveMetadata(req, res, archive, metadataService, scope, publicBasePath);
      else if (!sopUid) throw new ArchiveError('Frame and referenced bulk requests must identify an instance.', 404, 'unsupported-resource');
      else if (frameList) await retrieveFrames(req, res, archive, metadataService, scope, frameList, publicBasePath);
      else await retrieveBulk(req, res, archive, metadataService, scope, bulkPath, publicBasePath);
      return true;
    }
    const match = route.match(/^\/studies(?:\/([^/]+)(?:\/series(?:\/([^/]+)(?:\/instances(?:\/([^/]+))?)?)?)?)?$/);
    if (!match) throw new ArchiveError('This DICOMweb resource is outside the preview profile.', 404, 'unsupported-resource');
    const [, studyUid, seriesUid, sopUid] = match;
    for (const uid of [studyUid, seriesUid, sopUid].filter(Boolean)) if (!validUid(uid)) throw new ArchiveError('Invalid DICOM resource UID.');
    if (req.method === 'POST' && !seriesUid && !sopUid && (!studyUid || route === `/studies/${studyUid}`)) { await stow(req, res, archive, studyUid, publicBasePath); return true; }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET, POST, OPTIONS'); throw new ArchiveError('This method is not supported for this DICOMweb resource.', 405, 'method-not-allowed'); }
    if (route === '/studies') qido(req, res, archive, url, { level: 'study' });
    else if (studyUid && route.endsWith('/series')) qido(req, res, archive, url, { level: 'series', studyUid });
    else if (seriesUid && route.endsWith('/instances')) qido(req, res, archive, url, { level: 'instance', studyUid, seriesUid });
    else await retrieve(req, res, archive, { studyUid, seriesUid, sopUid }, publicBasePath);
  } catch (error) { fail(res, error); }
  return true;
}
