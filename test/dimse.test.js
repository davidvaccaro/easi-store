import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DimseClient, NodeDimseCStoreScuTransport } from '@xinonix/easi-js/dimse/node';
import { Archive } from '../src/archive/Archive.js';
import { StorageScp } from '../src/dimse/StorageScp.js';
import { createDicom, uid } from './fixtures/synthetic.js';

test('EASI JS SCU interoperates with durable ECHO/STORE SCP and persisted data survives reopen', { timeout: 20000 }, async t => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'easi-store-dimse-'));
    let archive = await Archive.open({ dataDir });
    const scp = new StorageScp({ archive, auth: { record: { username: 'synthetic' } }, port: 0 });
    const address = await scp.listen();
    t.after(async () => { await scp.close(); await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
    const association = { host: '127.0.0.1', port: address.port, callingAeTitle: 'EASITEST', calledAeTitle: 'EASISTORE', timeoutMs: 5000 };
    const echo = await new DimseClient(association).echo(); assert.equal(echo.status, 0);
    const studyUid = uid(), seriesUid = uid(), sopUid = uid();
    const bytes = createDicom({ studyUid, seriesUid, sopUid });
    const transport = new NodeDimseCStoreScuTransport();
    const result = await transport.write(association, bytes);
    assert.equal(result.status, 0);
    assert.equal(archive.stats().instances, 1, 'C-STORE success means the catalog is already committed');
    const record = archive.getInstance(studyUid, seriesUid, sopUid); assert.ok(record); assert.equal(record.sopUid, sopUid);
    await transport.write(association, bytes); assert.equal(archive.stats().instances, 1, 'same DIMSE dataset is idempotent');
    const conflict = await transport.write(association, createDicom({ studyUid, seriesUid, sopUid, patientName: 'Changed^Synthetic' }));
    assert.equal(conflict.ok, false); assert.equal(conflict.status, 0x0111);
    await scp.close(); await archive.close(); archive = await Archive.open({ dataDir });
    assert.equal(archive.stats().instances, 1);
});

test('DIMSE has no successful C-STORE before first-run setup or on persistence failure', { timeout: 20000 }, async t => {
    let called = false;
    const scp = new StorageScp({ archive: { acquireImportReservation: () => () => {}, ingest: async () => { called = true; throw new Error('disk unavailable'); } }, auth: { record: null }, port: 0 });
    const address = await scp.listen(); t.after(() => scp.close());
    const association = { host: '127.0.0.1', port: address.port, callingAeTitle: 'EASITEST', calledAeTitle: 'EASISTORE', timeoutMs: 5000 };
    const transport = new NodeDimseCStoreScuTransport();
    assert.equal((await transport.write(association, createDicom())).ok, false); assert.equal(called, false);
    scp.auth.record = {};
    assert.equal((await transport.write(association, createDicom())).ok, false); assert.equal(called, true);
    await assert.rejects(new DimseClient({ ...association, calledAeTitle: 'WRONGAE' }).echo(), /reject|association/i);
});
