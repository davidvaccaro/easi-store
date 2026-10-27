import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ArchiveError, validUid } from '../archive/errors.js';
import { VERSION } from '../version.js';
import { assessReadiness, classifyObject, READINESS_LIMITATIONS } from './Readiness.js';

export const DATASET_LIMITS = Object.freeze({ series:1000,instances:100000,datasets:1000,versions:100,
  persistedMembers:500000,manifestBytes:96*1024*1024,persistedManifestBytes:512*1024*1024 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const PARTITIONS = ['train','validation','test'];
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message,status=400,code='invalid-dataset') => { throw new ArchiveError(message,status,code); };

function object(value,allowed,label='dataset') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))) fail(`Invalid ${label} fields.`);
  return value;
}
function text(value,max,label,{empty=true,multiline=false}={}) {
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) fail(`Invalid ${label}.`);
  value = value.trim(); if (!empty && !value) fail(`Enter ${label}.`); return value;
}
function identity(id) { if (typeof id !== 'string' || !UUID.test(id)) fail('Choose a valid dataset identifier.'); return id; }
function versionNumber(version) { if (!Number.isSafeInteger(version) || version < 1 || version > DATASET_LIMITS.versions) fail('Choose a valid dataset version.'); return version; }
function selection(input) {
  if (!Array.isArray(input) || input.length > DATASET_LIMITS.series) fail('Select at most 1,000 series.');
  const seen = new Set(), result = [];
  for (const item of input) {
    object(item,['studyUid','seriesUid'],'series selection');
    if (!validUid(item.studyUid) || !validUid(item.seriesUid)) fail('Each selected series requires valid study and series UIDs.');
    const key = JSON.stringify([item.studyUid,item.seriesUid]);
    if (seen.has(key)) fail('A series may be selected only once.');
    seen.add(key); result.push({ studyUid:item.studyUid,seriesUid:item.seriesUid });
  }
  return result.sort((a,b) => a.studyUid.localeCompare(b.studyUid) || a.seriesUid.localeCompare(b.seriesUid));
}
function fields(input,{partial=false}={}) {
  object(input,['name','description','labels','reviewNotes','selection',...(partial ? ['revision'] : [])]);
  const result = {};
  if (!partial || Object.hasOwn(input,'name')) result.name = text(input.name,120,'a dataset name',{empty:false});
  if (!partial || Object.hasOwn(input,'description')) result.description = text(input.description ?? '',2000,'dataset description',{multiline:true});
  if (!partial || Object.hasOwn(input,'reviewNotes')) result.reviewNotes = text(input.reviewNotes ?? '',4000,'review notes',{multiline:true});
  if (!partial || Object.hasOwn(input,'labels')) {
    const labels = input.labels ?? [];
    if (!Array.isArray(labels) || labels.length > 32) fail('Use at most 32 organizational labels.');
    result.labels = [...new Set(labels.map(value => text(value,80,'organizational label',{empty:false})))];
  }
  if (!partial || Object.hasOwn(input,'selection')) result.selection = selection(input.selection ?? []);
  if (partial) { revision(input.revision); if (!Object.keys(result).length) fail('Choose dataset fields to update.'); }
  return result;
}
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) fail('A current dataset revision is required.'); }
function splitConfiguration(value) {
  if (value == null) return null;
  object(value,['seed','ratios'],'split');
  const seed = text(value.seed,128,'a split seed',{empty:false});
  object(value.ratios,PARTITIONS,'split ratios');
  const ratios = {};
  for (const name of PARTITIONS) {
    const fraction = value.ratios[name];
    if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) fail('Split ratios must be finite fractions between 0 and 1.');
    ratios[name] = fraction;
  }
  if (Math.abs(PARTITIONS.reduce((sum,name) => sum + ratios[name],0)-1) > 1e-9 || PARTITIONS.filter(name => ratios[name] > 0).length < 2) fail('Split ratios must sum to 1 with at least two nonempty configured partitions.');
  return { seed,ratios };
}
function partition(subjectId,split) {
  if (!split) return null;
  const value = parseInt(digest(JSON.stringify([split.seed,subjectId])).slice(0,13),16) / 0x10000000000000;
  return value < split.ratios.train ? 'train' : value < split.ratios.train + split.ratios.validation ? 'validation' : 'test';
}
function validateRecord(row) {
  if (!UUID.test(row.id) || !validUid(row.studyUid) || !validUid(row.seriesUid) || !validUid(row.sopUid)
    || !validUid(row.sopClassUid) || !validUid(row.transferSyntaxUid) || !HASH.test(row.sha256) || !HASH.test(row.patientKey)
    || row.objectKey !== `${row.sha256.slice(0,2)}/${row.sha256}.dcm` || !Number.isSafeInteger(row.bytes) || row.bytes < 132
    || !Number.isSafeInteger(row.frames) || row.frames < 1 || !Number.isSafeInteger(row.rows) || !Number.isSafeInteger(row.columns)
    || typeof row.source !== 'string' || row.source.length > 128 || typeof row.modality !== 'string' || row.modality.length > 64) fail('Selected catalog records require an integrity review.',503,'dataset-catalog-invalid');
}
function frozenRecord(serialized) {
  let row;
  try { row = JSON.parse(serialized); } catch { fail('Frozen dataset records require an integrity review.',503,'dataset-catalog-invalid'); }
  if (!row || !UUID.test(row.id) || !validUid(row.studyUid) || !validUid(row.seriesUid) || !validUid(row.sopUid)
    || !HASH.test(row.sha256) || row.objectKey !== `${row.sha256.slice(0,2)}/${row.sha256}.dcm`
    || !Number.isSafeInteger(row.bytes) || row.bytes < 132
    || Object.keys(row).some(key => !['id','studyUid','seriesUid','sopUid','sha256','bytes','objectKey'].includes(key))) fail('Frozen dataset records require an integrity review.',503,'dataset-catalog-invalid');
  return row;
}

/** Durable cohort definitions and immutable metadata-only snapshots in the archive's SQLite transaction domain. */
export class DatasetService {
  constructor({archive}) {
    this.archive = archive;
    archive.assertAvailableForMutation();
    archive.db.exec(`CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,config TEXT NOT NULL,revision INTEGER NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dataset_subjects (
      datasetId TEXT NOT NULL,patientKey TEXT NOT NULL,subjectId TEXT NOT NULL,PRIMARY KEY(datasetId,patientKey));
      CREATE TABLE IF NOT EXISTS dataset_versions (
      datasetId TEXT NOT NULL,version INTEGER NOT NULL,snapshotId TEXT NOT NULL UNIQUE,createdAt TEXT NOT NULL,
      manifest TEXT NOT NULL,manifestSha256 TEXT NOT NULL,summary TEXT NOT NULL,split TEXT,PRIMARY KEY(datasetId,version));
      CREATE TABLE IF NOT EXISTS dataset_members (
      datasetId TEXT NOT NULL,version INTEGER NOT NULL,memberId TEXT NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(datasetId,version,memberId));`);
  }
  // A lease prevents study removal/close crossing a queued dataset transaction.
  async write(operation) {
    const release = this.archive.acquireReadLease();
    try {
      const work = this.archive.queue.then(() => {
        this.archive.assertAvailableForMutation();
        const db = this.archive.db;
        db.exec('BEGIN IMMEDIATE');
        try { const value = operation(); db.exec('COMMIT'); return value; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      this.archive.queue = work.catch(() => {});
      return await work;
    } finally { release(); }
  }
  row(id) {
    identity(id); this.archive.assertAvailableForMutation();
    const row = this.archive.db.prepare('SELECT * FROM datasets WHERE id=?').get(id);
    if (!row) fail('Dataset not found.',404,'dataset-not-found');
    return row;
  }
  versions(id) {
    return this.archive.db.prepare('SELECT version,snapshotId,createdAt,manifestSha256,summary,split FROM dataset_versions WHERE datasetId=? ORDER BY version DESC').all(id)
      .map(row => ({...row,summary:JSON.parse(row.summary),split:row.split ? JSON.parse(row.split) : null}));
  }
  get(id) {
    const row = this.row(id);
    return {id:row.id,...JSON.parse(row.config),revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,versions:this.versions(id)};
  }
  list() {
    this.archive.assertAvailableForMutation();
    const ids = this.archive.db.prepare('SELECT id FROM datasets ORDER BY updatedAt DESC,id LIMIT ?').all(DATASET_LIMITS.datasets);
    return {items:ids.map(row => this.get(row.id)),total:ids.length};
  }
  async create(input) {
    const config = fields(input);
    return this.write(() => {
      if (this.archive.db.prepare('SELECT COUNT(*) AS total FROM datasets').get().total >= DATASET_LIMITS.datasets) fail('The archive has reached its dataset definition limit.',413,'dataset-limit');
      this.records(config.selection);
      const id = randomUUID(), now = new Date().toISOString();
      this.archive.db.prepare('INSERT INTO datasets VALUES (?,?,?,?,?)').run(id,JSON.stringify(config),1,now,now);
      return this.get(id);
    });
  }
  async update(id,input) {
    identity(id); const changes = fields(input,{partial:true}), expectedRevision = input.revision;
    return this.write(() => {
      const current = this.get(id);
      if (current.revision !== expectedRevision) fail('The dataset changed. Reload it before saving.',409,'stale-dataset');
      const config = {name:current.name,description:current.description,labels:current.labels,reviewNotes:current.reviewNotes,selection:current.selection,...changes};
      if (changes.selection) this.records(config.selection);
      this.archive.db.prepare('UPDATE datasets SET config=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify(config),new Date().toISOString(),id);
      return this.get(id);
    });
  }
  async remove(id,input) {
    identity(id); object(input,['revision','confirmation'],'dataset removal'); revision(input.revision);
    if (input.confirmation !== 'DELETE DATASET') fail('Confirm dataset metadata removal with DELETE DATASET.');
    const expectedRevision = input.revision;
    return this.write(() => {
      const current = this.get(id);
      if (current.revision !== expectedRevision) fail('The dataset changed. Reload it before removing its metadata.',409,'stale-dataset');
      for (const table of ['dataset_members','dataset_versions','dataset_subjects']) this.archive.db.prepare(`DELETE FROM ${table} WHERE datasetId=?`).run(id);
      this.archive.db.prepare('DELETE FROM datasets WHERE id=?').run(id);
      return {removed:true,originalsRemoved:false};
    });
  }
  records(selected) {
    const rows = [], stmt = this.archive.db.prepare(`SELECT id,studyUid,seriesUid,sopUid,sopClassUid,transferSyntaxUid,modality,patientKey,
      CASE WHEN patientId='' THEN 'study-fallback' WHEN issuer='' THEN 'source-patient-id' ELSE 'issuer-patient-id' END AS grouping,
      instanceNumber,frames,rows,columns,bytes,sha256,objectKey,source FROM instances WHERE studyUid=? AND seriesUid=? ORDER BY sopUid LIMIT ?`);
    for (const item of selected) {
      let count = 0;
      for (const row of stmt.iterate(item.studyUid,item.seriesUid,DATASET_LIMITS.instances - rows.length + 1)) {
        if (rows.length >= DATASET_LIMITS.instances) fail('A dataset is limited to 100,000 instances. Select fewer series.',413,'dataset-instance-limit');
        validateRecord(row); rows.push({...row}); count++;
      }
      if (!count) fail('A selected series is no longer archived. Update the selection before continuing.',409,'dataset-series-missing');
    }
    const total = rows.reduce((sum,row) => sum + row.bytes,0);
    if (!Number.isSafeInteger(total)) fail('Selected byte totals exceed the safe numeric range.',413,'dataset-byte-limit');
    return rows;
  }
  readiness(id) {
    const dataset = this.get(id);
    const assessment = assessReadiness(this.records(dataset.selection));
    const describe = this.archive.db.prepare('SELECT seriesDescription,seriesNumber,studyDescription FROM instances WHERE studyUid=? AND seriesUid=? ORDER BY sopUid LIMIT 1');
    for (const series of assessment.series) Object.assign(series,describe.get(series.studyUid,series.seriesUid));
    return assessment;
  }
  sourceKind(source) {
    if (['upload','stow','synthetic','demo','local'].includes(source)) return 'upload';
    if (source === 'dimse' || source.startsWith('dimse:')) return 'dimse';
    if (source.startsWith('connection:') && this.archive.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='connections'").get()) {
      const row = this.archive.db.prepare('SELECT config FROM connections WHERE id=?').get(source.slice(11));
      if (row) { const type = JSON.parse(row.config).type; if (['dicomweb','dimse'].includes(type)) return type; }
    }
    return 'other';
  }
  async createSnapshot(id,input) {
    identity(id); object(input,['revision','split'],'snapshot'); revision(input.revision);
    const configuredSplit = splitConfiguration(input.split), expectedRevision = input.revision;
    return this.write(() => {
      const dataset = this.get(id);
      if (dataset.revision !== expectedRevision) fail('The dataset changed. Review its selection before freezing.',409,'stale-dataset');
      if (dataset.versions.length >= DATASET_LIMITS.versions) fail('This dataset has reached its limit of 100 immutable versions.',413,'dataset-version-limit');
      const records = this.records(dataset.selection), assessment = assessReadiness(records), version = (dataset.versions[0]?.version ?? 0)+1;
      if (!records.length) fail('Select archived series before freezing a dataset version.',409,'dataset-selection-empty');
      const stored = this.archive.db.prepare('SELECT COUNT(*) AS total FROM dataset_members').get().total;
      if (stored + records.length > DATASET_LIMITS.persistedMembers) fail('The archive has reached its frozen dataset membership limit.',413,'dataset-storage-limit');
      const findSubject = this.archive.db.prepare('SELECT subjectId FROM dataset_subjects WHERE datasetId=? AND patientKey=?');
      const addSubject = this.archive.db.prepare('INSERT INTO dataset_subjects VALUES (?,?,?)');
      const subjects = new Map(), sources = new Map();
      for (const row of records) if (!subjects.has(row.patientKey)) {
        const subjectId = findSubject.get(id,row.patientKey)?.subjectId ?? randomUUID();
        if (!findSubject.get(id,row.patientKey)) addSubject.run(id,row.patientKey,subjectId);
        subjects.set(row.patientKey,subjectId);
      }
      const split = configuredSplit ? {...configuredSplit,counts:{train:0,validation:0,test:0}} : null;
      const assignments = new Map([...subjects.values()].map(subjectId => [subjectId,partition(subjectId,split)]));
      if (split) for (const value of assignments.values()) split.counts[value]++;
      const warnings = [...assessment.warnings];
      const technical = new Map();
      for (const series of assessment.series) for (const warning of series.warnings) {
        const existing = technical.get(warning.code);
        if (existing) existing.count++;
        else technical.set(warning.code,{code:warning.code,message:`Selected series have this metadata notice: ${warning.message}`,count:1});
      }
      warnings.push(...technical.values());
      if (split && PARTITIONS.some(name => split.ratios[name] > 0 && split.counts[name] === 0)) warnings.push({code:'empty-split-partitions',message:'At least one configured partition has no subjects. Seeded hashing gives approximate proportions, especially in small cohorts.'});
      const internal = [];
      const members = records.map(row => {
        const memberId = randomUUID(), subjectId = subjects.get(row.patientKey);
        if (!sources.has(row.source)) sources.set(row.source,{sourceRef:digest(`easi-store-source-v1\0${row.source}`),sourceKind:this.sourceKind(row.source)});
        internal.push({memberId,record:{id:row.id,studyUid:row.studyUid,seriesUid:row.seriesUid,sopUid:row.sopUid,bytes:row.bytes,sha256:row.sha256,objectKey:row.objectKey}});
        return {memberId,subjectId,grouping:row.grouping,studyUid:row.studyUid,seriesUid:row.seriesUid,sopUid:row.sopUid,
          sopClassUid:row.sopClassUid,transferSyntaxUid:row.transferSyntaxUid,modality:row.modality,role:classifyObject(row.sopClassUid),
          frames:row.frames,rows:row.rows,columns:row.columns,bytes:row.bytes,sha256:row.sha256,...sources.get(row.source),partition:assignments.get(subjectId),
          originalPath:`/api/v1/datasets/${id}/versions/${version}/members/${memberId}/original`};
      });
      const snapshotId = randomUUID(), createdAt = new Date().toISOString();
      const manifest = {schemaVersion:1,kind:'easi-store-dataset',datasetId:id,version,snapshotId,createdAt,storeVersion:VERSION,
        summary:assessment.summary,split,limitations:[...READINESS_LIMITATIONS],warnings,members};
      const serialized = JSON.stringify(manifest), manifestBytes = Buffer.byteLength(serialized), manifestSha256 = digest(serialized);
      const existingBytes = this.archive.db.prepare('SELECT COALESCE(SUM(length(CAST(manifest AS BLOB))),0) AS bytes FROM dataset_versions').get().bytes;
      if (manifestBytes > DATASET_LIMITS.manifestBytes || existingBytes + manifestBytes > DATASET_LIMITS.persistedManifestBytes) fail('The archive has reached its dataset manifest storage limit.',413,'dataset-storage-limit');
      this.archive.db.prepare('INSERT INTO dataset_versions VALUES (?,?,?,?,?,?,?,?)').run(id,version,snapshotId,createdAt,serialized,manifestSha256,JSON.stringify(assessment.summary),split ? JSON.stringify(split) : null);
      const insert = this.archive.db.prepare('INSERT INTO dataset_members VALUES (?,?,?,?)');
      for (const item of internal) insert.run(id,version,item.memberId,JSON.stringify(item.record));
      this.archive.db.prepare('UPDATE datasets SET updatedAt=? WHERE id=?').run(createdAt,id);
      return {version,snapshotId,createdAt,manifestSha256,summary:assessment.summary,split};
    });
  }
  versionRow(id,version,{includeManifest=false}={}) {
    this.row(id); versionNumber(version);
    const row = this.archive.db.prepare(`SELECT ${includeManifest ? '*' : 'datasetId,version,snapshotId,createdAt,manifestSha256'} FROM dataset_versions WHERE datasetId=? AND version=?`).get(id,version);
    if (!row) fail('Dataset version not found.',404,'dataset-version-not-found');
    return row;
  }
  getManifestText(id,version) {
    const row = this.versionRow(id,version,{includeManifest:true});
    if (digest(row.manifest) !== row.manifestSha256) fail('This frozen manifest failed integrity verification. Preserve the archive for review.',503,'dataset-manifest-integrity');
    return row.manifest;
  }
  getManifest(id,version) { return JSON.parse(this.getManifestText(id,version)); }
  memberRecord(id,version,memberId) {
    this.versionRow(id,version); identity(memberId);
    const row = this.archive.db.prepare('SELECT record FROM dataset_members WHERE datasetId=? AND version=? AND memberId=?').get(id,version,memberId);
    if (!row) fail('Frozen dataset member not found.',404,'dataset-member-not-found');
    return frozenRecord(row.record);
  }
  catalogStatus(record) {
    const current = this.archive.db.prepare('SELECT id,studyUid,seriesUid,sopUid,sha256,bytes,objectKey FROM instances WHERE sopUid=?').get(record.sopUid);
    if (!current) return 'missing';
    return Object.keys(record).every(key => current[key] === record[key]) ? 'available' : 'changed';
  }
  getMember(id,version,memberId) {
    const record = this.memberRecord(id,version,memberId), status = this.catalogStatus(record);
    if (status !== 'available') fail(status === 'missing' ? 'This frozen original is no longer archived.' : 'This frozen original has been replaced. Substitution is not allowed.',status === 'missing' ? 410 : 409,`dataset-member-${status}`);
    return {...record,memberId,path:join(this.archive.dataDir,'objects',record.objectKey)};
  }
  /** Open only protected hash-addressed objects; never a path supplied by a manifest/client. */
  async inspectObject(record,{verifyHashes,signal}) {
    signal?.throwIfAborted();
    const root = join(this.archive.dataDir,'objects'), shard = join(root,record.sha256.slice(0,2));
    const canonicalRoot = join(await realpath(this.archive.dataDir),'objects');
    for (const path of [root,shard]) {
      let info;
      try { info = await lstat(path); } catch(error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== (path === root ? canonicalRoot : join(canonicalRoot,record.sha256.slice(0,2)))) return 'unreadable';
    }
    const path = join(root,record.objectKey);
    let info;
    try { info = await lstat(path); } catch(error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) return 'unreadable';
    if (info.size !== record.bytes) return 'changed';
    if (!verifyHashes) return 'available';
    const handle = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== record.bytes || opened.ino !== info.ino || opened.dev !== info.dev) return 'changed';
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of handle.createReadStream({autoClose:false,signal})) {
        signal?.throwIfAborted(); bytes += chunk.length;
        if (bytes > record.bytes) return 'changed';
        hash.update(chunk);
      }
      return bytes === record.bytes && hash.digest('hex') === record.sha256 ? 'available' : 'changed';
    } finally { await handle.close(); }
  }
  async checkAvailability(id,version,{verifyHashes=false,signal}={}) {
    if (typeof verifyHashes !== 'boolean') fail('Choose whether to verify original hashes.');
    const release = this.archive.acquireReadLease();
    try {
      signal?.throwIfAborted();
      const snapshot = this.versionRow(id,version), summary = {total:0,available:0,missing:0,changed:0,unreadable:0}, items = [];
      const records = this.archive.db.prepare('SELECT memberId,record FROM dataset_members WHERE datasetId=? AND version=? ORDER BY memberId').all(id,version);
      for (const row of records) {
        signal?.throwIfAborted(); const record = frozenRecord(row.record);
        let status = this.catalogStatus(record);
        if (status === 'available') {
          try { status = await this.inspectObject(record,{verifyHashes,signal}); }
          catch(error) { if (signal?.aborted) throw error; status = 'unreadable'; }
        }
        summary.total++; summary[status]++;
        items.push({memberId:row.memberId,status,verified:status === 'available' && verifyHashes});
      }
      return {datasetId:id,version,snapshotId:snapshot.snapshotId,checkedAt:new Date().toISOString(),verifyHashes,
        verified:verifyHashes && summary.available === summary.total,summary,items};
    } finally { release(); }
  }
}
