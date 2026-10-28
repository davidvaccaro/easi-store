import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { ArchiveError } from '../archive/errors.js';
import { readPrivateJson, writePrivateJson } from './PrivateJson.js';

export const HEALTH_LIMITS = Object.freeze({ findings:1000, records:100000, entries:100000,
  durationMs:30*60*1000, chunkBytes:1024*1024, intakeOverheadBytes:8*1024*1024 });
const MAX_BYTES = 1024**5, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/, KEY = /^[a-f0-9]{2}\/[a-f0-9]{64}\.dcm$/;
const KINDS = ['missing','corrupt','unreferenced','unsafe','unreadable'];
const STATUSES = ['running','completed','cancelled','failed','interrupted'];
const clone = value => value == null ? value : structuredClone(value);
const fail = (message,status=400,code='invalid-health-settings') => { throw new ArchiveError(message,status,code); };
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))) fail('Invalid health settings fields.');
}
function settings(value) {
  object(value,['revision','reserveBytes','warningBytes','maxConcurrentImports']);
  if (typeof value.revision !== 'string' || !UUID.test(value.revision)
    || !Number.isSafeInteger(value.reserveBytes) || value.reserveBytes < 0 || value.reserveBytes > MAX_BYTES
    || !Number.isSafeInteger(value.warningBytes) || value.warningBytes < value.reserveBytes || value.warningBytes > MAX_BYTES
    || !Number.isInteger(value.maxConcurrentImports) || value.maxConcurrentImports < 1 || value.maxConcurrentImports > 64) fail('Invalid archive storage thresholds or concurrency limit.');
  return { revision:value.revision,reserveBytes:value.reserveBytes,warningBytes:value.warningBytes,maxConcurrentImports:value.maxConcurrentImports };
}
function checkedReport(value) {
  object(value,['id','status','startedAt','finishedAt','verifyHashes','progress','counts','findings','findingsTruncated','errorCode']);
  if (!UUID.test(value.id) || !STATUSES.includes(value.status) || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
    || value.finishedAt !== null && (typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt)))
    || typeof value.verifyHashes !== 'boolean' || typeof value.findingsTruncated !== 'boolean'
    || !Array.isArray(value.findings) || value.findings.length > HEALTH_LIMITS.findings
    || value.errorCode !== undefined && !['audit-limit','audit-io','audit-persistence','audit-interrupted'].includes(value.errorCode)) throw new Error('Invalid private health report.');
  object(value.progress,['indexed','objects','bytes']); object(value.counts,KINDS);
  if (Object.keys(value.progress).length !== 3 || Object.keys(value.counts).length !== KINDS.length) throw new Error('Invalid private health report.');
  for (const count of [...Object.values(value.progress),...Object.values(value.counts)]) if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid private health report.');
  for (const item of value.findings) {
    object(item,['kind','instanceId','objectKey']);
    if (!KINDS.includes(item.kind) || item.instanceId !== undefined && !UUID.test(item.instanceId) || item.objectKey !== undefined && !KEY.test(item.objectKey)) throw new Error('Invalid private health finding.');
  }
  return clone(value);
}
function storageError(error) {
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') return new ArchiveError('The archive filesystem has insufficient storage. The instance was not acknowledged.',507,'insufficient-storage');
  return error;
}

/** Live archive capacity admission and bounded, read-only original integrity review. */
export class HealthService {
  static async open(options) { const service = new HealthService(options); await service.initialize(); return service; }
  constructor({archive,capacity = path => statfs(path,{bigint:true}),writeJson = writePrivateJson,limits = {}}) {
    this.archive = archive; this.capacity = capacity; this.writeJson = writeJson;
    this.limits = { ...HEALTH_LIMITS,...limits };
    for (const key of ['findings','records','entries','durationMs','chunkBytes']) if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > HEALTH_LIMITS[key]) throw new Error('Invalid health review limit.');
    this.settingsPath = join(archive.dataDir,'health-settings.json'); this.reportPath = join(archive.dataDir,'health-audit.json');
    this.settings = { revision:randomUUID(),reserveBytes:256*1024*1024,warningBytes:1024*1024*1024,maxConcurrentImports:8 };
    this.queue = Promise.resolve(); this.writeQueue = Promise.resolve(); this.activeImports = 0; this.reservedChunkBytes = 0;
    this.sqlite = { status:'unknown',checkedAt:null }; this.latestAudit = null; this.job = null; this.closed = false; this.persistenceFailed = false;
  }
  async initialize() {
    const saved = await readPrivateJson(this.settingsPath,4096);
    if (saved !== undefined) this.settings = settings(saved); else await this.persist(this.settingsPath,this.settings);
    const report = await readPrivateJson(this.reportPath,1024*1024);
    if (report !== undefined) {
      this.latestAudit = checkedReport(report);
      if (this.latestAudit.status === 'running') {
        this.latestAudit.status = 'interrupted'; this.latestAudit.errorCode = 'audit-interrupted'; this.latestAudit.finishedAt = new Date().toISOString();
        await this.persist(this.reportPath,this.latestAudit);
      }
    }
    this.quickCheck();
  }
  persist(path,value) {
    const captured = clone(value), operation = this.queue.then(async () => {
      try { await this.writeJson(path,captured); }
      catch (error) { if (error.healthWriteRenamed) this.persistenceFailed = true; throw error; }
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  quickCheck() {
    let ok = false;
    try { const rows = this.archive.db.prepare('PRAGMA quick_check(1)').all(); ok = rows.length === 1 && Object.values(rows[0])[0] === 'ok'; } catch {}
    this.sqlite = { status:ok ? 'ok' : 'error',checkedAt:new Date().toISOString() };
    return clone(this.sqlite);
  }
  assertWritable() {
    if (this.closed || this.persistenceFailed) fail('Archive health state requires a restart before importing.',503,'health-unavailable');
    if (this.sqlite.status !== 'ok') fail('The archive catalog requires an integrity review before importing.',503,'catalog-unhealthy');
  }
  acquireIntake() {
    this.assertWritable();
    if (this.activeImports >= this.settings.maxConcurrentImports) fail('The archive has reached its concurrent import limit. Retry after active imports finish.',503,'intake-busy');
    this.activeImports++;
    let released = false;
    return () => { if (!released) { released = true; this.activeImports--; } };
  }
  async storageSnapshot() {
    const reservedBytes = this.activeImports * HEALTH_LIMITS.intakeOverheadBytes + this.reservedChunkBytes;
    let totalBytes = null, freeBytes = null, availableBytes = null, status = 'unknown';
    try {
      const value = await this.capacity(this.archive.dataDir);
      const integer = input => typeof input === 'bigint' ? input : Number.isSafeInteger(input) ? BigInt(input) : -1n;
      const size = integer(value.bsize), total = integer(value.blocks), free = integer(value.bfree), available = integer(value.bavail);
      if (size <= 0n || total < 0n || free < 0n || available < 0n || free > total || available > free
        || total*size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid filesystem capacity.');
      totalBytes = Number(total*size); freeBytes = Number(free*size); availableBytes = Number(available*size);
      const usable = availableBytes - reservedBytes;
      // With no active import there is no metadata reservation yet. Readiness
      // must still account for the minimum admission budget, including when
      // the operator explicitly sets the configurable reserve to zero.
      const minimumAdmission = this.settings.reserveBytes + (this.activeImports ? 0 : HEALTH_LIMITS.intakeOverheadBytes);
      status = usable < minimumAdmission ? 'low' : usable < this.settings.warningBytes ? 'warning' : 'ok';
    } catch {}
    return { status,totalBytes,freeBytes,availableBytes,reserveBytes:this.settings.reserveBytes,warningBytes:this.settings.warningBytes,
      reservedBytes,activeImports:this.activeImports,maxConcurrentImports:this.settings.maxConcurrentImports };
  }
  async getSnapshot() {
    const storage = await this.storageSnapshot(), recoveryRequired = Boolean(this.archive.recoveryRequired);
    return { version:1,checkedAt:new Date().toISOString(),ready:!this.archive.closing && !this.archive.closed && !this.closed && !this.persistenceFailed && !recoveryRequired
      && this.sqlite.status === 'ok' && !['low','unknown'].includes(storage.status),recoveryRequired,storage,settings:clone(this.settings),sqlite:clone(this.sqlite),latestAudit:this.getAudit() };
  }
  async updateSettings(input) {
    const next = settings(input);
    const operation = this.writeQueue.then(async () => {
      this.archive.assertAvailableForMutation(); this.assertWritable();
      if (next.revision !== this.settings.revision) fail('Storage settings changed. Refresh and review the current settings.',409,'stale-health-settings');
      const updated = { ...next,revision:randomUUID() };
      await this.persist(this.settingsPath,updated); this.settings = updated; return clone(updated);
    });
    this.writeQueue = operation.catch(() => {}); return operation;
  }
  async writeChunk(bytes,write) {
    const operation = this.writeQueue.then(async () => {
      this.assertWritable();
      const capacity = await this.storageSnapshot();
      if (capacity.status === 'unknown') fail('Filesystem capacity is unavailable. Imports are paused until it can be checked.',503,'storage-unavailable');
      if (capacity.availableBytes - capacity.reservedBytes - bytes < this.settings.reserveBytes) fail('The archive storage reserve would be exceeded. Free space or review storage settings before retrying.',507,'insufficient-storage');
      this.reservedChunkBytes += bytes;
      try { return await write(); } catch (error) { throw storageError(error); }
      finally { this.reservedChunkBytes -= bytes; }
    });
    this.writeQueue = operation.catch(() => {}); return operation;
  }
  getAudit(id) {
    if (id !== undefined && (typeof id !== 'string' || !UUID.test(id))) fail('Choose a valid integrity review identifier.',400,'invalid-health-audit');
    if (id !== undefined && this.latestAudit?.id !== id) fail('The integrity review was not found.',404,'health-audit-not-found');
    const report = clone(this.latestAudit);
    // Terminal state is observable only after its private report is durable and
    // its read lease is released. A new review can then begin immediately.
    if (report && this.job?.report === this.latestAudit && report.status !== 'running') {
      report.status = 'running'; report.finishedAt = null; delete report.errorCode;
    }
    return report;
  }
  async startAudit(input = {}) {
    object(input,['verifyHashes']);
    if (input.verifyHashes !== undefined && typeof input.verifyHashes !== 'boolean') fail('Choose an integrity review mode.',400,'invalid-health-audit');
    if (this.job) fail('An integrity review is already running.',409,'health-audit-active');
    this.archive.assertAvailableForMutation();
    if (this.closed || this.persistenceFailed) fail('Archive health state is unavailable.',503,'health-unavailable');
    const release = this.archive.acquireReadLease(), controller = new AbortController();
    const report = { id:randomUUID(),status:'running',startedAt:new Date().toISOString(),finishedAt:null,verifyHashes:input.verifyHashes ?? true,
      progress:{ indexed:0,objects:0,bytes:0 },counts:Object.fromEntries(KINDS.map(kind => [kind,0])),findings:[],findingsTruncated:false };
    const job = { controller,report,release,promise:null }; this.job = job; this.latestAudit = report;
    let started, failed;
    const admitted = new Promise((resolve,reject) => { started = resolve; failed = reject; });
    job.promise = (async () => {
      try { await this.persist(this.reportPath,report); }
      catch { failed(new ArchiveError('The integrity review could not be saved.',503,'health-persistence')); return; }
      started(); await this.runAudit(job);
    })().finally(() => { release(); if (this.job === job) this.job = null; });
    await admitted;
    return clone(report);
  }
  async cancelAudit(id) {
    this.getAudit(id);
    if (this.job?.report.id === id) { this.job.controller.abort(); await this.job.promise; }
    return this.getAudit(id);
  }
  finding(report,kind,record = {}) {
    report.counts[kind]++;
    if (report.findings.length < this.limits.findings) report.findings.push({ kind,...(UUID.test(record.id ?? '') ? { instanceId:record.id } : {}),...(KEY.test(record.objectKey ?? '') ? { objectKey:record.objectKey } : {}) });
    else report.findingsTruncated = true;
  }
  async runAudit({controller,report}) {
    const signal = controller.signal, deadline = Date.now()+this.limits.durationMs;
    const check = () => { signal.throwIfAborted(); if (Date.now() > deadline) throw Object.assign(new Error('Bounded integrity review stopped.'),{code:'audit-limit'}); };
    try {
      this.quickCheck(); check();
      const canonical = await realpath(this.archive.dataDir), root = join(this.archive.dataDir,'objects');
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== join(canonical,'objects')) {
        this.finding(report,'unsafe'); throw Object.assign(new Error('Unsafe object directory.'),{code:'audit-io'});
      }
      let cursor = 0;
      const end = this.archive.db.prepare('SELECT COALESCE(MAX(rowid),0) AS maximum FROM instances').get().maximum;
      const page = this.archive.db.prepare('SELECT rowid AS cursor,id,objectKey,sha256,bytes FROM instances WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 128');
      for (;;) {
        check(); const rows = page.all(cursor,end); if (!rows.length) break;
        for (const row of rows) {
          check(); if (report.progress.indexed >= this.limits.records) throw Object.assign(new Error('Review bound reached.'),{code:'audit-limit'});
          cursor = row.cursor; report.progress.indexed++;
          if (!UUID.test(row.id) || !HASH.test(row.sha256) || row.objectKey !== `${row.sha256.slice(0,2)}/${row.sha256}.dcm` || !Number.isSafeInteger(row.bytes) || row.bytes < 132) this.finding(report,'unsafe',row);
          else await this.inspectObject(row,report,{canonical,signal,check});
          await yieldTurn(undefined,{signal});
        }
      }
      const references = this.archive.db.prepare('SELECT 1 FROM instances WHERE objectKey=? LIMIT 1');
      const directories = await opendir(root);
      for await (const shard of directories) {
        check(); if (++report.progress.objects > this.limits.entries) throw Object.assign(new Error('Review bound reached.'),{code:'audit-limit'});
        if (!/^[a-f0-9]{2}$/.test(shard.name) || !shard.isDirectory() || shard.isSymbolicLink()) { this.finding(report,'unsafe'); continue; }
        const shardPath = join(root,shard.name);
        if (await realpath(shardPath) !== join(canonical,'objects',shard.name)) { this.finding(report,'unsafe'); continue; }
        const files = await opendir(shardPath);
        for await (const entry of files) {
          check(); if (++report.progress.objects > this.limits.entries) throw Object.assign(new Error('Review bound reached.'),{code:'audit-limit'});
          const objectKey = `${shard.name}/${entry.name}`;
          if (!KEY.test(objectKey) || !entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith(shard.name)) { this.finding(report,'unsafe',{objectKey}); continue; }
          // A rename-to-object/catalog commit already queued by intake must
          // finish before this live unreferenced-object observation.
          await this.archive.queue; check();
          if (this.archive.recoveryRequired) throw Object.assign(new Error('Archive recovery is required.'),{code:'audit-io'});
          if (!references.get(objectKey)) this.finding(report,'unreferenced',{objectKey});
          await yieldTurn(undefined,{signal});
        }
      }
      report.status = 'completed';
    } catch (error) {
      report.status = signal.aborted ? 'cancelled' : 'failed';
      if (!signal.aborted) report.errorCode = error.code === 'audit-limit' ? 'audit-limit' : 'audit-io';
    }
    report.finishedAt = new Date().toISOString();
    try { await this.persist(this.reportPath,report); }
    catch { report.status = 'failed'; report.errorCode = 'audit-persistence'; this.persistenceFailed = true; }
    return report;
  }
  async inspectObject(row,report,{canonical,signal,check}) {
    const root = join(this.archive.dataDir,'objects'), shard = join(root,row.sha256.slice(0,2)), path = join(root,row.objectKey);
    let handle;
    try {
      const directory = await lstat(shard);
      if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(shard) !== join(canonical,'objects',row.sha256.slice(0,2))) { this.finding(report,'unsafe',row); return; }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== join(canonical,'objects',row.objectKey)) { this.finding(report,'unsafe',row); return; }
      handle = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) { this.finding(report,'unsafe',row); return; }
      if (opened.size !== row.bytes) { this.finding(report,'corrupt',row); return; }
      if (report.verifyHashes) {
        const hash = createHash('sha256'), buffer = Buffer.alloc(256*1024); let position = 0;
        for (;;) { check(); const {bytesRead} = await handle.read(buffer,0,buffer.length,position); if (!bytesRead) break; hash.update(buffer.subarray(0,bytesRead)); position += bytesRead; report.progress.bytes += bytesRead; await yieldTurn(undefined,{signal}); }
        const after = await handle.stat();
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || position !== row.bytes || hash.digest('hex') !== row.sha256) this.finding(report,'corrupt',row);
      }
    } catch (error) {
      if (signal.aborted || error.code === 'audit-limit') throw error;
      this.finding(report,error.code === 'ENOENT' ? 'missing' : ['ELOOP','ENOTDIR'].includes(error.code) ? 'unsafe' : 'unreadable',row);
    } finally { await handle?.close(); }
  }
  async close() {
    this.closed = true;
    if (this.job) { this.job.controller.abort(); await this.job.promise; }
    await this.writeQueue; await this.queue;
  }
}
