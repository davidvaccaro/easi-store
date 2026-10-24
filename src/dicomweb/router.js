import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { ArchiveError, validUid } from '../archive/errors.js';
import { RelatedReader, parseRelatedType } from './multipart.js';

export const dicomwebCapabilities = Object.freeze({
  profile: 'EASI Store 0.1 preview — original Part 10 archive',
  standardReference: 'DICOM PS3.18 2026d',
  basePath: '/dicomweb',
  supported: {
    qido: ['studies', 'series-in-study', 'instances-in-series'],
    stow: ['multipart/related application/dicom Part 10; per-instance durable persistence'],
    wado: ['original instance', 'original series multipart', 'original study multipart'],
    qidoMatching: ['PatientName', 'PatientID', 'StudyInstanceUID', 'StudyDate', 'StudyDescription', 'Modality', 'SeriesInstanceUID', 'SOPInstanceUID'],
    qidoPagination: { limit: 1000, defaultLimit: 100, offset: true },
    unchangedTransferSyntaxOnly: true,
  },
  notYetSupported: ['full-instance metadata', 'frames', 'bulk data', 'rendered resources', 'transcoding', 'JSON/XML metadata STOW', 'fuzzy matching', 'UPS', 'storage commitment', 'nonpatient services'],
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
const keys = { PatientName: ['patientName', '00100010'], PatientID: ['patientId', '00100020'], StudyInstanceUID: ['studyUid', '0020000D'], StudyDate: ['studyDate', '00080020'], StudyDescription: ['studyDescription', '00081030'], Modality: ['modality', '00080060'], SeriesInstanceUID: ['seriesUid', '0020000E'], SOPInstanceUID: ['sopUid', '00080018'] };

function queryOptions(url) {
  const clauses = [], values = [];
  let limit = 100, offset = 0;
  const includes = new Set();
  for (const [key, value] of url.searchParams) {
    if (key === 'limit' || key === 'offset') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || key === 'limit' && (Number(value) < 1 || Number(value) > 1000)) throw new ArchiveError('QIDO limit must be 1–1000; offset must be a nonnegative safe integer.');
      if (key === 'limit') limit = Number(value); else offset = Number(value);
      continue;
    }
    if (key === 'includefield') {
      if (value === 'all') throw new ArchiveError('This preview supports indexed includefield attributes, not all attributes.', 400, 'unsupported-query');
      const entry = Object.entries(keys).find(([keyword, [, id]]) => keyword === value || id === value.toUpperCase());
      if (!entry) throw new ArchiveError('The requested includefield is not indexed by this preview.', 400, 'unsupported-query');
      includes.add(entry[1][1]); continue;
    }
    const match = Object.entries(keys).find(([keyword, [, id]]) => keyword === key || id === key.toUpperCase());
    if (!match) throw new ArchiveError(`Unsupported QIDO matching field: ${key.slice(0, 64)}.`, 400, 'unsupported-query');
    if (!value) continue;
    const column = match[1][0];
    if (column === 'studyDate' && value.includes('-')) {
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

export async function handleDicomweb(req, res, { archive, basePath = '/dicomweb' }) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return false;
  try {
    const route = url.pathname.slice(basePath.length).replace(/\/$/, '');
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      sendJson(res, 200, dicomwebCapabilities, 'application/json'); return true;
    }
    const match = route.match(/^\/studies(?:\/([^/]+)(?:\/series(?:\/([^/]+)(?:\/instances(?:\/([^/]+))?)?)?)?)?$/);
    if (!match) throw new ArchiveError('This DICOMweb resource is outside the preview profile.', 404, 'unsupported-resource');
    const [, studyUid, seriesUid, sopUid] = match;
    for (const uid of [studyUid, seriesUid, sopUid].filter(Boolean)) if (!validUid(uid)) throw new ArchiveError('Invalid DICOM resource UID.');
    if (req.method === 'POST' && !seriesUid && !sopUid && (!studyUid || route === `/studies/${studyUid}`)) { await stow(req, res, archive, studyUid, basePath); return true; }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET, POST, OPTIONS'); throw new ArchiveError('This method is not supported for this DICOMweb resource.', 405, 'method-not-allowed'); }
    if (route === '/studies') qido(req, res, archive, url, { level: 'study' });
    else if (studyUid && route.endsWith('/series')) qido(req, res, archive, url, { level: 'series', studyUid });
    else if (seriesUid && route.endsWith('/instances')) qido(req, res, archive, url, { level: 'instance', studyUid, seriesUid });
    else await retrieve(req, res, archive, { studyUid, seriesUid, sopUid }, basePath);
  } catch (error) { fail(res, error); }
  return true;
}
