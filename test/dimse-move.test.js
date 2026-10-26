import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Archive } from '../src/archive/Archive.js';
import { StorageScp, sendStoredInstance } from '../src/dimse/StorageScp.js';
import { MoveCoordinator } from '../src/dimse/MoveCoordinator.js';
import { createDicom, uid } from './fixtures/synthetic.js';
import { dataSetOffset, commandBytes, u16, text, send, sendMessage, pdu } from '../src/dimse/wire.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { behavior, sourceHost = '127.0.0.1', policy } = {}) {
  const directories = [], servers = [], archives = []; let coordinator;
  t.after(async () => {
    await Promise.all(servers.map(server => server.close())); await coordinator?.close();
    await Promise.all(archives.map(archive => archive.close()));
    await Promise.all(directories.map(path => rm(path, { recursive: true, force: true })));
  });
  const open = async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'easi-store-move-')); directories.push(dataDir);
    const archive = await Archive.open({ dataDir }); archives.push(archive); return archive;
  };
  const target = await open(), source = await open(); coordinator = new MoveCoordinator({ archive: target });
  const receiver = new StorageScp({ archive: target, auth: { record: {} }, port: 0, moveCoordinator: coordinator,
    ...(policy ? { associationPolicy: policy } : {}) });
  const destination = await receiver.listen(); servers.push(receiver);
  const callback = { host: '127.0.0.1', port: destination.port, calledAeTitle: 'EASISTORE', callingAeTitle: 'REMOTEPACS', timeoutMs: 1500 };
  class ScriptedScp extends StorageScp {
    async query(socket, context, operation, bytes) {
      if (operation.command.field !== 0x21 || !behavior) return super.query(socket, context, operation, bytes);
      return behavior({ scp: this, socket, context, operation, bytes, callback, source, target, coordinator });
    }
  }
  const remote = new ScriptedScp({ archive: source, auth: { record: {} }, host: sourceHost, port: 0, aeTitle: 'REMOTEPACS',
    resolveMoveDestination: ae => ae === callback.calledAeTitle ? callback : null });
  const address = await remote.listen(); servers.push(remote);
  const association = { host: sourceHost, port: address.port, calledAeTitle: 'REMOTEPACS', callingAeTitle: 'EASISTORE', timeoutMs: 1500 };
  const selection = { studyUid: uid(), seriesUid: uid(), sopUid: uid(), sopClassUid: '1.2.840.10008.5.1.4.1.1.2' };
  const original = createDicom(selection); await source.ingest(Readable.from([original]));
  const record = source.getInstance(selection.studyUid, selection.seriesUid, selection.sopUid);
  return { target, source, coordinator, receiver, remote, callback, association, selection, record, original };
}
async function callbackStore(f, overrides = {}) {
  const record = f.source.queryRecords()[0], original = f.source.getInstance(record.studyUid, record.seriesUid, record.sopUid);
  return sendStoredInstance({ ...f.callback, ...overrides.association }, { ...original, ...overrides.record }, {
    moveOriginatorAeTitle: overrides.originator ?? f.context.callingAeTitle,
    moveOriginatorMessageId: overrides.messageId ?? f.operation.command.messageId
  });
}
async function final(f, status = 0, counts = { completed: 1, failed: 0, warning: 0, remaining: 0 }) {
  return f.scp.respond(f.socket, f.context, f.operation.id, f.operation.command, status, { counts });
}

test('C-MOVE uses the existing durable receiver, preserves dataset bytes/source scope and detects duplicate retries', { timeout: 10000 }, async t => {
  const f = await fixture(t), source = 'connection:synthetic-peer';
  const result = await f.coordinator.retrieve(f.association, f.selection, { source });
  assert.equal(result.status, 0); assert.equal(result.stored, 1); assert.equal(result.completed, 1);
  const stored = f.target.getInstance(f.selection.studyUid, f.selection.seriesUid, f.selection.sopUid);
  assert.equal(stored.source, source);
  assert.deepEqual((await readFile(stored.path)).subarray(await dataSetOffset(stored.path)),
    (await readFile(f.record.path)).subarray(await dataSetOffset(f.record.path)));
  const repeated = await f.coordinator.retrieve(f.association, f.selection, { source });
  assert.equal(repeated.duplicates, 1); assert.equal(repeated.stored, 0); assert.equal(f.target.stats().instances, 1);
  assert.equal(f.coordinator.getState().active, 0); assert.equal(f.target.importReservations.size, 0);
});

test('C-MOVE success permits omitted optional final counts but requires a matching persisted callback', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.remote.query = async (socket, context, operation) => {
    await callbackStore({ socket, context, operation, callback: f.callback, source: f.source });
    await f.remote.respond(socket, context, operation.id, operation.command, 0);
  };
  assert.equal((await f.coordinator.retrieve(f.association, f.selection)).stored, 1);
});

test('C-MOVE waits for durable persistence before callback ACK and verified completion', { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), gate = deferred(), ingest = f.target.ingest.bind(f.target);
  t.after(() => gate.resolve());
  f.target.ingest = async (...args) => { entered.resolve(); await gate.promise; return ingest(...args); };
  const operation = f.coordinator.retrieve(f.association, f.selection); operation.catch(() => {});
  await entered.promise;
  assert.equal(f.target.stats().instances, 0); assert.equal(f.target.importReservations.size, 2);
  assert.equal(await Promise.race([operation.then(() => 'completed'), new Promise(resolve => setTimeout(() => resolve('waiting'), 50))]), 'waiting');
  gate.resolve(); assert.equal((await operation).stored, 1); assert.equal(f.target.importReservations.size, 0);
});

for (const mismatch of ['originator', 'messageId', 'callingAeTitle', 'sopUid', 'sopClassUid']) {
  test(`C-MOVE refuses an uncorrelated ${mismatch} callback without archive admission`, { timeout: 10000 }, async t => {
    let callbackStatus;
    const f = await fixture(t, { behavior: async state => {
      const overrides = mismatch === 'originator' ? { originator: 'OTHER_ORIGIN' }
        : mismatch === 'messageId' ? { messageId: state.operation.command.messageId % 65535 + 1 }
        : mismatch === 'callingAeTitle' ? { association: { callingAeTitle: 'OTHER_SOURCE' } }
        : mismatch === 'sopUid' ? { record: { sopUid: uid() } }
        : mismatch === 'sopClassUid' ? { record: { sopClassUid: '1.2.840.10008.5.1.4.1.1.4' } } : {};
      callbackStatus = (await callbackStore(state, overrides)).status; await final(state);
    } });
    await assert.rejects(f.coordinator.retrieve(f.association, f.selection), { code: 'move-no-callback' });
    assert.notEqual(callbackStatus, 0); assert.equal(f.target.stats().instances, 0);
    assert.deepEqual(await readdir(join(f.target.dataDir, 'spool')), []);
  });
}

test('active C-MOVE rejects a callback address differing from its actual control socket without requiring IPv6', { timeout: 10000 }, async t => {
  let checked = false;
  const f = await fixture(t, { behavior: async state => {
    const record = state.source.queryRecords()[0];
    // Exercise the address guard against an actual, active IPv4 C-MOVE. A
    // supplied mismatching peer address avoids requiring an extra loopback
    // alias or IPv6 support from Docker/the host operating system.
    assert.throws(() => state.coordinator.claimStore({
      command: { moveOriginatorAeTitle: state.context.callingAeTitle, moveOriginatorMessageId: state.operation.command.messageId,
        sopUid: record.sopUid, sopClassUid: record.sopClassUid },
      callingAeTitle: state.callback.callingAeTitle, remoteAddress: '192.0.2.23', cancel: () => assert.fail('an unrelated address must not claim the operation')
    }), { code: 'move-protocol-error' });
    checked = true; assert.equal(state.target.stats().instances, 0);
    assert.equal((await callbackStore(state)).status, 0); await final(state);
  } });
  assert.equal((await f.coordinator.retrieve(f.association, f.selection)).stored, 1);
  assert.equal(checked, true); assert.equal(f.target.stats().instances, 1);
});

for (const field of ['studyUid', 'seriesUid']) test(`C-MOVE rejects callback dataset ${field} mismatch before catalog admission`, { timeout: 10000 }, async t => {
  let foreignPath;
  const f = await fixture(t, { behavior: async state => {
    const status = (await callbackStore(state, { record: { path: foreignPath } })).status;
    assert.notEqual(status, 0); await final(state, 0xb000, { completed: 0, failed: 1, warning: 0, remaining: 0 });
  } });
  foreignPath = join(f.source.dataDir, 'generated-wrong-hierarchy.dcm');
  await writeFile(foreignPath, createDicom({ ...f.selection, [field]: uid() }));
  await assert.rejects(f.coordinator.retrieve(f.association, f.selection), { code: 'move-receive-failure' });
  assert.equal(f.target.stats().instances, 0); assert.equal(f.target.importReservations.size, 0);
});

test('receiver AE/IP policy is checked before C-MOVE and is never widened by an outbound connection', { timeout: 10000 }, async t => {
  let commands = 0;
  const f = await fixture(t, { policy: () => false, behavior: async () => { commands++; } });
  await assert.rejects(f.coordinator.retrieve(f.association, f.selection), { code: 'move-callback-not-trusted' });
  assert.equal(commands, 0); assert.equal(f.target.stats().instances, 0); assert.equal(f.target.importReservations.size, 0);
});

test('late C-MOVE callbacks are rejected after cancellation while unrelated ordinary Storage remains usable', { timeout: 10000 }, async t => {
  const entered = deferred(); let request;
  const f = await fixture(t, { behavior: async state => {
    request = state; entered.resolve();
    await new Promise(resolve => state.operation.abort.signal.addEventListener('abort', resolve, { once: true }));
  } });
  const controller = new AbortController(), operation = f.coordinator.retrieve(f.association, f.selection, { signal: controller.signal });
  operation.catch(() => {}); await entered.promise; controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(f.coordinator.active.size, 0); assert.equal(f.target.importReservations.size, 0);
  assert.notEqual((await callbackStore(request)).status, 0); assert.equal(f.target.stats().instances, 0);
  assert.equal((await sendStoredInstance(f.callback, f.record)).status, 0);
  assert.equal(f.target.stats().instances, 1);
});

test('a no-callback deadline is bounded and reports actionable receiver configuration guidance', { timeout: 10000 }, async t => {
  const f = await fixture(t, { behavior: async state => {
    await new Promise(resolve => state.operation.abort.signal.addEventListener('abort', resolve, { once: true }));
  } });
  const started = Date.now();
  await assert.rejects(f.coordinator.retrieve({ ...f.association, timeoutMs: 100 }, f.selection), { code: 'move-no-callback' });
  assert.ok(Date.now() - started < 1500); assert.equal(f.coordinator.active.size, 0);
  assert.equal(f.target.importReservations.size, 0); assert.equal(f.target.stats().instances, 0);
});

for (const status of [0xa801, 0xa700, 0xfe00]) test(`C-MOVE final failure 0x${status.toString(16)} is not a successful transfer`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { behavior: async state => final(state, status, { completed: 0, failed: 0, warning: 0, remaining: 1 }) });
  await assert.rejects(f.coordinator.retrieve(f.association, f.selection), { code: status === 0xa801 ? 'move-destination-unknown' : 'move-peer-failure', dimseStatus: status });
  assert.equal(f.target.stats().instances, 0);
});

test('successful final counts cannot conceal an omitted callback or contradict persisted sub-operations', { timeout: 10000 }, async t => {
  const f = await fixture(t, { behavior: async state => final(state) });
  await assert.rejects(f.coordinator.retrieve(f.association, f.selection), { code: 'move-no-callback' });
  assert.equal(f.target.stats().instances, 0);
  f.remote.query = async (socket, context, operation) => {
    await callbackStore({ socket, context, operation, callback: f.callback, source: f.source });
    await f.remote.respond(socket, context, operation.id, operation.command, 0, { counts: { completed: 0, failed: 0, warning: 0, remaining: 0 } });
  };
  await assert.rejects(f.coordinator.retrieve(f.association, f.selection), { code: 'move-protocol-error' });
  assert.equal(f.target.stats().instances, 1, 'a committed callback is retained even if the remote final response is inconsistent');
});

test('closing the fixed receiver aborts a pending C-MOVE and frees the reservation', { timeout: 10000 }, async t => {
  const entered = deferred();
  const f = await fixture(t, { behavior: async state => {
    entered.resolve(); await new Promise(resolve => state.operation.abort.signal.addEventListener('abort', resolve, { once: true }));
  } });
  const operation = f.coordinator.retrieve(f.association, f.selection); operation.catch(() => {});
  await entered.promise; await f.receiver.close();
  await assert.rejects(operation, { code: 'move-receiver-closed' });
  await tick(); assert.equal(f.coordinator.getState().available, false); assert.equal(f.target.importReservations.size, 0);
  assert.throws(() => f.coordinator.preflight(), { code: 'move-receiver-unavailable' });
});

test('C-MOVE IDs and historical originators survive restart and expired quarantine without accepting an old same-instance callback', { timeout: 10000 }, async t => {
  const entered = deferred(); let oldRequest, newMessageId, lateStatus;
  const f = await fixture(t, { behavior: async state => {
    oldRequest = state; entered.resolve();
    await new Promise(resolve => state.operation.abort.signal.addEventListener('abort', resolve, { once: true }));
  } });
  f.association.callingAeTitle = 'EASI_CONTROL';
  const abort = new AbortController(), operation = f.coordinator.retrieve(f.association, f.selection, { signal: abort.signal });
  operation.catch(() => {}); await entered.promise; abort.abort(); await assert.rejects(operation, { name: 'AbortError' });
  const oldMessageId = oldRequest.operation.command.messageId, directory = f.target.dataDir;
  // Simulate elapsed quarantine without a timing-sensitive five-minute sleep.
  // A control AE different from the receiver AE must remain known afterwards.
  f.target.db.prepare('UPDATE dimse_move_ids SET expiresAt=0').run();
  await f.receiver.close(); await f.coordinator.close(); await f.target.close();
  const restored = await Archive.open({ dataDir: directory }), restarted = new MoveCoordinator({ archive: restored });
  const receiver = new StorageScp({ archive: restored, auth: { record: {} }, port: 0, moveCoordinator: restarted });
  try {
    f.callback.port = (await receiver.listen()).port;
    f.remote.query = async (socket, context, request) => {
      newMessageId = request.command.messageId;
      lateStatus = (await callbackStore(oldRequest)).status;
      const state = { scp: f.remote, socket, context, operation: request, callback: f.callback, source: f.source };
      assert.equal((await callbackStore(state)).status, 0); await final(state);
    };
    assert.equal((await restarted.retrieve(f.association, f.selection)).stored, 1);
    assert.notEqual(newMessageId, oldMessageId); assert.notEqual(lateStatus, 0);
    assert.equal(restored.stats().instances, 1);
  } finally { await receiver.close(); await restarted.close(); await restored.close(); }
});

test('an early successful final cannot finish before durable callback ACK and cannot leave a pending import', { timeout: 10000 }, async t => {
  const entered = deferred(); let storage;
  const f = await fixture(t, { behavior: async state => {
    storage = callbackStore(state); storage.catch(() => {});
    await entered.promise; await final(state);
  } });
  f.target.ingest = async stream => {
    entered.resolve();
    await new Promise((_, reject) => stream.once('close', () => reject(new Error('Synthetic pending ingest aborted.'))));
  };
  await assert.rejects(f.coordinator.retrieve(f.association, f.selection), { code: 'move-no-callback' });
  await storage.catch(() => {});
  assert.equal(f.target.stats().instances, 0); assert.equal(f.target.importReservations.size, 0);
  assert.equal(f.coordinator.getState().active, 0);
});

test('C-MOVE rejects a mismatched final response message ID and sanitizes its protocol error', { timeout: 10000 }, async t => {
  const f = await fixture(t, { behavior: async state => {
    await state.scp.respond(state.socket, state.context, state.operation.id,
      { ...state.operation.command, messageId: state.operation.command.messageId % 65535 + 1 }, 0);
  } });
  await assert.rejects(f.coordinator.retrieve(f.association, f.selection), error =>
    error.code === 'move-protocol-error' && error.message === 'The peer returned an invalid or inconsistent C-MOVE response.');
  assert.equal(f.target.stats().instances, 0); assert.equal(f.target.importReservations.size, 0);
});

test('a persistent quarantine retirement failure cannot leak the import reservation or expose the database error', { timeout: 10000 }, async t => {
  const f = await fixture(t), db = f.target.db, prepare = db.prepare;
  db.prepare = function(sql, ...args) {
    if (sql.startsWith('UPDATE dimse_move_ids')) return { run() { throw new Error('Synthetic SQLite failure with private diagnostic'); } };
    return prepare.call(this, sql, ...args);
  };
  try {
    await assert.rejects(f.coordinator.retrieve(f.association, f.selection), error =>
      error.code === 'move-state-failure' && !error.message.includes('private diagnostic'));
  } finally { db.prepare = prepare; }
  assert.equal(f.target.importReservations.size, 0); assert.equal(f.coordinator.getState().active, 0);
  assert.equal(f.target.stats().instances, 1, 'the already committed original is retained');
  assert.equal((await f.coordinator.retrieve(f.association, f.selection)).duplicates, 1);
});

for (const kind of ['command', 'failed-identifier']) test(`C-MOVE rejects empty ${kind} PDVs instead of retaining unbounded empty fragments`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { behavior: async state => {
    if (kind === 'failed-identifier') await sendMessage(state.socket, state.operation.id, commandBytes([
      [2, text(state.operation.command.sopClassUid)], [0x100, u16(0x8021)], [0x120, u16(state.operation.command.messageId)],
      [0x800, u16(0)], [0x900, u16(0xa700)]
    ]), true, state.context.peerMax);
    const empty = Buffer.alloc(6); empty.writeUInt32BE(2); empty[4] = state.operation.id; empty[5] = kind === 'command' ? 1 : 0;
    await send(state.socket, pdu(4, empty));
  } });
  await assert.rejects(f.coordinator.retrieve(f.association, f.selection), { code: 'move-protocol-error' });
  assert.equal(f.target.importReservations.size, 0); assert.equal(f.target.stats().instances, 0);
});
