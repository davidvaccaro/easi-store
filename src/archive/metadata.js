import EASI, { DicomSelection, Tag } from '@xinonix/easi-js';
import { ArchiveError, validUid } from './errors.js';

// Keep this list deliberately small. This is an archive index, never a substitute
// for complete instance metadata. Pixel Data and sequences are not materialized.
const tags = [
  '00020002', '00020003', '00020010', '00080005', '00080016', '00080018',
  '00080020', '00080030', '00080050', '00080060', '00080090', '00081030',
  '0008103E', '00100010', '00100020', '00100021', '00100030', '00100040',
  '0020000D', '0020000E', '00200010', '00200011', '00200013', '00280008',
  '00280010', '00280011',
];

class IndexSelection extends DicomSelection {
  constructor() {
    super();
    for (const id of tags) this.addTag(Tag.find(id));
    // Selection usually stops once complete; archival intake must continue to
    // EOF so malformed trailing data does not earn an acknowledgement.
    this.maximumTag = null;
  }
  isComplete() { return false; }
  hasTag(tag) {
    if (!super.hasTag(tag)) return false;
    return true;
  }
  matchAttribute(context, attribute) {
    if (!this.hasTag(attribute.tag)) return false;
    if (attribute.valueLength > 65536 || context.current.attributes.length >= 64) {
      throw new ArchiveError('An indexed DICOM attribute exceeds the preview indexing limit.');
    }
    return super.matchAttribute(context, attribute);
  }
}

function text(attribute, charset = 'utf-8') {
  if (!attribute) return '';
  return new TextDecoder(charset).decode(attribute.access()).replace(/\0/g, '').trim();
}

export async function extractMetadata(path) {
  const selection = new IndexSelection();
  // Guard selected value length before the parser allocates the value. The
  // extension is the public EASI selection seam and does not fork the parser.
  const pipeline = EASI.pipelineBuilder().fromFileStream().ofDicomData({ includePart10Header: true }).toSelection(selection).build();
  const handler = pipeline.handler;
  const onStartAttribute = handler.onStartAttribute.bind(handler);
  handler.onStartAttribute = (context, attribute) => {
    if (selection.hasTag(attribute.tag) && attribute.valueLength > 65536) {
      throw new ArchiveError('An indexed DICOM attribute exceeds the preview indexing limit.');
    }
    if (selection.hasTag(attribute.tag)) {
      context.indexBytes = (context.indexBytes ?? 0) + attribute.valueLength;
      if (context.indexBytes > 262144) throw new ArchiveError('The indexed metadata exceeds the preview indexing limit.');
    }
    return onStartAttribute(context, attribute);
  };
  let result;
  try { result = await pipeline.process({ source: path }); }
  catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError('The uploaded object is not a supported, structurally readable DICOM instance.');
  }
  const attributes = result.first?.() ?? result.toArray?.()[0];
  if (!attributes?.attributes) throw new ArchiveError('No DICOM instance was found.');
  const get = id => attributes.find(Tag.find(id));
  const charsetId = text(get('00080005')).replace(/\s+/g, '_');
  const encodings = { '': 'utf-8', ISO_IR_6: 'utf-8', ISO_IR_100: 'windows-1252', ISO_IR_192: 'utf-8', ISO_IR_101: 'iso-8859-2', ISO_IR_144: 'iso-8859-5', ISO_IR_127: 'iso-8859-6', ISO_IR_126: 'iso-8859-7', ISO_IR_138: 'iso-8859-8', ISO_IR_148: 'windows-1254', GB18030: 'gb18030', GBK: 'gbk' };
  if (!(charsetId in encodings)) throw new ArchiveError('This preview cannot index the declared DICOM character set. The original was not imported.', 422, 'unsupported-character-set');
  const charset = encodings[charsetId];
  const metadata = {};
  for (const attribute of attributes.attributes) {
    const id = attribute.tag.ID.replace(/[^0-9A-F]/gi, '').toUpperCase();
    const vr = attribute.tag.VR.ID;
    const raw = text(attribute, charset);
    let values;
    if (vr === 'US' || vr === 'UL' || vr === 'SS' || vr === 'SL') values = [attribute.value];
    else if (vr === 'PN') values = raw ? raw.split('\\').map(value => {
      const [Alphabetic, Ideographic, Phonetic] = value.split('=');
      return { ...(Alphabetic ? { Alphabetic } : {}), ...(Ideographic ? { Ideographic } : {}), ...(Phonetic ? { Phonetic } : {}) };
    }) : [];
    else if (vr === 'IS' || vr === 'DS') values = raw ? raw.split('\\').map(Number).filter(Number.isFinite) : [];
    else values = raw ? raw.split('\\') : [];
    metadata[id] = { vr, ...(values.length ? { Value: values } : {}) };
  }
  const value = id => metadata[id]?.Value?.[0] ?? '';
  const studyUid = String(value('0020000D'));
  const seriesUid = String(value('0020000E'));
  const sopUid = String(value('00080018'));
  const sopClassUid = String(value('00080016'));
  const transferSyntaxUid = String(value('00020010'));
  for (const uid of [studyUid, seriesUid, sopUid, sopClassUid, transferSyntaxUid]) {
    if (!validUid(uid)) throw new ArchiveError('Study, series, instance, SOP class, and transfer syntax UIDs must be present and valid. This preview requires a Part 10 file.');
  }
  if (value('00020002') && value('00020002') !== sopClassUid || value('00020003') && value('00020003') !== sopUid) throw new ArchiveError('The DICOM file metadata and dataset identify different instances.');
  return {
    studyUid, seriesUid, sopUid, sopClassUid, transferSyntaxUid,
    modality: String(value('00080060')), patientName: metadata['00100010']?.Value?.[0]?.Alphabetic ?? '',
    patientId: String(value('00100020')), issuer: String(value('00100021')),
    studyDate: String(value('00080020')), studyDescription: String(value('00081030')),
    seriesDescription: String(value('0008103E')), seriesNumber: String(value('00200011')),
    instanceNumber: String(value('00200013')), frames: Math.max(1, Number(value('00280008')) || 1),
    rows: Number(value('00280010')) || 0, columns: Number(value('00280011')) || 0, metadata,
  };
}
