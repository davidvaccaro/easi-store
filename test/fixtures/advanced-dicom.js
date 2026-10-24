import { part10Header, uid } from '../../src/synthetic.js';

const longVR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UC', 'UN', 'UR', 'UT', 'SV', 'UV']);
export function encodedElement(tag, vr, value, syntax = '1.2.840.10008.1.2.1') {
  const little = syntax !== '1.2.840.10008.1.2.2', implicit = syntax === '1.2.840.10008.1.2';
  let bytes;
  const numeric = { US: [2, 'writeUInt16'], SS: [2, 'writeInt16'], UL: [4, 'writeUInt32'], SL: [4, 'writeInt32'], FL: [4, 'writeFloat'], FD: [8, 'writeDouble'], SV: [8, 'writeBigInt64'], UV: [8, 'writeBigUInt64'] }[vr];
  if (Buffer.isBuffer(value)) bytes = value;
  else if (numeric) {
    const values = Array.isArray(value) ? value : [value];
    bytes = Buffer.alloc(values.length * numeric[0]);
    values.forEach((item, i) => bytes[`${numeric[1]}${little ? 'LE' : 'BE'}`](item, i * numeric[0]));
  } else bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length % 2) bytes = Buffer.concat([bytes, Buffer.from([['UI', 'OB', 'OW'].includes(vr) ? 0 : 32])]);
  const head = Buffer.alloc(implicit || !longVR.has(vr) ? 8 : 12);
  head[`writeUInt16${little ? 'LE' : 'BE'}`](parseInt(tag.slice(0, 4), 16), 0);
  head[`writeUInt16${little ? 'LE' : 'BE'}`](parseInt(tag.slice(4), 16), 2);
  if (implicit) head.writeUInt32LE(bytes.length, 4);
  else { head.write(vr, 4, 2, 'ascii'); head[`writeUInt${head.length === 12 ? 32 : 16}${little ? 'LE' : 'BE'}`](bytes.length, head.length === 12 ? 8 : 6); }
  return Buffer.concat([head, bytes]);
}
export function item(bytes, syntax = '1.2.840.10008.1.2.1') {
  const head = Buffer.alloc(8), endian = syntax === '1.2.840.10008.1.2.2' ? 'BE' : 'LE';
  head[`writeUInt16${endian}`](0xFFFE, 0); head[`writeUInt16${endian}`](0xE000, 2); head[`writeUInt32${endian}`](bytes.length, 4);
  return Buffer.concat([head, bytes]);
}
export function sequence(tag, items, syntax) { return encodedElement(tag, 'SQ', Buffer.concat(items.map(bytes => item(bytes, syntax))), syntax); }
export function encapsulated(frames, { emptyTable = false, invalidOffset = false } = {}) {
  const head = Buffer.from([0xE0, 0x7F, 0x10, 0, 79, 66, 0, 0, 255, 255, 255, 255]);
  let offset = 0;
  const offsets = Buffer.alloc(emptyTable ? 0 : frames.length * 4);
  frames.forEach((fragments, i) => { if (!emptyTable) offsets.writeUInt32LE(offset + (invalidOffset && i ? 1 : 0), i * 4); for (const fragment of fragments) offset += 8 + fragment.length; });
  return Buffer.concat([head, item(offsets), ...frames.flat().map(fragment => item(fragment)), Buffer.from([0xFE, 0xFF, 0xDD, 0xE0, 0, 0, 0, 0])]);
}
export function advancedDicom({ syntax = '1.2.840.10008.1.2.1', rows = 2, columns = 3, frames = 1, samples = 1, bits = 16, photometric = 'MONOCHROME2', pixels = Buffer.alloc(rows * columns * frames * samples * bits / 8), extra = [], pixelElement, ...ids } = {}) {
  const record = { studyUid: uid(), seriesUid: uid(), sopUid: uid(), sopClassUid: '1.2.840.10008.5.1.4.1.1.2', transferSyntaxUid: syntax, ...ids };
  const entries = [
    ['00080005', 'CS', 'ISO_IR 192'], ['00080016', 'UI', record.sopClassUid], ['00080018', 'UI', record.sopUid],
    ['00080020', 'DA', '20261024'], ['00080050', 'SH', 'SYNTHETIC'], ['00080060', 'CS', 'CT'],
    ['00100010', 'PN', 'Synthetic^Metadata'], ['00100020', 'LO', 'SYNTHETIC-ONLY'], ['00100021', 'LO', 'EASI-TEST'], ['00100030', 'DA', '20000101'],
    ['0020000D', 'UI', record.studyUid], ['0020000E', 'UI', record.seriesUid], ['00200011', 'IS', '1'], ['00200013', 'IS', '1'],
    ['00280002', 'US', samples], ['00280004', 'CS', photometric], ['00280008', 'IS', frames],
    ['00280010', 'US', rows], ['00280011', 'US', columns], ['00280100', 'US', bits], ['00280101', 'US', bits], ['00280102', 'US', bits - 1], ['00280103', 'US', 0],
  ];
  const data = entries.map(([tag, vr, value]) => ({ tag, bytes: encodedElement(tag, vr, value, syntax) }));
  for (const value of extra) data.push(value);
  data.sort((a, b) => a.tag.localeCompare(b.tag));
  return { record, bytes: Buffer.concat([part10Header(record), ...data.map(value => value.bytes), pixelElement ?? encodedElement('7FE00010', bits <= 8 ? 'OB' : 'OW', pixels, syntax)]) };
}
