import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { NodeDimseCStoreScuTransport } from '@xinonix/easi-js/dimse/node';
import { Archive } from '../src/archive/Archive.js';
import { StorageScp } from '../src/dimse/StorageScp.js';
import { createDicom } from './fixtures/synthetic.js';

test('C-STORE response stays pending while durable persistence has not completed', { timeout: 10000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'easi-store-durability-test-'));
  const archive = await Archive.open({ dataDir });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const scp = new StorageScp({
    archive: { acquireImportReservation: () => archive.acquireImportReservation(), async ingest(readable, options) { started(); await gate; return archive.ingest(readable, options); } },
    auth: { record: { username: 'synthetic' } }, port: 0,
  });
  const address = await scp.listen();
  t.after(async () => { release(); await scp.close(); await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
  const response = new NodeDimseCStoreScuTransport().write({ host: '127.0.0.1', port: address.port, callingAeTitle: 'EASITEST', calledAeTitle: 'EASISTORE', timeoutMs: 5000 }, createDicom());
  await began;
  assert.equal(archive.stats().instances, 0);
  const early = await Promise.race([response.then(() => 'responded'), new Promise(resolve => setTimeout(() => resolve('waiting'), 75))]);
  assert.equal(early, 'waiting', 'a successful C-STORE must not acknowledge receipt into an in-memory buffer');
  release();
  assert.equal((await response).status, 0);
  assert.equal(archive.stats().instances, 1);
});
