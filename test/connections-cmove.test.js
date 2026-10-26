import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { Archive } from '../src/archive/Archive.js';
import { ConnectionService } from '../src/connections/ConnectionService.js';
import { MoveCoordinator } from '../src/dimse/MoveCoordinator.js';
import { StorageScp } from '../src/dimse/StorageScp.js';
import { dataSetOffset } from '../src/dimse/wire.js';
import { transferDiagnostic } from '../src/jobs/TransferQueue.js';
import { createDicom, uid } from './fixtures/synthetic.js';

async function context(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'easi-store-queued-cmove-'));
  const remote = await Archive.open({ dataDir: join(dataDir, 'remote') }), local = await Archive.open({ dataDir: join(dataDir, 'local') });
  const coordinator = new MoveCoordinator({ archive: local }), controls = { mapped: true, trusted: true, moveCommands: 0 };
  const receiver = new StorageScp({ archive: local, auth: { record: {} }, port: 0, aeTitle: 'LOCALSTORE', moveCoordinator: coordinator,
    associationPolicy: ({ callingAeTitle, remoteAddress }) => controls.trusted && callingAeTitle === 'REMOTEARCHIVE' && remoteAddress === '127.0.0.1' });
  const receiveAddress = await receiver.listen();
  const source = new StorageScp({ archive: remote, auth: { record: {} }, port: 0, aeTitle: 'REMOTEARCHIVE',
    resolveMoveDestination: ae => controls.mapped && ae === 'LOCALSTORE' ? { host: '127.0.0.1', port: receiveAddress.port, calledAeTitle: 'LOCALSTORE', callingAeTitle: 'REMOTEARCHIVE', timeoutMs: 5000 } : null });
  const query = source.query.bind(source); source.query = (...args) => { if (args[2].command.field === 0x21) controls.moveCommands++; return query(...args); };
  const sourceAddress = await source.listen();
  const service = await ConnectionService.open({ archive: local, moveCoordinator: coordinator, autoStartJobs: false });
  t.after(async () => { await service.close(); await coordinator.close(); await source.close(); await receiver.close(); await remote.close(); await local.close(); await rm(dataDir, { recursive: true, force: true }); });
  const studyUid = uid(), seriesUid = uid();
  for (const instanceNumber of [1, 2]) await remote.ingest(Readable.from([createDicom({ studyUid, seriesUid, instanceNumber, rows: 8, columns: 8, issuer: '' })]));
  const peer = service.create({ name: 'Synthetic remote source', type: 'dimse', host: '127.0.0.1', port: sourceAddress.port,
    calledAeTitle: 'REMOTEARCHIVE', callingAeTitle: 'QUEUEQUERY', retrievalMethod: 'c-move', timeoutMs: 5000 });
  return { remote, local, service, peer, coordinator, controls, studyUid, seriesUid,
    create() { return service.createJob({ connectionId: peer.id, direction: 'retrieve', selection: { studyUid } }); } };
}
async function run(service, job) {
  service.jobs.autoStart = true; service.jobs.start(); await service.jobs.running; service.jobs.autoStart = false;
  return service.jobs.get(job.id);
}

test('configured queued C-MOVE enumerates each instance and durably receives through the existing trusted Storage SCP', { timeout: 20000 }, async t => {
  const c = await context(t), job = await c.create(), result = await run(c.service, job);
  assert.equal(result.state, 'completed', result.message); assert.equal(result.completed, 2); assert.equal(result.failed, 0);
  assert.equal(c.controls.moveCommands, 2); assert.equal(c.local.stats().instances, 2);
  assert.equal(c.coordinator.getState().active, 0); assert.equal(c.local.importReservations.size, 0);
  for (const remote of c.remote.queryRecords()) {
    const before = c.remote.getInstance(remote.studyUid, remote.seriesUid, remote.sopUid), after = c.local.getInstance(remote.studyUid, remote.seriesUid, remote.sopUid);
    assert.equal(after.source, `connection:${c.peer.id}`);
    const beforeData = (await readFile(before.path)).subarray(await dataSetOffset(before.path));
    const afterData = (await readFile(after.path)).subarray(await dataSetOffset(after.path));
    assert.equal(createHash('sha256').update(afterData).digest('hex'), createHash('sha256').update(beforeData).digest('hex'));
  }
  const repeated = await run(c.service, await c.create());
  assert.equal(repeated.state, 'completed'); assert.equal(repeated.completed, 2); assert.equal(c.local.stats().instances, 2);
  const items = c.local.db.prepare('SELECT outcome FROM transfer_items WHERE jobId=?').all(repeated.id);
  assert.ok(items.every(item => item.outcome === 'duplicate'));
});

test('a missing remote receive-AE mapping produces an actionable persisted error and manual retry succeeds after explicit repair', { timeout: 20000 }, async t => {
  const c = await context(t); c.controls.mapped = false;
  const job = await c.create(), result = await run(c.service, job);
  assert.equal(result.state, 'failed'); assert.equal(result.completed, 0); assert.equal(result.failed, 2); assert.equal(c.local.stats().instances, 0);
  assert.equal(result.message, transferDiagnostic({ code: 'move-destination-unknown' }).message);
  c.controls.mapped = true; c.service.jobs.retry(job.id);
  const retried = await run(c.service, job); assert.equal(retried.state, 'completed'); assert.equal(retried.completed, 2);
});

test('C-MOVE callback policy is checked before sending MOVE and never automatically widens receiver trust', { timeout: 20000 }, async t => {
  const c = await context(t); c.controls.trusted = false;
  const job = await c.create(), result = await run(c.service, job);
  assert.equal(result.state, 'failed'); assert.equal(result.completed, 0); assert.equal(c.controls.moveCommands, 0);
  assert.equal(result.message, transferDiagnostic({ code: 'move-callback-not-trusted' }).message);
  assert.equal(c.controls.trusted, false); assert.equal(c.local.stats().instances, 0);
  c.controls.trusted = true; c.service.jobs.retry(job.id);
  assert.equal((await run(c.service, job)).completed, 2);
});
