import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Archive } from '../src/archive/Archive.js';
import { ConnectionService } from '../src/connections/ConnectionService.js';
import { transferDiagnostic } from '../src/jobs/TransferQueue.js';
import { createDicom, uid } from './fixtures/synthetic.js';

const error = (code, message = 'untrusted patient text and https://user:secret@peer.invalid/') => Object.assign(new Error(message), { code, statusCode: 502 });
const instance = (studyUid, seriesUid, options = {}) => {
  const identity = { studyUid, seriesUid, sopUid: uid(), sopClassUid: '1.2.840.10008.5.1.4.1.1.2', ...options };
  return { identity, bytes: createDicom({ ...identity, rows: 8, columns: 8, issuer: '' }) };
};
async function context(t, { coordinator, count = 3 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'easi-store-cmove-job-')), archive = await Archive.open({ dataDir });
  let activeService;
  const records = Array.from({ length: count }, () => instance('2.25.510001', '2.25.510002'));
  const calls = [], state = { available: true };
  const moveCoordinator = coordinator ?? {
    preflight() { if (!state.available) throw error('move-receiver-unavailable'); return { destinationAeTitle: 'LOCALSTORE', host: '127.0.0.1', port: 4248 }; },
    async retrieve(association, item, { signal, source }) {
      signal.throwIfAborted(); calls.push(item.sopUid);
      const found = records.find(record => record.identity.sopUid === item.sopUid); assert.ok(found);
      const outcome = await archive.ingest(Readable.from([found.bytes]), { source, expectedStudyUid: item.studyUid, expectedSeriesUid: item.seriesUid, expectedSopUid: item.sopUid, expectedSopClassUid: item.sopClassUid });
      assert.equal(association.calledAeTitle, 'REMOTE'); assert.equal(association.callingAeTitle, 'QUERYCALLER');
      assert.equal(source, `connection:${peer.id}`);
      return { status: 0, remaining: 0, completed: 1, failed: 0, stored: outcome.status === 'stored' ? 1 : 0, duplicates: outcome.status === 'duplicate' ? 1 : 0 };
    }
  };
  const service = activeService = await ConnectionService.open({ archive, autoStartJobs: false, moveCoordinator });
  service.enumerate = async () => records.map(record => record.identity);
  const peer = service.create({ name: 'Synthetic C-MOVE source', type: 'dimse', host: '127.0.0.1', port: 11112,
    calledAeTitle: 'REMOTE', callingAeTitle: 'QUERYCALLER', retrievalMethod: 'c-move' });
  t.after(async () => { await activeService.close(); await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { archive, service, peer, records, calls, state, moveCoordinator, replace(value) { activeService = value; },
    create() { return service.createJob({ connectionId: peer.id, direction: 'retrieve', selection: { studyUid: records[0].identity.studyUid } }); } };
}
async function run(service, job) {
  service.jobs.autoStart = true; service.jobs.start(); await service.jobs.running; service.jobs.autoStart = false;
  return service.jobs.get(job.id);
}

test('C-MOVE is explicit DIMSE-only configuration; older persisted peers retain C-GET without changing their revision', async t => {
  const c = await context(t);
  const legacy = c.service.create({ name: 'Default retrieval', type: 'dimse', host: '127.0.0.1', port: 11113, calledAeTitle: 'LEGACY' });
  assert.equal(legacy.retrievalMethod, 'c-get');
  const row = c.archive.db.prepare('SELECT config FROM connections WHERE id=?').get(legacy.id), config = JSON.parse(row.config); delete config.retrievalMethod;
  c.archive.db.prepare('UPDATE connections SET config=? WHERE id=?').run(JSON.stringify(config), legacy.id);
  assert.equal(c.service.get(legacy.id).retrievalMethod, 'c-get'); assert.equal(c.service.get(legacy.id).revision, 1);
  assert.throws(() => c.service.create({ ...config, retrievalMethod: 'automatic' }), /c-get or c-move/);
  assert.throws(() => c.service.create({ name: 'Web', type: 'dicomweb', baseUrl: 'http://127.0.0.1:11114', retrievalMethod: 'c-move' }), /only to DIMSE/);
  const next = new ConnectionService({ archive: c.archive, autoStartJobs: false }); next.initialize();
  assert.equal(next.get(c.peer.id).retrievalMethod, 'c-move'); assert.equal(next.get(legacy.id).retrievalMethod, 'c-get');
});

test('jobs cannot override the fixed runtime receive destination or supply network targets', async t => {
  const c = await context(t), selection = { studyUid: c.records[0].identity.studyUid };
  for (const key of ['moveDestinationAeTitle', 'destinationAeTitle', 'host', 'port', 'retrievalMethod']) {
    await assert.rejects(c.service.createJob({ connectionId: c.peer.id, direction: 'retrieve', selection, [key]: 'ARBITRARY' }), /Invalid transfer request/);
    await assert.rejects(c.service.createJob({ connectionId: c.peer.id, direction: 'retrieve', selection: { ...selection, [key]: 'ARBITRARY' } }), /Unexpected selection/);
  }
  assert.equal(c.service.jobs.list().items.length, 0);
});

test('missing or disabled receiver rejects retrieval before queueing, while the same peer can still send', async t => {
  const c = await context(t);
  c.service.configureMoveReceiver(null);
  await assert.rejects(c.create(), { code: 'move-receiver-unavailable', statusCode: 409 });
  assert.equal(c.service.jobs.list().items.length, 0);
  c.service.configureMoveReceiver(c.moveCoordinator); c.state.available = false;
  await assert.rejects(c.create(), e => e.code === 'move-receiver-unavailable' && e.message === transferDiagnostic(e).message);
  await c.archive.ingest(Readable.from([c.records[0].bytes]));
  const job = await c.service.createJob({ connectionId: c.peer.id, direction: 'send', selection: { studyUid: c.records[0].identity.studyUid } });
  assert.equal(job.state, 'queued'); assert.equal(job.total, 1); c.service.jobs.cancel(job.id);
});

test('a receiver lost after queueing fails before remote enumeration and can be explicitly retried', async t => {
  const c = await context(t), job = await c.create(); let enumerations = 0;
  const enumerate = c.service.enumerate; c.service.enumerate = (...args) => { enumerations++; return enumerate(...args); };
  c.state.available = false;
  const failed = await run(c.service, job);
  assert.equal(failed.state, 'failed'); assert.equal(failed.completed, 0); assert.equal(enumerations, 0);
  assert.equal(failed.message, transferDiagnostic({ code: 'move-receiver-unavailable' }).message);
  assert.throws(() => c.service.jobs.retry(job.id), { code: 'move-receiver-unavailable' });
  c.state.available = true; c.service.jobs.retry(job.id);
  assert.equal((await run(c.service, job)).completed, 3); assert.equal(enumerations, 1);
});

test('one C-MOVE per enumerated instance checkpoints only verified durable catalog objects', async t => {
  const c = await context(t), job = await c.create(), result = await run(c.service, job);
  assert.equal(result.state, 'completed'); assert.equal(result.total, 3); assert.equal(result.completed, 3); assert.equal(result.failed, 0);
  assert.deepEqual(c.calls, c.records.map(record => record.identity.sopUid));
  assert.equal(c.archive.stats().instances, 3);
  const items = c.archive.db.prepare('SELECT state,outcome,identity FROM transfer_items WHERE jobId=? ORDER BY position').all(job.id);
  assert.ok(items.every(item => item.state === 'done' && item.outcome === 'stored'));
  assert.ok(items.every(item => Object.keys(JSON.parse(item.identity)).sort().join(',') === 'seriesUid,sopClassUid,sopUid,studyUid'));
});

for (const code of ['move-callback-not-trusted', 'move-destination-unknown', 'move-no-callback', 'move-timeout', 'move-receiver-closed', 'move-peer-unavailable', 'move-state-failure']) test(`a ${code} failure retains its safe actionable diagnostic`, async t => {
  const c = await context(t, { count: 1 }); c.moveCoordinator.retrieve = async () => { throw error(code); };
  const job = await c.create(), result = await run(c.service, job);
  assert.equal(result.state, 'failed'); assert.equal(result.completed, 0); assert.equal(result.failed, 1);
  assert.equal(result.message, transferDiagnostic({ code }).message);
  assert.equal(c.archive.db.prepare('SELECT outcome FROM transfer_items WHERE jobId=?').get(job.id).outcome, code);
  assert.ok(!JSON.stringify(c.service.jobs.list()).includes('secret')); assert.ok(!JSON.stringify(c.service.jobs.list()).includes('untrusted patient'));
});

for (const wrongClass of [false, true]) test(`C-MOVE cannot checkpoint ${wrongClass ? 'a catalog object with a different SOP class' : 'a claimed success without a catalog object'}`, async t => {
  const c = await context(t, { count: 1 });
  if (wrongClass) await c.archive.ingest(Readable.from([createDicom({ ...c.records[0].identity, sopClassUid: '1.2.840.10008.5.1.4.1.1.4', rows: 8, columns: 8 })]));
  c.moveCoordinator.retrieve = async () => ({ status: 0, completed: 1, remaining: 0, stored: 1 });
  const job = await c.create(), result = await run(c.service, job);
  assert.equal(result.completed, 0); assert.equal(result.state, 'failed');
  assert.equal(result.message, transferDiagnostic({ code: 'move-object-missing' }).message);
});

test('manual C-MOVE retry keeps durable checkpoints and receives only the unfinished instance', async t => {
  const c = await context(t), receive = c.moveCoordinator.retrieve.bind(c.moveCoordinator); let fail = true; const attempts = [];
  c.moveCoordinator.retrieve = async (...args) => {
    attempts.push(args[1].sopUid);
    if (fail && args[1].sopUid === c.records[1].identity.sopUid) throw error('move-no-callback');
    return receive(...args);
  };
  const job = await c.create(), first = await run(c.service, job);
  assert.equal(first.completed, 2); assert.equal(first.failed, 1); assert.equal(first.state, 'failed');
  fail = false; c.service.jobs.retry(job.id); const second = await run(c.service, job);
  assert.equal(second.state, 'completed'); assert.equal(second.completed, 3); assert.equal(second.failed, 0);
  assert.deepEqual(attempts, [...c.records.map(record => record.identity.sopUid), c.records[1].identity.sopUid]);
});

test('a restarted C-MOVE job resumes interrupted items without replaying its durable checkpoint', async t => {
  const c = await context(t), job = await c.create();
  c.service.jobs.replaceItems(job.id, c.records.map(record => record.identity));
  await c.archive.ingest(Readable.from([c.records[0].bytes]), { source: `connection:${c.peer.id}` });
  c.archive.db.prepare("UPDATE transfer_jobs SET state='running',completed=1 WHERE id=?").run(job.id);
  c.archive.db.prepare("UPDATE transfer_items SET state='done' WHERE jobId=? AND position=0").run(job.id);
  c.archive.db.prepare("UPDATE transfer_items SET state='running' WHERE jobId=? AND position=1").run(job.id);
  const next = new ConnectionService({ archive: c.archive, moveCoordinator: c.moveCoordinator, autoStartJobs: false }); next.initialize(); c.replace(next);
  assert.equal(next.jobs.get(job.id).state, 'queued'); const result = await run(next, job);
  assert.equal(result.state, 'completed'); assert.equal(result.completed, 3); assert.deepEqual(c.calls, c.records.slice(1).map(record => record.identity.sopUid));
});

test('persisted queued C-MOVE jobs stay idle until the runtime receiver is attached and startup is enabled', async t => {
  const c = await context(t), job = await c.create();
  await c.service.close();
  const next = await ConnectionService.open({ archive: c.archive, autoStartJobs: false }); c.replace(next);
  let enumerated = 0; next.enumerate = async () => { enumerated++; return c.records.map(record => record.identity); };
  assert.equal(next.jobs.get(job.id).state, 'queued'); assert.equal(next.jobs.running, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(enumerated, 0); assert.deepEqual(c.calls, []);
  next.configureMoveReceiver(c.moveCoordinator);
  const result = await run(next, job);
  assert.equal(result.state, 'completed'); assert.equal(result.completed, 3); assert.equal(enumerated, 1);
});

test('canceling C-MOVE retains accepted objects and retry skips them', async t => {
  const c = await context(t), receive = c.moveCoordinator.retrieve.bind(c.moveCoordinator); let entered, pause = true;
  const blocked = new Promise(resolve => { entered = resolve; });
  c.moveCoordinator.retrieve = async (...args) => {
    if (pause && args[1].sopUid === c.records[1].identity.sopUid) {
      const { signal } = args[2]; entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return receive(...args);
  };
  const job = await c.create(); c.service.jobs.autoStart = true; c.service.jobs.start(); await blocked;
  assert.equal(c.service.jobs.get(job.id).completed, 1); c.service.jobs.cancel(job.id); await c.service.jobs.running; c.service.jobs.autoStart = false;
  assert.equal(c.service.jobs.get(job.id).state, 'canceled'); assert.equal(c.archive.stats().instances, 1);
  pause = false; c.service.jobs.retry(job.id); const result = await run(c.service, job);
  assert.equal(result.completed, 3); assert.equal(c.calls.filter(value => value === c.records[0].identity.sopUid).length, 1);
});

test('C-MOVE failures stop after three consecutive instances and destination changes invalidate retries', async t => {
  const c = await context(t, { count: 5 }); let calls = 0;
  c.moveCoordinator.retrieve = async () => { calls++; throw error('move-no-callback'); };
  const job = await c.create(), result = await run(c.service, job);
  assert.equal(calls, 3); assert.equal(result.total, 5); assert.equal(result.failed, 3); assert.equal(result.completed, 0);
  assert.equal(c.archive.db.prepare("SELECT COUNT(*) AS count FROM transfer_items WHERE jobId=? AND state='pending'").get(job.id).count, 2);
  c.service.update(c.peer.id, { name: 'Changed retrieval', type: 'dimse', host: '127.0.0.1', port: 11112, calledAeTitle: 'REMOTE', retrievalMethod: 'c-get' });
  assert.throws(() => c.service.jobs.retry(job.id), /connection changed/);
});

test('untrusted errors including HTTP 4xx cannot become persisted job messages', async t => {
  const c = await context(t, { count: 1 });
  c.service.enumerate = async () => { throw Object.assign(new Error('sensitive patient details https://user:secret@peer.invalid/'), { statusCode: 400 }); };
  const job = await c.create(), result = await run(c.service, job);
  assert.equal(result.state, 'failed'); assert.equal(result.message, 'The peer transfer could not complete. Check its connection and retry unfinished instances.');
  assert.ok(!JSON.stringify(c.service.jobs.list()).includes('secret')); assert.ok(!JSON.stringify(c.service.jobs.list()).includes('patient details'));
});
