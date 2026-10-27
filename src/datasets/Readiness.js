// Technical inventory of the indexed metadata only. No pixel or clinical QA.
const STORAGE = '1.2.840.10008.5.1.4.1.1.';
const imageClasses = new Set([
  '1','1.1','1.1.1','1.2','1.2.1','1.3','1.3.1','2','2.1','2.2','3','3.1',
  '4','4.1','4.3','4.4','5','6','6.1','6.2','6.3','7','7.1','7.2','7.3','7.4',
  '12.1','12.1.1','12.2','12.2.1','12.3','13.1.1','13.1.2','13.1.3','13.1.4',
  '13.1.5','14.1','14.2','20','30','77.1','77.2','77.1.1','77.1.1.1','77.1.2','77.1.2.1','77.1.3','77.1.4','77.1.4.1','77.1.5.1',
  '77.1.5.2','77.1.5.4','77.1.5.5','77.1.5.6','77.1.5.7','77.1.6','77.1.7','128','128.1','130','481.1','481.23','481.24'
].map(value => STORAGE + value));

export const READINESS_LIMITATIONS = Object.freeze([
  'Technical checks use indexed metadata only; pixels, geometry, calibration and label quality have not been assessed.',
  'Subject grouping follows archived issuer/source identity. It does not establish clinical identity or guarantee absence of data leakage.',
  'Opaque subject and source references are not de-identification. DICOM objects and UIDs may contain sensitive information.',
  'Selected SEG, SR and other objects are preserved without interpreting annotations or creating training labels.',
  'Snapshots freeze membership and hashes; they do not copy or pin originals against later archive removal.'
]);

export function classifyObject(sopClassUid) {
  if (sopClassUid === STORAGE + '66.4') return 'segmentation';
  if (typeof sopClassUid === 'string' && sopClassUid.startsWith(STORAGE + '88.')) return 'structured-report';
  return imageClasses.has(sopClassUid) ? 'image' : 'other';
}

function notice(code, message, count) { return { code, message, ...(count === undefined ? {} : { count }) }; }
const distinct = values => [...new Set(values)].sort((a,b) => typeof a === 'number' ? a-b : String(a).localeCompare(String(b)));

/** Input contains projected catalog fields, never the complete DICOM JSON. */
export function assessReadiness(records) {
  const groups = new Map(), subjects = new Set(), studies = new Set();
  const sourceScoped = new Set(), unknownIdentity = new Set();
  let bytes = 0;
  for (const record of records) {
    const subject = record.subjectId ?? record.patientKey;
    subjects.add(subject); studies.add(record.studyUid); bytes += record.bytes;
    if (record.grouping === 'source-patient-id') sourceScoped.add(subject);
    if (record.grouping === 'study-fallback') unknownIdentity.add(subject);
    const key = JSON.stringify([record.studyUid,record.seriesUid]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const series = [];
  for (const group of groups.values()) {
    const first = group[0], warnings = [], images = group.filter(row => classifyObject(row.sopClassUid) === 'image');
    const modalities = distinct(group.map(row => row.modality).filter(Boolean));
    const rows = distinct(images.map(row => row.rows)), columns = distinct(images.map(row => row.columns));
    const roles = distinct(group.map(row => classifyObject(row.sopClassUid)));
    const invalidDimensions = images.filter(row => !Number.isSafeInteger(row.rows) || row.rows < 1 || !Number.isSafeInteger(row.columns) || row.columns < 1).length;
    if (invalidDimensions) warnings.push(notice('missing-image-dimensions','Known image objects have missing or invalid indexed dimensions.',invalidDimensions));
    if (rows.length > 1 || columns.length > 1) warnings.push(notice('mixed-image-dimensions','Image dimensions vary within this series.'));
    if (modalities.length > 1) warnings.push(notice('mixed-modalities','Indexed modalities vary within this series.'));
    if (distinct(group.map(row => row.sopClassUid)).length > 1) warnings.push(notice('mixed-sop-classes','SOP classes vary within this series.'));
    if (distinct(group.map(row => row.transferSyntaxUid)).length > 1) warnings.push(notice('mixed-transfer-syntaxes','Transfer syntaxes vary within this series. Original encodings are preserved.'));
    const numbers = new Set(); let repeated = 0, missing = 0;
    for (const row of images) {
      const value = String(row.instanceNumber ?? '').trim();
      if (!value) missing++;
      else if (numbers.has(value)) repeated++;
      else numbers.add(value);
    }
    if (missing) warnings.push(notice('missing-instance-numbers','Image objects have no indexed Instance Number; number order is not established.',missing));
    if (repeated) warnings.push(notice('repeated-instance-numbers','Image objects repeat an Instance Number; number order alone is ambiguous.',repeated));
    if (roles.some(role => role !== 'image')) warnings.push(notice('uninterpreted-objects','Non-image or unrecognized objects are retained without interpreting labels or annotations.',group.filter(row => classifyObject(row.sopClassUid) !== 'image').length));
    series.push({ studyUid:first.studyUid,seriesUid:first.seriesUid,modality:modalities.length === 1 ? modalities[0] : '',
      instances:group.length,frames:group.reduce((sum,row) => sum + row.frames,0),bytes:group.reduce((sum,row) => sum + row.bytes,0),
      rows,columns,transferSyntaxUids:distinct(group.map(row => row.transferSyntaxUid)),sopClassUids:distinct(group.map(row => row.sopClassUid)),roles,warnings });
  }
  const warnings = [];
  if (sourceScoped.size) warnings.push(notice('source-scoped-subjects','Subjects without an issuer are grouped within each archive source; the same person in different sources may remain separate.',sourceScoped.size));
  if (unknownIdentity.size) warnings.push(notice('unknown-subject-identity','Missing Patient IDs use study-scoped groups. Patient-level separation across studies cannot be established.',unknownIdentity.size));
  const flagged = series.filter(item => item.warnings.length).length;
  if (flagged) warnings.push(notice('series-metadata-notices','Review the technical notices on selected series.',flagged));
  if (!records.some(row => classifyObject(row.sopClassUid) === 'image')) warnings.push(notice('no-recognized-image-objects','This selection contains no recognized image SOP classes. Objects remain available as original DICOM.'));
  return { summary:{subjects:subjects.size,patients:subjects.size,studies:studies.size,series:series.length,instances:records.length,bytes},
    series,warnings,limitations:[...READINESS_LIMITATIONS] };
}
