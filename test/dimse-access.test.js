import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DimseClient, NodeDimseCStoreScuTransport, NodeDimseQueryRetrieveSourceTransport } from '@xinonix/easi-js/dimse/node';
import { Archive } from '../src/archive/Archive.js';
import { StorageScp } from '../src/dimse/StorageScp.js';
import { AccessPolicy } from '../src/http/AccessPolicy.js';
import { createDicom, uid } from './fixtures/synthetic.js';

test('DIMSE defaults to loopback trust and requires an explicit association policy for a network bind', () => {
    const scp = new StorageScp({});
    for (const remoteAddress of ['127.0.0.1', '127.0.0.2', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
        assert.equal(scp.associationPolicy({ remoteAddress }), true, remoteAddress);
    }
    for (const remoteAddress of ['192.0.2.4', '::ffff:c000:204', '2001:db8::4', 'localhost', '127.example', undefined]) {
        assert.equal(scp.associationPolicy({ remoteAddress }), false, String(remoteAddress));
    }
    for (const host of ['0.0.0.0', '::', '192.0.2.4', 'archive.example']) {
        assert.throws(() => new StorageScp({ host }), /association policy/);
    }
    assert.equal(new StorageScp({ host: 'localhost' }).archiveReady(), false);
    assert.throws(() => new StorageScp({ associationPolicy: true }), /policies must be functions/);
    assert.throws(() => new StorageScp({ archiveReady: true }), /policies must be functions/);
});

test('DIMSE configured AE/IP trust applies before C-ECHO or durable C-STORE on a network listener', { timeout: 20000 }, async t => {
    let ingested = 0;
    const archive = { acquireImportReservation: () => () => {}, async ingest(stream) { for await (const bytes of stream) void bytes; ingested++; return {}; } };
    const accessPolicy = new AccessPolicy({ dataDir: '/not-opened', host: '0.0.0.0' });
    accessPolicy.record.dimse = { allowLoopback: false, peers: [{ callingAeTitle: 'ALLOWED_VIEW', address: '127.0.0.1' }] };
    const scp = new StorageScp({ archive, auth: { record: {} }, host: '0.0.0.0', port: 0,
        associationPolicy: peer => accessPolicy.canAssociate(peer) });
    const address = await scp.listen(); t.after(() => scp.close());
    const association = { host: '127.0.0.1', port: address.port, callingAeTitle: 'ALLOWED_VIEW', calledAeTitle: 'EASISTORE', timeoutMs: 5000 };
    assert.equal((await new DimseClient(association).echo()).status, 0);
    assert.equal((await new NodeDimseCStoreScuTransport().write(association, createDicom())).status, 0);
    assert.equal(ingested, 1);
    await assert.rejects(new DimseClient({ ...association, callingAeTitle: 'UNKNOWN_VIEW' }).echo(), /reject|association/i);
    await assert.rejects(new NodeDimseCStoreScuTransport().write({ ...association, callingAeTitle: 'UNKNOWN_VIEW' }, createDicom()), /reject|association/i);
    assert.equal(ingested, 1, 'rejected caller never reached Archive.ingest');
    accessPolicy.record.dimse.peers = [{ callingAeTitle: 'ALLOWED_VIEW', address: '192.0.2.4' }];
    await assert.rejects(new DimseClient(association).echo(), /reject|association/i);
    assert.equal(ingested, 1, 'matching AE with wrong source IP is also rejected');
    accessPolicy.record.dimse.peers = [{ callingAeTitle: 'ALLOWED_VIEW', address: '127.0.0.1' }];
    assert.equal((await new DimseClient(association).echo()).status, 0, 'policy changes apply to the next association');
});

test('explicit local research readiness permits anonymous DIMSE archive use before administrator setup', { timeout: 20000 }, async t => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'easi-store-dimse-research-'));
    const archive = await Archive.open({ dataDir });
    const accessPolicy = new AccessPolicy({ dataDir }); accessPolicy.record.profile = 'local-research';
    const auth = { record: null };
    const scp = new StorageScp({ archive, auth, port: 0,
        associationPolicy: peer => accessPolicy.canAssociate(peer),
        archiveReady: () => accessPolicy.record.profile === 'local-research' || Boolean(auth.record) });
    const address = await scp.listen();
    t.after(async () => { await scp.close(); await archive.close(); await rm(dataDir, { recursive: true, force: true }); });
    const association = { host: '127.0.0.1', port: address.port, callingAeTitle: 'RESEARCH_VIEW', calledAeTitle: 'EASISTORE', timeoutMs: 5000 };
    const studyUid = uid(), seriesUid = uid(), sopUid = uid();
    const bytes = createDicom({ studyUid, seriesUid, sopUid, patientName: 'Synthetic^Research' });
    const transport = new NodeDimseCStoreScuTransport();
    assert.equal((await transport.write(association, bytes)).status, 0);
    assert.equal(archive.stats().instances, 1, 'anonymous success still follows durable archive commit');
    const matches = await new NodeDimseQueryRetrieveSourceTransport().read(association,
        { operation: 'c-find', queryRetrieveLevel: 'STUDY', keys: { PatientName: 'Synthetic*' }, returnKeys: ['StudyInstanceUID'] });
    assert.equal(matches.metadata.dimse.finalResponse.status, 0);
    assert.equal(matches.metadata.count, 1);
    accessPolicy.record.profile = 'authenticated';
    assert.equal((await transport.write(association, createDicom())).ok, false, 'uninitialized authenticated archive refuses writes');
    auth.record = { username: 'synthetic' };
    assert.equal((await transport.write(association, createDicom())).status, 0, 'configured archive resumes normal DIMSE trusted-network use');
    assert.equal(archive.stats().instances, 2);
});

test('DIMSE explicit policy rejection never consults archive readiness or ingestion', { timeout: 10000 }, async t => {
    let consulted = 0;
    const scp = new StorageScp({ port: 0, associationPolicy: () => false,
        archiveReady: () => { consulted++; return true; }, archive: { ingest: () => assert.fail('unexpected archive access') } });
    const address = await scp.listen(); t.after(() => scp.close());
    const association = { host: '127.0.0.1', port: address.port, callingAeTitle: 'UNKNOWN_VIEW', calledAeTitle: 'EASISTORE', timeoutMs: 5000 };
    await assert.rejects(new DimseClient(association).echo(), /reject|association/i);
    await assert.rejects(new NodeDimseCStoreScuTransport().write(association, createDicom()), /reject|association/i);
    assert.equal(consulted, 0);
});
