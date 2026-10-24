import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, chmod } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { extractMetadata } from './metadata.js';
import { ArchiveError } from './errors.js';

export { ArchiveError } from './errors.js';

async function syncDirectory(path) {
  // Windows does not permit opening directory handles. File flushes and SQLite
  // FULL synchronous remain required there; directory fsync is used on POSIX.
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function shaFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function number(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function like(value) { return `%${String(value).replace(/[\\%_]/g, '\\$&')}%`; }
function patientKey(record, source) {
  const identity = record.patientId
    ? [record.issuer ? `issuer:${record.issuer}` : `source:${source}`, record.patientId]
    : ['study', record.studyUid];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
function recordError(record, message, code) {
  return Object.assign(new ArchiveError(message, 409, code), { sopUid: record.sopUid, sopClassUid: record.sopClassUid });
}

const columns = ['id', 'studyUid', 'seriesUid', 'sopUid', 'sopClassUid', 'transferSyntaxUid', 'modality', 'patientName', 'patientId', 'issuer', 'patientKey', 'studyDate', 'studyDescription', 'seriesDescription', 'seriesNumber', 'instanceNumber', 'frames', 'rows', 'columns', 'bytes', 'sha256', 'objectKey', 'metadata', 'source', 'createdAt'];

export class Archive {
  static async open({ dataDir, maxInstanceBytes = 536870912 }) {
    if (!dataDir) throw new Error('Archive dataDir is required.');
    if (!Number.isSafeInteger(maxInstanceBytes) || maxInstanceBytes < 132) throw new Error('Invalid maxInstanceBytes.');
    const archive = new Archive(resolve(dataDir), maxInstanceBytes);
    await archive.initialize();
    return archive;
  }

  constructor(dataDir, maxInstanceBytes) {
    this.dataDir = dataDir;
    this.maxInstanceBytes = maxInstanceBytes;
    this.queue = Promise.resolve();
    this.closing = false;
    this.lockToken = randomUUID();
    this.operations = new Set();
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const lock = join(this.dataDir, '.archive-lock');
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recoveryLock = join(this.dataDir, '.archive-lock-recovery');
      try { await mkdir(recoveryLock, { mode: 0o700 }); }
      catch { throw new ArchiveError('Another process is reviewing the archive lock.', 503, 'archive-locked'); }
      try {
        // Re-read the owner while holding a separate recovery guard. Two
        // starters must never both act on an old dead-process observation.
        let owner;
        try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); }
        catch { throw new ArchiveError('The archive directory is locked. An incomplete lock must be reviewed before opening.', 503, 'archive-locked'); }
        let alive = true;
        if (owner.hostname === hostname() && Number.isInteger(owner.pid)) {
          try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        }
        if (alive) throw new ArchiveError('Another process owns this archive directory.', 503, 'archive-locked');
        const stale = `${lock}.stale-${randomUUID()}`;
        await rename(lock, stale);
        await mkdir(lock, { mode: 0o700 });
        await rm(stale, { recursive: true });
      } finally { await rm(recoveryLock, { recursive: true }); }
    }
    this.lockPath = lock;
    try {
      await atomicJson(join(lock, 'owner.json'), { pid: process.pid, hostname: hostname(), token: this.lockToken });
      for (const directory of ['objects', 'spool', 'journal']) await mkdir(join(this.dataDir, directory), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(join(this.dataDir, 'catalog.sqlite'));
      await chmod(join(this.dataDir, 'catalog.sqlite'), 0o600);
      const schemaVersion = this.db.prepare('PRAGMA user_version').get().user_version;
      if (schemaVersion > 1) throw new Error('This archive was created by a newer EASI Store version; use that version to open it.');
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS instances (
          id TEXT NOT NULL UNIQUE, studyUid TEXT NOT NULL, seriesUid TEXT NOT NULL, sopUid TEXT PRIMARY KEY,
          sopClassUid TEXT NOT NULL, transferSyntaxUid TEXT NOT NULL, modality TEXT NOT NULL,
          patientName TEXT NOT NULL, patientId TEXT NOT NULL, issuer TEXT NOT NULL, patientKey TEXT NOT NULL,
          studyDate TEXT NOT NULL, studyDescription TEXT NOT NULL, seriesDescription TEXT NOT NULL,
          seriesNumber TEXT NOT NULL, instanceNumber TEXT NOT NULL, frames INTEGER NOT NULL,
          rows INTEGER NOT NULL, columns INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
          objectKey TEXT NOT NULL, metadata TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS instances_study ON instances(studyUid);
        CREATE INDEX IF NOT EXISTS instances_series ON instances(seriesUid);
        CREATE INDEX IF NOT EXISTS instances_patient ON instances(patientKey);
        CREATE TABLE IF NOT EXISTS activity (
          id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, outcome TEXT NOT NULL, source TEXT NOT NULL,
          instanceId TEXT, bytes INTEGER NOT NULL DEFAULT 0
        ); PRAGMA user_version=1;`);
      await this.recover();
    } catch (error) { await this.close(); throw error; }
  }

  addActivity(outcome, record) {
    this.db.prepare('INSERT INTO activity VALUES (?,?,?,?,?,?)').run(randomUUID(), new Date().toISOString(), outcome, record.source, record.id, record.bytes);
  }

  commitRecord(record, outcome = 'stored') {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO instances (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => column === 'metadata' ? JSON.stringify(record[column]) : record[column]));
      this.addActivity(outcome, record);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async recover() {
    const journalDir = join(this.dataDir, 'journal');
    for (const name of await readdir(journalDir)) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) {
        if (name.endsWith('.tmp')) await rm(join(journalDir, name));
        continue;
      }
      let journal;
      try { journal = JSON.parse(await readFile(join(journalDir, name), 'utf8')); }
      catch { throw new Error('The archive recovery journal is unreadable. Preserve this data directory for repair.'); }
      const { record, spoolName } = journal;
      if (!record || !/^[a-f0-9]{2}\/[a-f0-9]{64}\.dcm$/.test(record.objectKey) || !/^[a-f0-9-]+\.partial$/.test(spoolName) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('The archive recovery journal is invalid.');
      const destination = join(this.dataDir, 'objects', record.objectKey);
      const spool = join(this.dataDir, 'spool', spoolName);
      const existing = this.db.prepare('SELECT sha256 FROM instances WHERE sopUid=?').get(record.sopUid);
      if (existing && existing.sha256 !== record.sha256) throw new Error('The archive recovery journal conflicts with an indexed instance.');
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await syncDirectory(join(this.dataDir, 'objects'));
      let sourcePath = destination;
      try { await stat(destination); }
      catch (error) { if (error.code !== 'ENOENT') throw error; sourcePath = spool; }
      if (await shaFile(sourcePath) !== record.sha256) throw new Error('Archive recovery found an original object with an invalid integrity hash.');
      if (sourcePath === spool) await rename(spool, destination);
      await syncDirectory(dirname(destination));
      if (!existing) this.commitRecord(record, 'recovered');
      await rm(spool, { force: true });
      await rm(join(journalDir, name));
    }
    // Unjournaled partials were never acknowledged and cannot be catalogued.
    for (const name of await readdir(join(this.dataDir, 'spool'))) {
      if (/^[a-f0-9-]+\.partial$/.test(name)) await rm(join(this.dataDir, 'spool', name));
    }
    await syncDirectory(journalDir);
  }

  async ingest(readable, options = {}) {
    if (this.closing) throw new ArchiveError('The archive is shutting down.', 503, 'closing');
    if (this.recoveryRequired) throw new ArchiveError('An interrupted durable write requires an archive restart before importing more instances.', 503, 'recovery-required');
    const operation = this.performIngest(readable, options);
    this.operations.add(operation);
    try { return await operation; } finally { this.operations.delete(operation); }
  }

  async performIngest(readable, { source = 'upload', expectedStudyUid, expectedSeriesUid, expectedSopUid, expectedSopClassUid } = {}) {
    if (typeof source !== 'string' || !source.length || source.length > 128) throw new ArchiveError('Invalid import source.');
    const spoolName = `${randomUUID()}.partial`;
    const spool = join(this.dataDir, 'spool', spoolName);
    let journalPath;
    let bytes = 0;
    let persisted = false;
    const handle = await open(spool, 'wx', 0o600);
    const hash = createHash('sha256');
    try {
      try {
        for await (const input of readable) {
          const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
          bytes += chunk.length;
          if (bytes > this.maxInstanceBytes) throw new ArchiveError('The DICOM instance exceeds the configured upload limit.', 413, 'instance-too-large');
          hash.update(chunk);
          // writeFile on FileHandle advances its offset and handles short writes.
          await handle.writeFile(chunk);
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (bytes < 132) throw new ArchiveError('The DICOM file is empty or missing its Part 10 header.');
      const prefix = await open(spool, 'r');
      try { const marker = Buffer.alloc(4); await prefix.read(marker, 0, 4, 128); if (marker.toString('ascii') !== 'DICM') throw new ArchiveError('This preview requires DICOM Part 10 files with a DICM prefix.'); }
      finally { await prefix.close(); }
      const metadata = await extractMetadata(spool);
      if (expectedStudyUid && metadata.studyUid !== expectedStudyUid) throw recordError(metadata, 'The uploaded instance does not belong to the requested study.', 'study-mismatch');
      if (expectedSeriesUid && metadata.seriesUid !== expectedSeriesUid) throw recordError(metadata, 'The uploaded instance does not belong to the requested series.', 'series-mismatch');
      if (expectedSopUid && metadata.sopUid !== expectedSopUid || expectedSopClassUid && metadata.sopClassUid !== expectedSopClassUid) throw recordError(metadata, 'The uploaded dataset does not match its DIMSE command UIDs.', 'command-mismatch');
      const sha256 = hash.digest('hex');
      const record = { ...metadata, id: randomUUID(), patientKey: patientKey(metadata, source), bytes, sha256, objectKey: `${sha256.slice(0, 2)}/${sha256}.dcm`, source, createdAt: new Date().toISOString() };
      const commit = async () => {
        if (this.recoveryRequired) throw new ArchiveError('An interrupted durable write requires an archive restart before importing more instances.', 503, 'recovery-required');
        const existing = this.db.prepare('SELECT * FROM instances WHERE sopUid=?').get(record.sopUid);
        if (existing) {
          if (existing.sha256 !== sha256) throw recordError(record, 'This SOP Instance UID already exists with different original bytes. The existing object was preserved.', 'uid-conflict');
          this.addActivity('duplicate', { ...record, id: existing.id });
          return { status: 'duplicate', instance: this.publicRecord(existing) };
        }
        const series = this.db.prepare('SELECT studyUid FROM instances WHERE seriesUid=? LIMIT 1').get(record.seriesUid);
        if (series && series.studyUid !== record.studyUid) throw recordError(record, 'The series UID is already associated with another study.', 'hierarchy-conflict');
        const study = this.db.prepare('SELECT patientKey FROM instances WHERE studyUid=? LIMIT 1').get(record.studyUid);
        if (study && study.patientKey !== record.patientKey) throw recordError(record, 'The study UID is already associated with another patient identity namespace.', 'patient-conflict');
        journalPath = join(this.dataDir, 'journal', `${record.id}.json`);
        await syncDirectory(join(this.dataDir, 'spool'));
        await atomicJson(journalPath, { version: 1, record, spoolName });
        const destination = join(this.dataDir, 'objects', record.objectKey);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await syncDirectory(join(this.dataDir, 'objects'));
        await rename(spool, destination);
        persisted = true;
        await syncDirectory(dirname(destination));
        this.commitRecord(record);
        await rm(journalPath);
        journalPath = null;
        await syncDirectory(join(this.dataDir, 'journal'));
        return { status: 'stored', instance: this.publicRecord(record) };
      };
      const committed = this.queue.then(commit);
      this.queue = committed.catch(() => {});
      return await committed;
    } finally {
      // A durable journal belongs to startup recovery if commit failed after it
      // was written. Never remove its only source object on an error path.
      if (!journalPath && !persisted) await rm(spool, { force: true });
      if (journalPath) this.recoveryRequired = true;
    }
  }

  publicRecord(row, includePath = false) {
    const result = { ...row };
    if (typeof result.metadata === 'string') result.metadata = JSON.parse(result.metadata);
    if (includePath) result.path = join(this.dataDir, 'objects', result.objectKey);
    delete result.objectKey;
    return result;
  }

  listStudies({ search = '', limit = 100, offset = 0 } = {}) {
    limit = Math.max(1, Math.min(1000, Math.trunc(number(limit, 100))));
    offset = Math.max(0, Math.trunc(number(offset)));
    const params = search ? [like(search), like(search), like(search), like(search)] : [];
    const where = search ? "WHERE patientName LIKE ? ESCAPE '\\' OR patientId LIKE ? ESCAPE '\\' OR studyDescription LIKE ? ESCAPE '\\' OR studyUid LIKE ? ESCAPE '\\'" : '';
    const total = this.db.prepare(`SELECT COUNT(DISTINCT studyUid) AS total FROM instances ${where}`).get(...params).total;
    const items = this.db.prepare(`SELECT studyUid, patientKey, patientName, patientId, studyDate, studyDescription,
      GROUP_CONCAT(DISTINCT modality) AS modalities, COUNT(DISTINCT seriesUid) AS seriesCount,
      COUNT(*) AS instanceCount, SUM(bytes) AS bytes FROM instances ${where}
      GROUP BY studyUid ORDER BY studyDate DESC, studyUid LIMIT ? OFFSET ?`).all(...params, limit, offset)
      .map(row => ({ ...row, modalities: row.modalities.split(',').filter(Boolean) }));
    return { items, total };
  }

  listSeries(studyUid) {
    return this.db.prepare(`SELECT seriesUid, studyUid, seriesDescription, modality, seriesNumber, COUNT(*) AS instanceCount, SUM(frames) AS frames, SUM(bytes) AS bytes FROM instances WHERE studyUid=? GROUP BY seriesUid ORDER BY CAST(seriesNumber AS INTEGER),seriesUid`).all(studyUid);
  }
  listInstances(studyUid, seriesUid) {
    return this.db.prepare('SELECT * FROM instances WHERE studyUid=? AND seriesUid=? ORDER BY CAST(instanceNumber AS INTEGER),sopUid').all(studyUid, seriesUid).map(row => this.publicRecord(row));
  }
  getInstance(studyUid, seriesUid, sopUid) {
    const row = this.db.prepare('SELECT * FROM instances WHERE studyUid=? AND seriesUid=? AND sopUid=?').get(studyUid, seriesUid, sopUid);
    return row ? this.publicRecord(row, true) : null;
  }
  stats() {
    return { ...this.db.prepare('SELECT COUNT(DISTINCT patientKey) AS patients,COUNT(DISTINCT studyUid) AS studies,COUNT(DISTINCT seriesUid) AS series,COUNT(*) AS instances,COALESCE(SUM(bytes),0) AS bytes FROM instances').get() };
  }
  activity({ limit = 100 } = {}) {
    return this.db.prepare('SELECT * FROM activity ORDER BY timestamp DESC,id DESC LIMIT ?').all(Math.max(1, Math.min(1000, Math.trunc(number(limit, 100))))).map(row => ({ ...row }));
  }

  queryRecords(where = '', params = []) {
    return this.db.prepare(`SELECT * FROM instances ${where ? `WHERE ${where}` : ''} ORDER BY studyDate DESC,studyUid,CAST(seriesNumber AS INTEGER),seriesUid,CAST(instanceNumber AS INTEGER),sopUid`).all(...params).map(row => this.publicRecord(row));
  }

  queryGroups(where, params, { level, limit, offset }) {
    const column = { study: 'studyUid', series: 'seriesUid', instance: 'sopUid' }[level];
    if (!column) throw new Error('Invalid query level.');
    const identities = this.db.prepare(`SELECT ${column} AS uid FROM instances ${where ? `WHERE ${where}` : ''} GROUP BY ${column} ORDER BY MAX(studyDate) DESC,${column} LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
    const groups = identities.slice(0, limit).map(({ uid }) => {
      const record = this.publicRecord(this.db.prepare(`SELECT * FROM instances WHERE ${column}=? ORDER BY sopUid LIMIT 1`).get(uid));
      const totals = this.db.prepare(`SELECT COUNT(*) AS instanceCount,COUNT(DISTINCT seriesUid) AS seriesCount,GROUP_CONCAT(DISTINCT modality) AS modalities FROM instances WHERE ${column}=?`).get(uid);
      return { record, ...totals, modalities: totals.modalities.split(',').filter(Boolean) };
    });
    return { groups, hasMore: identities.length > limit };
  }

  originalRecords(where, params) {
    // Retrieval needs identities, syntax and opaque paths only; do not load all
    // indexed metadata when a large study is downloaded.
    return this.db.prepare(`SELECT studyUid,seriesUid,sopUid,transferSyntaxUid,objectKey FROM instances WHERE ${where} ORDER BY CAST(seriesNumber AS INTEGER),seriesUid,CAST(instanceNumber AS INTEGER),sopUid`).all(...params)
      .map(row => ({ ...row, path: join(this.dataDir, 'objects', row.objectKey) }));
  }

  checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  async close() {
    if (this.closed) return;
    this.closing = true;
    await Promise.allSettled([...this.operations]);
    await this.queue;
    if (this.db) { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { this.db.close(); this.db = null; } }
    if (this.lockPath) {
      try {
        const owner = JSON.parse(await readFile(join(this.lockPath, 'owner.json'), 'utf8'));
        if (owner.token === this.lockToken) await rm(this.lockPath, { recursive: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.closed = true;
  }
}
