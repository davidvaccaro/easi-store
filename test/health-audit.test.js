import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Archive } from '../src/archive/Archive.js';
import { createDicom } from './fixtures/synthetic.js';
import { writePrivateJson } from '../src/health/PrivateJson.js';
async function fixture(t,healthOptions={}) {
  const dataDir = await mkdtemp(join(tmpdir(),'easi-health-audit-'));
  const archive = await Archive.open({dataDir,healthOptions});
  t.after(async () => { await archive.close(); await rm(dataDir,{recursive:true,force:true}); });
  return {archive,health:archive.health,dataDir};
}
async function add(archive) { const bytes = createDicom(), {instance} = await archive.ingest(Readable.from([bytes])); return {...instance,path:archive.getInstance(instance.studyUid,instance.seriesUid,instance.sopUid).path,original:bytes}; }
async function finish(health,options) {
  const first = await health.startAudit(options);
  for (let i=0;i<20000;i++) { const report = health.getAudit(first.id); if (report.status !== 'running') return report; await yieldTurn(); }
  throw Error('Synthetic review did not finish.');
}

test('streamed integrity scan finds missing, same-size corrupt and unreferenced originals without modifying any data',async t => {
  const {archive,health,dataDir} = await fixture(t), good = await add(archive), missing = await add(archive), corrupt = await add(archive);
  await rm(missing.path);
  const changed = Buffer.from(corrupt.original); changed[changed.length-1] ^= 1; await writeFile(corrupt.path,changed);
  const orphan = createDicom(), hash = createHash('sha256').update(orphan).digest('hex'), key = `${hash.slice(0,2)}/${hash}.dcm`;
  await mkdir(join(dataDir,'objects',hash.slice(0,2)),{recursive:true}); await writeFile(join(dataDir,'objects',key),orphan);
  const report = await finish(health);
  assert.equal(report.status,'completed'); assert.equal(report.verifyHashes,true); assert.equal(report.progress.indexed,3);
  assert.deepEqual(report.counts,{missing:1,corrupt:1,unreferenced:1,unsafe:0,unreadable:0});
  assert.ok(report.progress.bytes > 0); assert.deepEqual(await readFile(good.path),good.original); assert.deepEqual(await readFile(corrupt.path),changed);
  assert.deepEqual(await readFile(join(dataDir,'objects',key)),orphan); assert.equal(archive.stats().instances,3);
  const serialized = JSON.stringify(report); assert.ok(!serialized.includes('Synthetic')); assert.ok(!serialized.includes(dataDir)); assert.ok(!serialized.includes(good.sopUid));
});

test('inventory mode explicitly does not claim to detect same-size byte corruption',async t => {
  const {archive,health} = await fixture(t), image = await add(archive), changed = Buffer.from(image.original);
  changed[changed.length-1] ^= 1; await writeFile(image.path,changed);
  const inventory = await finish(health,{verifyHashes:false}); assert.equal(inventory.counts.corrupt,0); assert.equal(inventory.progress.bytes,0); assert.equal(inventory.verifyHashes,false);
  const full = await finish(health,{verifyHashes:true}); assert.equal(full.counts.corrupt,1);
});

test('symlink objects and shards are reported unsafe and never followed',async t => {
  const {archive,health,dataDir} = await fixture(t), image = await add(archive);
  const outside = join(dataDir,'outside-original'); await writeFile(outside,image.original);
  await rm(image.path); await symlink(outside,image.path);
  await symlink(dataDir,join(dataDir,'objects','zz'));
  const report = await finish(health);
  assert.equal(report.status,'completed'); assert.ok(report.counts.unsafe >= 2); assert.equal(report.progress.bytes,0);
  assert.deepEqual(await readFile(outside),image.original);
});

test('unsafe catalog object keys cannot escape the object root or reveal arbitrary paths in findings',async t => {
  const {archive,health,dataDir} = await fixture(t), image = await add(archive);
  archive.db.prepare('UPDATE instances SET objectKey=? WHERE id=?').run('../../outside-secret',image.id);
  const report = await finish(health);
  assert.equal(report.counts.unsafe,1); assert.ok(!JSON.stringify(report).includes('outside-secret')); assert.ok(!JSON.stringify(report).includes(dataDir));
  assert.equal(report.findings.find(item => item.instanceId === image.id).objectKey,undefined);
});

test('only one review runs and a read lease blocks deletion; cancellation releases all resources',async t => {
  const {archive,health} = await fixture(t), image = await add(archive);
  const started = await health.startAudit();
  assert.equal(archive.readLeases.size,1);
  await assert.rejects(health.startAudit(),{code:'health-audit-active',statusCode:409});
  await assert.rejects(archive.deleteStudy(image.studyUid,{confirmation:'DELETE',revision:archive.previewStudyDeletion(image.studyUid).revision}),{code:'archive-read-active'});
  const cancelled = await health.cancelAudit(started.id); assert.equal(cancelled.status,'cancelled'); assert.equal(archive.readLeases.size,0); assert.equal(health.job,null);
  assert.equal((await finish(health)).status,'completed');
});

test('findings and scan population are bounded and incomplete scans never report completed',async t => {
  const {archive,health} = await fixture(t,{limits:{findings:1,records:2}});
  const images = await Promise.all([add(archive),add(archive),add(archive)]);
  for (const image of images) await rm(image.path);
  const report = await finish(health);
  assert.equal(report.status,'failed'); assert.equal(report.errorCode,'audit-limit'); assert.equal(report.progress.indexed,2);
  assert.equal(report.counts.missing,2); assert.equal(report.findings.length,1); assert.equal(report.findingsTruncated,true);
});

test('filesystem entry enumeration also has a hard bound',async t => {
  const {health,dataDir} = await fixture(t,{limits:{entries:1}});
  await mkdir(join(dataDir,'objects','ab')); await writeFile(join(dataDir,'objects','ab','unexpected'),'x');
  const report = await finish(health); assert.equal(report.status,'failed'); assert.equal(report.errorCode,'audit-limit');
});

test('latest report persists privately, exposes defensive copies and prior IDs do not resolve to another report',async t => {
  const {archive,health,dataDir} = await fixture(t); await add(archive); const report = await finish(health);
  const copy = health.getAudit(report.id); copy.counts.corrupt = 1000; assert.equal(health.getAudit().counts.corrupt,0);
  const other = await finish(health); assert.throws(() => health.getAudit(report.id),{statusCode:404});
  await archive.close(); const reopened = await Archive.open({dataDir});
  try { assert.deepEqual(reopened.health.getAudit(),other); } finally { await reopened.close(); }
});

test('a persisted running review becomes interrupted on restart and is never resumed automatically',async t => {
  const {archive,health,dataDir} = await fixture(t); const complete = await finish(health); await archive.close();
  await writePrivateJson(join(dataDir,'health-audit.json'),{...complete,status:'running',finishedAt:null});
  const reopened = await Archive.open({dataDir});
  try { assert.equal(reopened.health.getAudit().status,'interrupted'); assert.equal(reopened.health.getAudit().errorCode,'audit-interrupted'); assert.equal(reopened.health.job,null); }
  finally { await reopened.close(); }
});

test('shutdown cancels an active review before closing its database and read lease',async t => {
  const {archive,health} = await fixture(t); await add(archive); await health.startAudit(); await archive.close();
  assert.equal(health.getAudit().status,'cancelled'); assert.equal(archive.readLeases.size,0); assert.equal(archive.closed,true);
});

test('unpersistable final report is visibly failed and pauses future intake',async t => {
  let failFinal = false;
  const {health} = await fixture(t,{writeJson:async (path,value) => { if (failFinal && value.status && value.status !== 'running') throw Error('private path'); return writePrivateJson(path,value); }});
  failFinal = true; const report = await finish(health);
  assert.equal(report.status,'failed'); assert.equal(report.errorCode,'audit-persistence'); assert.equal((await health.getSnapshot()).ready,false);
});

test('strict review parameters reject arbitrary fields and invalid IDs',async t => {
  const {health} = await fixture(t);
  for (const value of [{verifyHashes:'yes'},{path:'/outside'},{verifyHashes:true,limit:1}]) await assert.rejects(health.startAudit(value),{statusCode:400});
  assert.throws(() => health.getAudit('../../outside'),{statusCode:400});
});

test('a concurrent rename/catalog commit gap is not mistaken for an unreferenced object',async t => {
  const {archive,health} = await fixture(t), image = await add(archive);
  const row = {...archive.db.prepare('SELECT * FROM instances WHERE id=?').get(image.id)}; row.metadata = JSON.parse(row.metadata);
  archive.db.prepare('DELETE FROM instances WHERE id=?').run(image.id);
  let resume; const blocked = new Promise(resolve => { resume = resolve; });
  archive.queue = blocked.then(() => archive.commitRecord(row));
  const started = await health.startAudit();
  for (let i=0;i<1000 && health.getAudit().progress.objects < 2;i++) await yieldTurn();
  assert.equal(health.getAudit().status,'running');
  resume(); await archive.queue;
  for (let i=0;i<10000 && health.getAudit().status === 'running';i++) await yieldTurn();
  assert.equal(health.getAudit(started.id).status,'completed'); assert.equal(health.getAudit().counts.unreferenced,0);
});

test('an interrupted concurrent durable commit stops the audit without reporting its recovery object as orphaned',async t => {
  const {archive,health} = await fixture(t), image = await add(archive);
  archive.db.prepare('DELETE FROM instances WHERE id=?').run(image.id);
  let resume; const blocked = new Promise(resolve => { resume = resolve; });
  archive.queue = blocked.then(() => { archive.recoveryRequired = true; });
  await health.startAudit();
  for (let i=0;i<1000 && health.getAudit().progress.objects < 2;i++) await yieldTurn();
  resume();
  for (let i=0;i<10000 && health.getAudit().status === 'running';i++) await yieldTurn();
  assert.equal(health.getAudit().status,'failed'); assert.equal(health.getAudit().errorCode,'audit-io'); assert.equal(health.getAudit().counts.unreferenced,0);
  archive.recoveryRequired = false;
});
