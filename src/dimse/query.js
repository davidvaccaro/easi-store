// Bounded Q/R identifiers: searchable archive keys, no pixel/sequence decoding.
import { IMPLICIT, EXPLICIT, text } from './wire.js';
const vrs = {
  '00080005':'CS','00080016':'UI','00080018':'UI','00080020':'DA','00080030':'TM','00080050':'SH','00080052':'CS',
  '00080054':'AE','00080056':'CS','00080058':'UI','00080060':'CS','00080061':'CS','00080090':'PN','00081030':'LO','0008103E':'LO',
  '00100010':'PN','00100020':'LO','00100021':'LO','00100030':'DA','00100040':'CS','0020000D':'UI','0020000E':'UI','00200010':'SH',
  '00200011':'IS','00200013':'IS','00201200':'IS','00201202':'IS','00201204':'IS','00201206':'IS','00201208':'IS','00201209':'IS',
  '00280008':'IS','00280010':'US','00280011':'US',
};
const columns = {'00080016':'sopClassUid','00080018':'sopUid','00080020':'studyDate','00080060':'modality','00081030':'studyDescription',
  '0008103E':'seriesDescription','00100010':'patientName','00100020':'patientId','00100021':'issuer','0020000D':'studyUid','0020000E':'seriesUid',
  '00200011':'seriesNumber','00200013':'instanceNumber'};
const controls = new Set(['00080005','00080052']);
export const queryError = message => Object.assign(new Error(message), { dimseStatus: 0xa900 });
export function parseIdentifier(bytes, syntax) {
  if (![IMPLICIT,EXPLICIT].includes(syntax)) throw queryError('Only Little Endian query identifiers are supported.');
  const raw = new Map(); let offset = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw queryError('Truncated query identifier.');
    const tag = bytes.readUInt16LE(offset).toString(16).padStart(4,'0').toUpperCase() + bytes.readUInt16LE(offset + 2).toString(16).padStart(4,'0').toUpperCase();
    const vr = syntax === IMPLICIT ? vrs[tag] : bytes.toString('ascii',offset + 4,offset + 6);
    const long = ['OB','OD','OF','OL','OV','OW','SQ','UC','UN','UR','UT','SV','UV'].includes(vr);
    const header = syntax === IMPLICIT || !long ? 8 : 12;
    if (offset + header > bytes.length) throw queryError('Truncated query identifier header.');
    const length = syntax === IMPLICIT ? bytes.readUInt32LE(offset + 4) : long ? bytes.readUInt32LE(offset + 8) : bytes.readUInt16LE(offset + 6);
    if (length % 2 || length > 65536 || offset + header + length > bytes.length || raw.has(tag) || tag.startsWith('0000') || tag.startsWith('0002') || vr === 'SQ') throw queryError('Invalid query identifier element.');
    raw.set(tag, bytes.subarray(offset + header,offset + header + length)); offset += header + length;
  }
  const charset = raw.get('00080005')?.toString('ascii').trim() ?? '';
  const encodings = {'':'utf-8','ISO_IR 6':'utf-8','ISO_IR 192':'utf-8','ISO_IR 100':'windows-1252'};
  if (!(charset in encodings)) throw queryError('Unsupported query identifier character set.');
  let decoder; try { decoder = new TextDecoder(encodings[charset],{ fatal: true }); } catch { throw queryError('Invalid query character set.'); }
  const result = new Map();
  try { for (const [tag,bytes] of raw) {
    if (vrs[tag] === 'US' && bytes.length) { if (bytes.length !== 2) throw queryError('Invalid numeric query value.'); result.set(tag,String(bytes.readUInt16LE())); }
    else result.set(tag, decoder.decode(bytes).replace(/[\0 ]+$/g,''));
  } }
  catch { throw queryError('Invalid query text encoding.'); }
  return result;
}
export function encodeIdentifier(values, syntax = EXPLICIT) {
  const parts = [];
  for (const tag of Object.keys(values).sort()) {
    const vr = vrs[tag] ?? 'LO', value = values[tag]; let bytes;
    if (vr === 'US' && value !== '') { bytes = Buffer.alloc(2); bytes.writeUInt16LE(Number(value)); }
    else bytes = text(Array.isArray(value) ? value.join('\\') : String(value ?? ''), vr === 'UI' ? 0 : 32);
    if (bytes.length > 65534) throw queryError('Query response attribute exceeds limit.');
    const h = Buffer.alloc(8); h.writeUInt16LE(parseInt(tag.slice(0,4),16)); h.writeUInt16LE(parseInt(tag.slice(4),16),2);
    if (syntax === IMPLICIT) h.writeUInt32LE(bytes.length,4); else { h.write(vr,4,2,'ascii'); h.writeUInt16LE(bytes.length,6); }
    parts.push(h,bytes);
  }
  return Buffer.concat(parts);
}
function scalar(record,tag) {
  if (columns[tag]) return record[columns[tag]] ?? '';
  const values = record.metadata?.[tag]?.Value ?? [];
  return values.map(value => typeof value === 'object' ? value.Alphabetic ?? value.Ideographic ?? value.Phonetic ?? '' : value).join('\\');
}
function escapedLike(value) {
  return value.replace(/[\\%_]/g,'\\$&').replaceAll('*','%').replaceAll('?','_');
}
export function queryPlan(identifier, model, retrieve = false) {
  const level = identifier.get('00080052');
  if (!['PATIENT','STUDY','SERIES','IMAGE'].includes(level) || level === 'PATIENT' && model !== 'patient-root') throw queryError('Invalid Query/Retrieve Level.');
  if (retrieve) {
    const uniqueKeys = new Set(['00080005','00080052','00100020','0020000D','0020000E','00080018']);
    if ([...identifier.keys()].some(tag => !uniqueKeys.has(tag))) throw queryError('Retrieval identifiers must contain unique hierarchy keys only.');
    if (identifier.get('00100020')?.includes('\\')) throw queryError('Patient ID retrieval requires a single value.');
    const required = level === 'PATIENT' ? ['00100020'] : level === 'STUDY' ? ['0020000D'] : level === 'SERIES' ? ['0020000D','0020000E'] : ['0020000D','0020000E','00080018'];
    for (const tag of required) if (!identifier.get(tag) || /[*?]/.test(identifier.get(tag))) throw queryError('Retrieval requires unique keys for its hierarchy.');
  }
  const clauses = [], params = [];
  let optionalKeysUnsupported = false;
  for (const [tag,value] of identifier) {
    if (!vrs[tag]) optionalKeysUnsupported = true;
    if (controls.has(tag) || !value) continue;
    if (!vrs[tag] || ['00080054','00080056','00080058','00201200','00201202','00201204','00201206','00201208','00201209'].includes(tag)) { optionalKeysUnsupported = true; continue; }
    let expression = columns[tag] ? `i.${columns[tag]}` : `CAST(json_extract(i.metadata,'$."${tag}".Value[0]') AS TEXT)`;
    if (tag === '00080061') expression = 'm.modality';
    const match = [], subParams = [];
    for (const one of value.split('\\')) {
      if (vrs[tag] === 'DA' && one.includes('-')) {
        const range = /^(\d{0,8})-(\d{0,8})$/.exec(one); if (!range || !range[1] && !range[2]) throw queryError('Invalid date range.');
        const rangeClauses = []; if (range[1]) { rangeClauses.push(`${expression}>=?`); subParams.push(range[1]); } if (range[2]) { rangeClauses.push(`${expression}<=?`); subParams.push(range[2]); }
        match.push(`(${rangeClauses.join(' AND ')})`);
      } else if (vrs[tag] !== 'UI' && /[*?]/.test(one)) { match.push(`${expression} LIKE ? ESCAPE '\\'`); subParams.push(escapedLike(one)); }
      else { match.push(`${expression} = ? COLLATE ${vrs[tag] === 'UI' || tag === '00100020' || tag === '00100021' ? 'BINARY' : 'NOCASE'}`); subParams.push(one); }
    }
    const joined = `(${match.join(' OR ')})`;
    clauses.push(tag === '00080061' ? `EXISTS(SELECT 1 FROM instances m WHERE m.studyUid=i.studyUid AND ${joined})` : joined); params.push(...subParams);
  }
  return { level, optionalKeysUnsupported, where: clauses.length ? clauses.join(' AND ') : '1=1', params, column: {PATIENT:'patientKey',STUDY:'studyUid',SERIES:'seriesUid',IMAGE:'sopUid'}[level] };
}
export function matchingInstances(archive, plan, maximum = 10000) {
  if (plan.level === 'PATIENT' && archive.db.prepare(`SELECT COUNT(DISTINCT patientKey) AS count FROM instances i WHERE ${plan.where}`).get(...plan.params).count > 1) throw queryError('Patient retrieval is ambiguous; retrieve specific study UIDs.');
  const rows = archive.db.prepare(`SELECT studyUid,seriesUid,sopUid,sopClassUid,transferSyntaxUid,objectKey FROM instances i WHERE ${plan.where} ORDER BY studyUid,CAST(seriesNumber AS INTEGER),seriesUid,CAST(instanceNumber AS INTEGER),sopUid LIMIT ?`).all(...plan.params,maximum + 1);
  if (rows.length > maximum) throw Object.assign(new Error('The retrieve exceeds the configured instance limit.'),{dimseStatus:0xa701});
  return rows.map(row => ({...row,path:archive.dataDir + '/objects/' + row.objectKey}));
}
export function matchingGroups(archive, plan, maximum = 10000) {
  const rows = archive.db.prepare(`SELECT ${plan.column} AS identity FROM instances i WHERE ${plan.where} GROUP BY ${plan.column} ORDER BY ${plan.column} LIMIT ?`).all(...plan.params,maximum + 1);
  if (rows.length > maximum) throw Object.assign(new Error('The query exceeds the configured result limit.'),{dimseStatus:0xa700});
  return rows;
}
export function responseIdentifier(archive, plan, identity, identifier, aeTitle) {
  const row = archive.db.prepare(`SELECT * FROM instances WHERE ${plan.column}=? ORDER BY sopUid LIMIT 1`).get(identity);
  const record = archive.publicRecord(row), values = {'00080005':'ISO_IR 192','00080052':plan.level,'00080054':aeTitle,'00080056':'ONLINE'};
  for (const tag of identifier.keys()) if (!controls.has(tag) && vrs[tag]) values[tag] = scalar(record,tag);
  const totals = archive.db.prepare(`SELECT COUNT(DISTINCT studyUid) AS studies,COUNT(DISTINCT seriesUid) AS series,COUNT(*) AS instances,GROUP_CONCAT(DISTINCT modality) AS modalities FROM instances WHERE ${plan.column}=?`).get(identity);
  const aggregate = plan.level === 'PATIENT' ? {'00201200':totals.studies,'00201202':totals.series,'00201204':totals.instances}
    : plan.level === 'STUDY' ? {'00080061':totals.modalities?.split(',') ?? [],'00201206':totals.series,'00201208':totals.instances}
    : plan.level === 'SERIES' ? {'00201209':totals.instances} : {};
  for (const [tag,value] of Object.entries(aggregate)) if (identifier.has(tag)) values[tag] = value;
  return values;
}
