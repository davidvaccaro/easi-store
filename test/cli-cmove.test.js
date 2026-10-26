import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Archive } from '../src/archive/Archive.js';
import { Auth } from '../src/http/Auth.js';
import { ConnectionService } from '../src/connections/ConnectionService.js';
import { StorageScp } from '../src/dimse/StorageScp.js';
import { dataSetOffset } from '../src/dimse/wire.js';
import { transferDiagnostic } from '../src/jobs/TransferQueue.js';
import { createDicom, uid } from './fixtures/synthetic.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function unusedPort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function launch(t, args) {
  // Explicit synthetic paths/config only; a developer's Store environment must
  // not redirect this child to their archive or private credentials file.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EASI_STORE_')));
  const child = spawn(process.execPath, [cli, 'start', ...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', stopping;
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-65536); });
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-65536); });
  const exited = once(child, 'exit');
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      assert.equal(child.kill('SIGTERM'), true);
      let timer;
      const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 6000); })]);
      clearTimeout(timer);
      if (!result) { await exited; throw new Error('Synthetic CLI did not shut down within six seconds.'); }
      const [code, signal] = result;
      if (process.platform === 'win32' && (signal === 'SIGTERM' || code === 1 && signal === null)) return;
      assert.equal(code, 0, errors); assert.equal(signal, null, errors);
    })();
    return stopping;
  };
  t.after(stop);
  for (let attempt = 0; attempt < 500; attempt++) {
    if (output.includes('Client access:')) return { child, stop };
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Synthetic CLI exited during startup: ' + errors);
    await sleep(20);
  }
  throw new Error('Synthetic CLI did not become ready within ten seconds.');
}
async function waitForJob(base, id, token) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`${base}/api/v1/jobs/${id}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200); const job = await response.json();
    if (['completed', 'failed', 'canceled'].includes(job.state)) return job;
    await sleep(25);
  }
  throw new Error('Synthetic persisted transfer did not settle within five seconds.');
}
async function within(promise, message, milliseconds = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

for (const receiverEnabled of [true, false]) test(`CLI resumes persisted C-MOVE ${receiverEnabled ? 'after attaching its existing receiver' : 'with a useful failure when --no-dimse is selected'}`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'easi-store-cli-cmove-'));
  const targetDirectory = join(directory, 'target'), remote = await Archive.open({ dataDir: join(directory, 'source') });
  const httpPort = await unusedPort(), dimsePort = await unusedPort(), studyUid = uid(), seriesUid = uid();
  let remoteQueries = 0, serverProcess;
  const source = new StorageScp({ archive: remote, auth: { record: {} }, aeTitle: 'CLISOURCE', port: 0,
    resolveMoveDestination: ae => ae === 'CLITARGET' ? { host: '127.0.0.1', port: dimsePort, calledAeTitle: 'CLITARGET', callingAeTitle: 'CLISOURCE' } : null });
  const query = source.query.bind(source); source.query = (...args) => { remoteQueries++; return query(...args); };
  const address = await source.listen();
  t.after(async () => { await serverProcess?.stop(); await source.close(); await remote.close(); await rm(directory, { recursive: true, force: true }); });
  for (const instanceNumber of [1, 2]) await remote.ingest(Readable.from([createDicom({ studyUid, seriesUid, instanceNumber, rows: 8, columns: 8, issuer: '' })]));

  const target = await Archive.open({ dataDir: targetDirectory });
  const offlineCoordinator = { preflight: () => ({ destinationAeTitle: 'CLITARGET', host: '127.0.0.1', port: dimsePort }), retrieve: () => assert.fail('The offline seed must not start a transfer.') };
  const service = await ConnectionService.open({ archive: target, autoStartJobs: false, moveCoordinator: offlineCoordinator });
  let job, token;
  try {
    const peer = service.create({ name: 'Synthetic CLI source', type: 'dimse', host: '127.0.0.1', port: address.port,
      calledAeTitle: 'CLISOURCE', callingAeTitle: 'CLIQUERY', retrievalMethod: 'c-move', timeoutMs: 3000 });
    job = await service.createJob({ connectionId: peer.id, direction: 'retrieve', selection: { studyUid } });
    assert.equal(job.state, 'queued'); assert.equal(service.jobs.running, null); assert.equal(remoteQueries, 0);
    const auth = await new Auth(targetDirectory).open(); await auth.setup({ username: 'synthetic', password: 'synthetic-cli-password' }, '127.0.0.1');
    token = await auth.issueApiToken('Disposable CLI test');
  } finally { await service.close(); await target.close(); }

  const args = ['--data-dir', targetDirectory, '--host', '127.0.0.1', '--port', String(httpPort), '--dimse-host', '127.0.0.1',
    '--dimse-port', String(dimsePort), '--ae-title', 'CLITARGET', '--access-profile', 'local-research'];
  if (!receiverEnabled) args.push('--no-dimse');
  serverProcess = await launch(t, args);
  const base = `http://127.0.0.1:${httpPort}`;
  assert.equal((await fetch(base + '/api/health')).status, 200);
  const capabilitiesResponse = await fetch(base + '/api/v1/capabilities', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(capabilitiesResponse.status, 200); const capabilities = await capabilitiesResponse.json();
  assert.equal(capabilities.dimse.enabled, receiverEnabled); assert.ok(capabilities.dimse.retrievalMethods.includes('c-move'));
  if (receiverEnabled) { assert.equal(capabilities.dimse.aeTitle, 'CLITARGET'); assert.equal(capabilities.dimse.port, dimsePort); }
  const result = await waitForJob(base, job.id, token);
  assert.equal(serverProcess.child.exitCode, null, 'job failure must not terminate the CLI');
  if (receiverEnabled) {
    assert.equal(result.state, 'completed', result.message); assert.equal(result.completed, 2); assert.equal(result.failed, 0); assert.ok(remoteQueries >= 4);
  } else {
    assert.equal(result.state, 'failed'); assert.equal(result.completed, 0); assert.equal(remoteQueries, 0);
    assert.equal(result.message, transferDiagnostic({ code: 'move-receiver-unavailable' }).message);
  }
  await serverProcess.stop();
  const persisted = await Archive.open({ dataDir: targetDirectory });
  try {
    const checkpoint = persisted.db.prepare('SELECT state,completed,failed FROM transfer_jobs WHERE id=?').get(job.id);
    assert.equal(checkpoint.state, result.state); assert.equal(checkpoint.completed, result.completed);
    assert.equal(persisted.stats().instances, receiverEnabled ? 2 : 0);
    if (receiverEnabled) {
      const items = persisted.db.prepare('SELECT state FROM transfer_items WHERE jobId=?').all(job.id);
      assert.ok(items.every(item => item.state === 'done'));
      for (const record of remote.queryRecords()) {
        const original = remote.getInstance(record.studyUid, record.seriesUid, record.sopUid), received = persisted.getInstance(record.studyUid, record.seriesUid, record.sopUid);
        const before = (await readFile(original.path)).subarray(await dataSetOffset(original.path)), after = (await readFile(received.path)).subarray(await dataSetOffset(received.path));
        assert.equal(createHash('sha256').update(after).digest('hex'), createHash('sha256').update(before).digest('hex'));
        assert.equal(createHash('sha256').update(await readFile(received.path)).digest('hex'), received.sha256);
      }
    }
  } finally { await persisted.close(); }
});

test('CLI interruption preserves unfinished C-MOVE work and a later startup retrieves it', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'easi-store-cli-cmove-resume-'));
  const targetDirectory = join(directory, 'target'), remote = await Archive.open({ dataDir: join(directory, 'source') });
  const httpPort = await unusedPort(), dimsePort = await unusedPort(), studyUid = uid(), seriesUid = uid();
  let serverProcess, releaseFirstMove, firstMoveEntered, firstMoveSettled, moveRequests = 0, firstDestination = true;
  const gate = new Promise(resolve => { releaseFirstMove = resolve; });
  const entered = new Promise(resolve => { firstMoveEntered = resolve; });
  const settled = new Promise(resolve => { firstMoveSettled = resolve; });
  const source = new StorageScp({ archive: remote, auth: { record: {} }, aeTitle: 'CLISOURCE', port: 0,
    resolveMoveDestination: async ae => {
      if (firstDestination) { firstDestination = false; firstMoveEntered(); await gate; }
      return ae === 'CLITARGET' ? { host: '127.0.0.1', port: dimsePort, calledAeTitle: 'CLITARGET', callingAeTitle: 'CLISOURCE' } : null;
    } });
  const query = source.query.bind(source);
  source.query = async (...args) => {
    const first = args[2].command.field === 0x21 && ++moveRequests === 1;
    try { return await query(...args); }
    finally { if (first) firstMoveSettled(); }
  };
  const address = await source.listen();
  t.after(async () => {
    releaseFirstMove(); await serverProcess?.stop(); await source.close(); await remote.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const instanceNumber of [1, 2]) await remote.ingest(Readable.from([createDicom({ studyUid, seriesUid, instanceNumber, rows: 8, columns: 8, issuer: '' })]));

  const target = await Archive.open({ dataDir: targetDirectory });
  const offlineCoordinator = { preflight: () => ({ destinationAeTitle: 'CLITARGET', host: '127.0.0.1', port: dimsePort }), retrieve: () => assert.fail('The offline seed must not start a transfer.') };
  const service = await ConnectionService.open({ archive: target, autoStartJobs: false, moveCoordinator: offlineCoordinator });
  let job, token;
  try {
    const peer = service.create({ name: 'Synthetic restart source', type: 'dimse', host: '127.0.0.1', port: address.port,
      calledAeTitle: 'CLISOURCE', callingAeTitle: 'CLIQUERY', retrievalMethod: 'c-move', timeoutMs: 5000 });
    job = await service.createJob({ connectionId: peer.id, direction: 'retrieve', selection: { studyUid } });
    const auth = await new Auth(targetDirectory).open(); await auth.setup({ username: 'synthetic', password: 'synthetic-cli-password' }, '127.0.0.1');
    token = await auth.issueApiToken('Disposable CLI restart test');
  } finally { await service.close(); await target.close(); }
  const args = ['--data-dir', targetDirectory, '--host', '127.0.0.1', '--port', String(httpPort), '--dimse-host', '127.0.0.1',
    '--dimse-port', String(dimsePort), '--ae-title', 'CLITARGET', '--access-profile', 'local-research'];
  const base = `http://127.0.0.1:${httpPort}`;
  serverProcess = await launch(t, args);
  await within(entered, 'The first real C-MOVE did not reach the synthetic source.');
  const activeResponse = await fetch(`${base}/api/v1/jobs/${job.id}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
  assert.equal(activeResponse.status, 200); const active = await activeResponse.json();
  assert.equal(active.state, 'running'); assert.equal(active.total, 2); assert.equal(active.completed, 0);
  // The source has received the control request but cannot issue any storage
  // callback until released. Shutdown must pause the queue before the receiver.
  await serverProcess.stop();
  releaseFirstMove();
  await within(settled, 'The interrupted source association did not unwind.');
  const interrupted = await Archive.open({ dataDir: targetDirectory });
  try {
    const checkpoint = interrupted.db.prepare('SELECT state,total,completed,failed,message FROM transfer_jobs WHERE id=?').get(job.id);
    const items = interrupted.db.prepare('SELECT state,outcome FROM transfer_items WHERE jobId=?').all(job.id);
    if (process.platform === 'win32') {
      // Windows terminates a child on SIGTERM instead of invoking its handler;
      // the next startup must recover this possible in-flight checkpoint.
      assert.ok(['running', 'queued'].includes(checkpoint.state));
      assert.ok(items.every(item => ['running', 'pending'].includes(item.state)));
    } else {
      assert.equal(checkpoint.state, 'queued'); assert.equal(checkpoint.message, 'Paused for shutdown; resumes on restart.');
      assert.ok(items.every(item => item.state === 'pending' && item.outcome === ''));
    }
    assert.equal(checkpoint.total, 2); assert.equal(checkpoint.completed, 0); assert.equal(checkpoint.failed, 0);
    assert.equal(interrupted.stats().instances, 0); assert.equal(moveRequests, 1);
  } finally { await interrupted.close(); }

  serverProcess = await launch(t, args);
  const result = await waitForJob(base, job.id, token);
  assert.equal(result.state, 'completed', result.message); assert.equal(result.total, 2); assert.equal(result.completed, 2); assert.equal(result.failed, 0);
  assert.equal(moveRequests, 3, 'the canceled control request and two resumed instance requests must all be observed');
  await serverProcess.stop();
  const resumed = await Archive.open({ dataDir: targetDirectory });
  try {
    assert.equal(resumed.stats().instances, 2);
    assert.ok(resumed.db.prepare('SELECT state FROM transfer_items WHERE jobId=?').all(job.id).every(item => item.state === 'done'));
    for (const record of remote.queryRecords()) {
      const original = remote.getInstance(record.studyUid, record.seriesUid, record.sopUid), received = resumed.getInstance(record.studyUid, record.seriesUid, record.sopUid);
      const before = (await readFile(original.path)).subarray(await dataSetOffset(original.path)), after = (await readFile(received.path)).subarray(await dataSetOffset(received.path));
      assert.equal(createHash('sha256').update(after).digest('hex'), createHash('sha256').update(before).digest('hex'));
      assert.equal(createHash('sha256').update(await readFile(received.path)).digest('hex'), received.sha256);
    }
  } finally { await resumed.close(); }
});
