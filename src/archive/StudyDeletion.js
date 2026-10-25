import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ArchiveError, validUid } from './errors.js';

const MAX_INSTANCES = 100000;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const JOURNAL = /^delete-([a-f0-9-]+)\.json$/;

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJournal(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

function integrityError() {
  return new ArchiveError('Study removal found an original object with invalid storage integrity. The archive must be reviewed before retrying.', 503, 'integrity-error');
}

function revisionOf(records) {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function abortIfNeeded(signal) { signal?.throwIfAborted(); }

// Deletion journals deliberately contain only immutable instance identities and
// storage facts. Never use a path from a client or a journal as a filesystem path.
export class StudyDeletion {
  constructor(archive) { this.archive = archive; }

  records(studyUid) {
    if (!validUid(studyUid)) throw new ArchiveError('A valid study UID is required.', 400, 'invalid-study');
    const records = this.archive.db.prepare('SELECT id,studyUid,seriesUid,sopUid,sha256,objectKey,bytes FROM instances WHERE studyUid=? ORDER BY sopUid LIMIT ?').all(studyUid, MAX_INSTANCES + 1).map(row => ({ ...row }));
    if (!records.length) throw new ArchiveError('The study was not found.', 404, 'study-not-found');
    if (records.length > MAX_INSTANCES) throw new ArchiveError('This study exceeds the safe removal limit of 100,000 instances.', 413, 'study-too-large');
    this.validateRecords(records, studyUid);
    return records;
  }

  validateRecords(records, studyUid) {
    if (!Array.isArray(records) || !records.length || records.length > MAX_INSTANCES) throw new Error('The study removal journal is invalid.');
    const identities = new Set(), objects = new Map();
    let bytes = 0, previous = '';
    for (const record of records) {
      if (!record || !UUID.test(record.id) || record.studyUid !== studyUid || !validUid(record.seriesUid) || !validUid(record.sopUid)
        || !HASH.test(record.sha256) || record.objectKey !== `${record.sha256.slice(0, 2)}/${record.sha256}.dcm`
        || !Number.isSafeInteger(record.bytes) || record.bytes < 132 || identities.has(record.sopUid) || previous && previous >= record.sopUid) throw new Error('The study removal journal is invalid.');
      identities.add(record.sopUid); previous = record.sopUid; bytes += record.bytes;
      if (objects.has(record.objectKey) && objects.get(record.objectKey) !== record.bytes) throw new Error('The study removal journal is invalid.');
      objects.set(record.objectKey, record.bytes);
      if (!Number.isSafeInteger(bytes)) throw new Error('The study removal journal is invalid.');
    }
  }

  summary(studyUid, records) {
    return { studyUid, revision: revisionOf(records), seriesCount: new Set(records.map(row => row.seriesUid)).size,
      instanceCount: records.length, bytes: records.reduce((sum, row) => sum + row.bytes, 0) };
  }

  candidates(studyUid, records) {
    const candidates = new Map();
    for (const record of records) {
      const previous = candidates.get(record.objectKey);
      if (previous && (previous.sha256 !== record.sha256 || previous.bytes !== record.bytes)) throw integrityError();
      candidates.set(record.objectKey, record);
    }
    const referenced = this.archive.db.prepare('SELECT 1 FROM instances WHERE objectKey=? AND studyUid<>? LIMIT 1');
    return [...candidates.values()].filter(row => !referenced.get(row.objectKey, studyUid));
  }

  preview(studyUid) {
    this.archive.assertAvailableForMutation();
    const records = this.records(studyUid);
    return { ...this.summary(studyUid, records), reclaimableBytes: this.candidates(studyUid, records).reduce((sum, row) => sum + row.bytes, 0) };
  }

  assertNoTransfers(studyUid) {
    if (!this.archive.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transfer_jobs'").get()) return;
    const rows = this.archive.db.prepare("SELECT selection FROM transfer_jobs WHERE state IN ('queued','running','canceling')").all();
    for (const row of rows) {
      let selection;
      try { selection = JSON.parse(row.selection); } catch { throw new ArchiveError('Transfer history requires review before removing a study.', 503, 'transfer-state-invalid'); }
      if (!validUid(selection?.studyUid)) throw new ArchiveError('Transfer history requires review before removing a study.', 503, 'transfer-state-invalid');
      if (selection.studyUid === studyUid) throw new ArchiveError('This study has an active transfer. Wait for it to finish or cancel it before removing the study.', 409, 'study-transfer-active');
    }
  }

  async verifyObject(record, { allowMissing = false } = {}) {
    const root = join(this.archive.dataDir, 'objects'), shard = join(root, record.sha256.slice(0, 2));
    // A protected archive is not a general directory tree. Refuse symlinks even
    // if they currently resolve within it, before opening or unlinking a blob.
    const canonicalRoot = join(await realpath(this.archive.dataDir), 'objects');
    for (const path of [root, shard]) {
      let info;
      try { info = await lstat(path); }
      catch (error) { if (allowMissing && error.code === 'ENOENT' && path === shard) return false; throw integrityError(); }
      const expected = path === root ? canonicalRoot : join(canonicalRoot, record.sha256.slice(0, 2));
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== expected) throw integrityError();
    }
    const path = join(root, record.objectKey);
    let info;
    try { info = await lstat(path); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return false; throw integrityError(); }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== record.bytes) throw integrityError();
    const hash = createHash('sha256');
    try { for await (const chunk of createReadStream(path)) hash.update(chunk); }
    catch { throw integrityError(); }
    if (hash.digest('hex') !== record.sha256) throw integrityError();
    return true;
  }

  commit(journal) {
    const db = this.archive.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      this.assertNoTransfers(journal.studyUid);
      if (revisionOf(this.records(journal.studyUid)) !== journal.revision) throw new ArchiveError('The study changed after the removal preview. Review a fresh preview and confirm again.', 409, 'stale-preview');
      db.prepare('INSERT INTO study_deletions (id,studyUid,revision,instanceCount,bytes,createdAt) VALUES (?,?,?,?,?,?)')
        .run(journal.id, journal.studyUid, journal.revision, journal.records.length, journal.bytes, journal.createdAt);
      const result = db.prepare('DELETE FROM instances WHERE studyUid=?').run(journal.studyUid);
      if (result.changes !== journal.records.length) throw new Error('Study removal did not match its durable snapshot.');
      this.archive.addActivity('study-deleted', { source: 'management', id: null, bytes: journal.bytes }, { studyUid: journal.studyUid, seriesCount: journal.seriesCount, instanceCount: journal.records.length });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  async reclaim(journal) {
    let reclaimedBytes = 0;
    const referenced = this.archive.db.prepare('SELECT 1 FROM instances WHERE objectKey=? LIMIT 1');
    for (const record of new Map(journal.records.map(row => [row.objectKey, row])).values()) {
      if (referenced.get(record.objectKey)) continue;
      if (await this.verifyObject(record, { allowMissing: true })) {
        const path = join(this.archive.dataDir, 'objects', record.objectKey);
        await rm(path);
        await syncDirectory(dirname(path));
      }
      reclaimedBytes += record.bytes;
    }
    return reclaimedBytes;
  }

  async finish(journal, journalPath) {
    await rm(journalPath);
    await syncDirectory(dirname(journalPath));
    // Removing the journal is the durable end of reclamation. A remaining SQL
    // marker without a journal only means cleanup of this marker was interrupted.
    this.archive.db.prepare('DELETE FROM study_deletions WHERE id=?').run(journal.id);
  }

  async remove(studyUid, { confirmation, revision, signal } = {}) {
    if (confirmation !== 'DELETE') throw new ArchiveError('Type DELETE exactly to confirm irreversible study removal.', 400, 'confirmation-required');
    if (typeof revision !== 'string' || !HASH.test(revision)) throw new ArchiveError('A fresh study removal preview is required.', 400, 'preview-required');
    this.archive.assertAvailableForMutation();
    if (this.archive.operations.size || this.archive.importReservations.size) throw new ArchiveError('An import is in progress. Wait for it to finish before removing a study.', 409, 'archive-import-active');
    if (this.archive.readLeases.size) throw new ArchiveError('Archive data is being read. Close active viewers or downloads and try again.', 409, 'archive-read-active');
    const records = this.records(studyUid), summary = this.summary(studyUid, records);
    if (summary.revision !== revision) throw new ArchiveError('The study changed after the removal preview. Review a fresh preview and confirm again.', 409, 'stale-preview');
    this.assertNoTransfers(studyUid);
    abortIfNeeded(signal);
    // Reserve before yielding: imports, new read leases and transfer creation
    // cannot cross the filesystem/SQLite commit boundary below.
    this.archive.deleting = true;
    const operation = this.archive.queue.then(async () => {
      const journal = { version: 1, kind: 'study-deletion', id: randomUUID(), createdAt: new Date().toISOString(), ...summary, records };
      const journalPath = join(this.archive.dataDir, 'journal', `delete-${journal.id}.json`);
      let written = false, committed = false;
      try {
        const existing = await readdir(join(this.archive.dataDir, 'journal'));
        if (existing.some(name => name.endsWith('.json'))) throw new ArchiveError('An archive recovery journal requires a restart before study removal.', 503, 'recovery-required');
        for (const record of this.candidates(studyUid, records)) { abortIfNeeded(signal); await this.verifyObject(record); }
        abortIfNeeded(signal);
        written = true; await writeJournal(journalPath, journal);
        abortIfNeeded(signal);
        this.commit(journal); committed = true;
        // Once catalog removal commits, request cancellation must not interrupt
        // reclamation. Startup recovery uses this same idempotent path.
        const reclaimedBytes = await this.reclaim(journal);
        await this.finish(journal, journalPath);
        return { ...summary, deleted: true, reclaimedBytes, reclamationPending: false };
      } catch (error) {
        if (committed || this.archive.db.prepare('SELECT 1 FROM study_deletions WHERE id=?').get(journal.id)) {
          this.archive.recoveryRequired = true;
          return { ...summary, deleted: true, reclaimedBytes: 0, reclamationPending: true };
        }
        if (written) {
          try { await rm(journalPath, { force: true }); await syncDirectory(dirname(journalPath)); }
          catch { this.archive.recoveryRequired = true; }
        }
        if (error.code === 'recovery-required') this.archive.recoveryRequired = true;
        throw error;
      }
    });
    this.archive.queue = operation.catch(() => {});
    try { return await operation; } finally { this.archive.deleting = false; }
  }

  async loadJournal(name) {
    const id = JOURNAL.exec(name)?.[1];
    if (!id || !UUID.test(id)) throw new Error('The study removal journal filename is invalid.');
    const path = join(this.archive.dataDir, 'journal', name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES) throw new Error('The study removal journal is invalid.');
    let journal;
    try { journal = JSON.parse(await readFile(path, 'utf8')); }
    catch { throw new Error('The study removal journal is unreadable. Preserve this data directory for repair.'); }
    if (journal?.version !== 1 || journal.kind !== 'study-deletion' || journal.id !== id || !validUid(journal.studyUid)
      || !HASH.test(journal.revision) || typeof journal.createdAt !== 'string' || !Number.isFinite(Date.parse(journal.createdAt))) throw new Error('The study removal journal is invalid.');
    this.validateRecords(journal.records, journal.studyUid);
    const summary = this.summary(journal.studyUid, journal.records);
    if (summary.revision !== journal.revision || summary.bytes !== journal.bytes || summary.instanceCount !== journal.instanceCount || summary.seriesCount !== journal.seriesCount) throw new Error('The study removal journal does not match its snapshot.');
    return journal;
  }

  async recover() {
    const journalDir = join(this.archive.dataDir, 'journal'), names = await readdir(journalDir);
    const deletions = [];
    for (const name of names.filter(name => name.startsWith('delete-') && name.endsWith('.json'))) deletions.push({ name, journal: await this.loadJournal(name) });
    // An ingest journal cannot legitimately coexist with a committed removal:
    // removal requires an empty journal and excludes all in-flight imports.
    // Fail closed rather than resurrecting a deleted study from ambiguous data.
    for (const { journal } of deletions) {
      const marker = this.archive.db.prepare('SELECT * FROM study_deletions WHERE id=?').get(journal.id);
      if (marker) {
        if (marker.studyUid !== journal.studyUid || marker.revision !== journal.revision || marker.instanceCount !== journal.instanceCount || marker.bytes !== journal.bytes) throw new Error('The committed study removal marker conflicts with its journal.');
        for (const name of names.filter(name => /^[a-f0-9-]+\.json$/.test(name))) {
          let ingest;
          try { ingest = JSON.parse(await readFile(join(journalDir, name), 'utf8')); }
          catch { throw new Error('An archive journal is unreadable during study removal recovery.'); }
          if (ingest?.record?.studyUid === journal.studyUid || journal.records.some(record => record.sopUid === ingest?.record?.sopUid)) throw new Error('Study removal recovery conflicts with an ingest journal. Preserve the archive for repair.');
        }
        if (this.archive.db.prepare('SELECT 1 FROM instances WHERE studyUid=? LIMIT 1').get(journal.studyUid)) throw new Error('A committed study removal conflicts with the catalog.');
        await this.reclaim(journal);
        await this.finish(journal, join(journalDir, `delete-${journal.id}.json`));
      } else {
        // No SQL marker means no catalog deletion committed. No original may
        // have been reclaimed yet, so retain the complete original study.
        if (revisionOf(this.records(journal.studyUid)) !== journal.revision) throw new Error('An uncommitted study removal conflicts with the catalog.');
        for (const record of this.candidates(journal.studyUid, journal.records)) await this.verifyObject(record);
        await rm(join(journalDir, `delete-${journal.id}.json`));
        await syncDirectory(journalDir);
      }
    }
    const remaining = new Set((await readdir(journalDir)).filter(name => name.startsWith('delete-') && name.endsWith('.json')).map(name => JOURNAL.exec(name)?.[1]));
    for (const marker of this.archive.db.prepare('SELECT id,studyUid FROM study_deletions').all()) if (!remaining.has(marker.id)) {
      if (this.archive.db.prepare('SELECT 1 FROM instances WHERE studyUid=? LIMIT 1').get(marker.studyUid)) throw new Error('A completed study removal marker conflicts with the catalog.');
      this.archive.db.prepare('DELETE FROM study_deletions WHERE id=?').run(marker.id);
    }
  }
}
