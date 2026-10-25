import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { NodeDimseQueryRetrieveSourceTransport, NodeDimseCStoreScuTransport } from '@xinonix/easi-js/dimse/node';
import { Archive } from '../src/archive/Archive.js';
import { StorageScp } from '../src/dimse/StorageScp.js';
import { createDicom, uid } from './fixtures/synthetic.js';

for (const operation of ['c-find', 'c-get']) test(`native ${operation} holds its read lease until the full operation finishes`, { timeout: 10000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'easi-store-read-lease-dimse-')), archive = await Archive.open({ dataDir });
  const studyUid = uid(), seriesUid = uid(), sopUid = uid(), original = createDicom({ studyUid, seriesUid, sopUid });
  await archive.ingest(Readable.from([original]));
  const scp = new StorageScp({ archive, auth: { record: {} }, port: 0 }), address = await scp.listen();
  let entered, resume;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { resume = resolve; });
  t.after(async () => { resume(); await scp.close(); await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
  const respond = scp.respond.bind(scp); let blocked = false;
  scp.respond = async (...args) => {
    if (!blocked && args[4] === 0xff00) { blocked = true; entered(); await gate; }
    return respond(...args);
  };
  const result = new NodeDimseQueryRetrieveSourceTransport().read({ host: '127.0.0.1', port: address.port, calledAeTitle: 'EASISTORE', callingAeTitle: 'LEASETEST', timeoutMs: 5000 },
    { operation, performFind: false, studyInstanceUid: studyUid, queryRetrieveLevel: 'STUDY', storageTransferSyntaxUids: ['1.2.840.10008.1.2.1'] });
  await started;
  assert.equal(archive.readLeases.size, 1);
  await assert.rejects(archive.deleteStudy(studyUid, { confirmation: 'DELETE', revision: archive.previewStudyDeletion(studyUid).revision }), { code: 'archive-read-active' });
  assert.deepEqual(await readFile(archive.getInstance(studyUid, seriesUid, sopUid).path), original);
  resume(); assert.equal((await result).metadata.dimse.finalResponse.status, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(archive.readLeases.size, 0);
  assert.equal((await archive.deleteStudy(studyUid, { confirmation: 'DELETE', revision: archive.previewStudyDeletion(studyUid).revision })).deleted, true);
});

async function storageFixture(t, { malformedDataset = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'easi-store-pending-storage-')), archive = await Archive.open({ dataDir });
  const scp = new StorageScp({ archive, auth: { record: {} }, port: 0 }), address = await scp.listen();
  let resume, accepted;
  const gate = new Promise(resolve => { resume = resolve; }), commandAccepted = new Promise(resolve => { accepted = resolve; });
  const command = scp.command.bind(scp);
  scp.command = async (...args) => { await command(...args); if (args[4].field === 1) accepted(); };
  class PausedStorageScu extends NodeDimseCStoreScuTransport {
    async writePdu(socket, bytes) {
      if (bytes[0] === 4 && !(bytes[11] & 1)) {
        await gate;
        if (malformedDataset) { bytes = Buffer.from(bytes); bytes[10] = 255; }
      }
      return super.writePdu(socket, bytes);
    }
  }
  const session = { archive, scp, resume, commandAccepted, association: { host: '127.0.0.1', port: address.port, calledAeTitle: 'EASISTORE', callingAeTitle: 'IMPORTTEST', timeoutMs: 5000 },
    start(bytes, options) { this.result = new PausedStorageScu().write(this.association, bytes, options); this.result.catch(() => {}); return this.result; } };
  t.after(async () => { resume(); await session.result?.catch(() => {}); await scp.close(); await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
  return session;
}

test('an accepted C-STORE command reserves an import before its first dataset PDV and blocks study removal', { timeout: 10000 }, async t => {
  const f = await storageFixture(t), studyUid = uid();
  await f.archive.ingest(Readable.from([createDicom({ studyUid })]));
  const preview = f.archive.previewStudyDeletion(studyUid);
  f.start(createDicom({ studyUid })); await f.commandAccepted;
  assert.equal(f.archive.operations.size, 0, 'the sender has not started its dataset stream');
  assert.equal(f.archive.importReservations.size, 1);
  await assert.rejects(f.archive.deleteStudy(studyUid, { confirmation: 'DELETE', revision: preview.revision }), { code: 'archive-import-active' });
  assert.equal(f.archive.stats().instances, 1);
  f.resume(); assert.equal((await f.result).status, 0);
  assert.equal(f.archive.importReservations.size, 0); assert.equal(f.archive.stats().instances, 2);
  assert.equal((await f.archive.deleteStudy(studyUid, { confirmation: 'DELETE', revision: f.archive.previewStudyDeletion(studyUid).revision })).deleted, true);
});

for (const failure of ['shutdown', 'malformed-dataset']) test(`a pending C-STORE reservation is released after ${failure}`, { timeout: 10000 }, async t => {
  const f = await storageFixture(t, { malformedDataset: failure === 'malformed-dataset' }), studyUid = uid();
  await f.archive.ingest(Readable.from([createDicom({ studyUid })]));
  f.start(createDicom({ studyUid })); await f.commandAccepted;
  assert.equal(f.archive.importReservations.size, 1);
  if (failure === 'shutdown') await f.scp.close();
  f.resume(); await assert.rejects(f.result);
  for (const socket of f.scp.sockets) await socket.finishedTask;
  assert.equal(f.archive.importReservations.size, 0); assert.equal(f.archive.operations.size, 0);
  assert.equal(f.archive.stats().instances, 1);
  assert.equal((await f.archive.deleteStudy(studyUid, { confirmation: 'DELETE', revision: f.archive.previewStudyDeletion(studyUid).revision })).deleted, true);
});

test('a C-STORE command rejected during deletion cannot start admission after the gate clears', { timeout: 10000 }, async t => {
  const f = await storageFixture(t), studyUid = uid();
  await f.archive.ingest(Readable.from([createDicom({ studyUid })]));
  let entered, proceed;
  const verifying = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { proceed = resolve; });
  const verify = f.archive.deletion.verifyObject.bind(f.archive.deletion); let once = false;
  f.archive.deletion.verifyObject = async (...args) => { if (!once) { once = true; entered(); await gate; } return verify(...args); };
  t.after(() => proceed());
  const deleting = f.archive.deleteStudy(studyUid, { confirmation: 'DELETE', revision: f.archive.previewStudyDeletion(studyUid).revision });
  await verifying;
  f.start(createDicom({ studyUid })); await f.commandAccepted;
  assert.equal(f.archive.importReservations.size, 0);
  proceed(); assert.equal((await deleting).deleted, true); assert.equal(f.archive.deleting, false);
  f.resume(); const result = await f.result;
  assert.equal(result.ok, false); assert.equal(result.status, 0xa700);
  assert.equal(f.archive.stats().instances, 0); assert.equal(f.archive.importReservations.size, 0);
});

test('malformed C-STORE commands do not acquire an import reservation', { timeout: 10000 }, async t => {
  const f = await storageFixture(t);
  f.start(createDicom(), { messageId: 0 }); f.resume(); await assert.rejects(f.result);
  for (const socket of f.scp.sockets) await socket.finishedTask;
  assert.equal(f.archive.importReservations.size, 0); assert.equal(f.archive.stats().instances, 0);
});
