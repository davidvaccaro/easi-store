import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { Archive } from '../src/archive/Archive.js';
import { HEALTH_LIMITS } from '../src/health/HealthService.js';
import { writePrivateJson } from '../src/health/PrivateJson.js';
import { createDicom } from './fixtures/synthetic.js';
const stream = value => Readable.from([value]);
const capacity = free => ({ bsize:1n,blocks:100000000000n,bfree:BigInt(free),bavail:BigInt(free) });
async function fixture(t,healthOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(),'easi-health-'));
  const archive = await Archive.open({ dataDir,healthOptions });
  t.after(async () => { await archive.close(); await rm(dataDir,{recursive:true,force:true}); });
  return { archive,health:archive.health,dataDir };
}
async function thresholds(health,fields = {}) { return health.updateSettings({ ...health.settings,...fields }); }

test('health distinguishes readiness, warning, low and unknown space with safe capacity facts',async t => {
  let free = 2*1024**3, unavailable = false;
  const { archive,health } = await fixture(t,{capacity:async () => { if (unavailable) throw Error('private path/secret'); return capacity(free); }});
  assert.equal((await health.getSnapshot()).ready,true);
  free = 512*1024**2; assert.equal((await health.getSnapshot()).storage.status,'warning');
  free = 128*1024**2; const low = await health.getSnapshot(); assert.equal(low.ready,false); assert.equal(low.storage.status,'low');
  await assert.rejects(archive.ingest(stream(createDicom())),{statusCode:507,code:'insufficient-storage'});
  unavailable = true; const unknown = await health.getSnapshot(); assert.equal(unknown.ready,false); assert.equal(unknown.storage.availableBytes,null);
  await assert.rejects(archive.ingest(stream(createDicom())),{statusCode:503,code:'storage-unavailable'});
  assert.equal(archive.stats().instances,0); assert.equal(health.activeImports,0);
  assert.ok(!JSON.stringify(unknown).includes('private path'));
});

test('strict private settings persist, require revisions and permit zero reserve',async t => {
  const { archive,health,dataDir } = await fixture(t);
  const before = health.settings;
  const saved = await thresholds(health,{reserveBytes:0,warningBytes:1024,maxConcurrentImports:2});
  assert.notEqual(saved.revision,before.revision); assert.equal(saved.reserveBytes,0);
  await assert.rejects(health.updateSettings(before),{statusCode:409,code:'stale-health-settings'});
  for (const changes of [{reserveBytes:-1},{reserveBytes:0.1},{warningBytes:-1},{maxConcurrentImports:0},{maxConcurrentImports:65},{secret:'no'}])
    await assert.rejects(health.updateSettings({...saved,...changes}),{statusCode:400});
  const getter = { ...saved }; Object.defineProperty(getter,'reserveBytes',{get(){throw Error('getter evaluated');},enumerable:true});
  await assert.rejects(health.updateSettings(getter),{statusCode:400});
  assert.equal((await stat(join(dataDir,'health-settings.json'))).mode & 0o777,0o600);
  await archive.close();
  const reopened = await Archive.open({dataDir});
  try { assert.deepEqual(reopened.health.settings,saved); } finally { await reopened.close(); }
});

test('serialized settings updates cannot both commit the same revision',async t => {
  const { health } = await fixture(t), current = { ...health.settings };
  const result = await Promise.allSettled([health.updateSettings({...current,reserveBytes:1}),health.updateSettings({...current,reserveBytes:2})]);
  assert.equal(result.filter(row => row.status === 'fulfilled').length,1);
  assert.equal(result.find(row => row.status === 'rejected').reason.code,'stale-health-settings');
});

test('live capacity check and writes serialize so concurrent chunks cannot spend the same free space',async t => {
  let free = 100, release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const { health } = await fixture(t,{capacity:async () => capacity(free)});
  await thresholds(health,{reserveBytes:0,warningBytes:0});
  const first = health.writeChunk(60,async () => { entered(); await gate; free -= 60; });
  await waiting;
  let secondWrote = false;
  const second = health.writeChunk(60,async () => { secondWrote = true; free -= 60; });
  assert.equal(health.reservedChunkBytes,60); release(); await first;
  await assert.rejects(second,{code:'insufficient-storage',statusCode:507});
  assert.equal(secondWrote,false); assert.equal(free,40); assert.equal(health.reservedChunkBytes,0);
  await health.writeChunk(40,async () => { free = 0; });
  assert.equal((await health.getSnapshot()).storage.reservedBytes,0);
});

test('intake concurrency is bounded centrally and capacity is reserved until parsing and durable commit finish',async t => {
  const { archive,health } = await fixture(t); await thresholds(health,{maxConcurrentImports:1});
  const source = new PassThrough(), first = archive.ingest(source);
  assert.equal(health.activeImports,1);
  assert.equal((await health.getSnapshot()).storage.reservedBytes,HEALTH_LIMITS.intakeOverheadBytes);
  await assert.rejects(archive.ingest(stream(createDicom())),{code:'intake-busy',statusCode:503});
  source.end(createDicom()); await first;
  assert.equal(health.activeImports,0);
  assert.equal((await archive.ingest(stream(createDicom()))).status,'stored');
});

test('space disappearing before commit rejects rather than acknowledging and leaves no catalog or partial',async t => {
  let free = 2*1024**3;
  const { archive,health,dataDir } = await fixture(t,{capacity:async () => capacity(free)});
  const bytes = createDicom();
  async function* source() { yield bytes; free = 0; }
  await assert.rejects(archive.ingest(Readable.from(source())),{code:'insufficient-storage',statusCode:507});
  assert.equal(archive.stats().instances,0); assert.equal(health.activeImports,0);
  assert.deepEqual(await readdir(join(dataDir,'spool')),[]); assert.deepEqual(await readdir(join(dataDir,'journal')),[]);
});

test('actual filesystem quota/full errors are controlled and never become a successful ingest',async t => {
  const { archive,health,dataDir } = await fixture(t), original = health.writeChunk.bind(health);
  health.writeChunk = (bytes,write) => original(bytes,bytes ? async () => { throw Object.assign(Error('private filesystem detail'),{code:'ENOSPC'}); } : write);
  await assert.rejects(archive.ingest(stream(createDicom())),{code:'insufficient-storage',statusCode:507});
  assert.equal(archive.stats().instances,0); assert.equal(health.activeImports,0);
  assert.deepEqual(await readdir(join(dataDir,'spool')),[]);
});

test('small writes use dynamic capacity instead of reserving the full maximum instance size',async t => {
  const { archive,health } = await fixture(t,{capacity:async () => capacity(32*1024**2)});
  await thresholds(health,{reserveBytes:0,warningBytes:0});
  assert.ok(archive.maxInstanceBytes > 32*1024**2);
  assert.equal((await archive.ingest(stream(createDicom()))).status,'stored');
});

test('private persistence failures preserve old settings; ambiguous durable rename pauses intake',async t => {
  let failure = false, renamed = false;
  const { archive,health } = await fixture(t,{writeJson:async (path,value) => {
    if (failure) throw Object.assign(Error('private path'),{healthWriteRenamed:renamed});
    return writePrivateJson(path,value);
  }});
  const old = { ...health.settings }; failure = true;
  await assert.rejects(thresholds(health,{reserveBytes:0})); assert.deepEqual(health.settings,old);
  assert.equal((await health.getSnapshot()).ready,true);
  renamed = true; await assert.rejects(thresholds(health,{reserveBytes:0}));
  assert.equal((await health.getSnapshot()).ready,false);
  await assert.rejects(archive.ingest(stream(createDicom())),{code:'health-unavailable'});
});

test('cached SQLite failure and recovery-required state both deny intake readiness',async t => {
  const { archive,health } = await fixture(t);
  const prepare = archive.db.prepare.bind(archive.db);
  archive.db.prepare = sql => sql === 'PRAGMA quick_check(1)' ? {all:() => [{quick_check:'corrupt private detail'}]} : prepare(sql);
  assert.equal(health.quickCheck().status,'error'); assert.equal((await health.getSnapshot()).ready,false);
  await assert.rejects(archive.ingest(stream(createDicom())),{code:'catalog-unhealthy'});
  archive.db.prepare = prepare; health.quickCheck(); archive.recoveryRequired = true;
  assert.equal((await health.getSnapshot()).recoveryRequired,true);
  await assert.rejects(archive.ingest(stream(createDicom())),{code:'recovery-required'});
  archive.recoveryRequired = false;
});

test('malformed private settings fail closed without silently restoring permissive defaults',async t => {
  const { archive,dataDir } = await fixture(t); await archive.close();
  await writeFile(join(dataDir,'health-settings.json'),JSON.stringify({reserveBytes:0}));
  await assert.rejects(Archive.open({dataDir}),{code:'invalid-health-settings'});
  assert.deepEqual(JSON.parse(await readFile(join(dataDir,'health-settings.json'),'utf8')),{reserveBytes:0});
});

test('zero configurable reserve does not report a completely full filesystem as intake-ready',async t => {
  let free = 32*1024**2;
  const {archive,health} = await fixture(t,{capacity:async () => capacity(free)});
  await thresholds(health,{reserveBytes:0,warningBytes:0});
  free = 0; const snapshot = await health.getSnapshot();
  assert.equal(snapshot.ready,false); assert.equal(snapshot.storage.status,'low'); assert.equal(snapshot.storage.reserveBytes,0);
  assert.equal(snapshot.storage.reservedBytes,0);
  await assert.rejects(archive.ingest(stream(createDicom())),{code:'insufficient-storage',statusCode:507});
  free = 16*1024**2; assert.equal((await health.getSnapshot()).ready,true);
});

test('JSON null or false private settings are invalid records, not missing-file defaults',async t => {
  const {archive,dataDir} = await fixture(t); await archive.close();
  for (const malformed of [null,false,0]) {
    await writeFile(join(dataDir,'health-settings.json'),JSON.stringify(malformed));
    await assert.rejects(Archive.open({dataDir}),{code:'invalid-health-settings'});
    assert.equal(await readFile(join(dataDir,'health-settings.json'),'utf8'),JSON.stringify(malformed));
  }
});
