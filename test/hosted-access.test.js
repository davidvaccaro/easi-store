import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccessPolicy, validateAccessPolicy } from '../src/http/AccessPolicy.js';
import { createStoreServer } from '../src/server.js';

const policy = profile => ({ version: 1, profile, dimse: { allowLoopback: true, peers: [] } });
const research = policy('local-research');
const publicUrl = 'https://store.example.test';
const request = (headers = {}, remoteAddress = '127.0.0.1') => ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:8048', ...headers } });

test('declared hosted/public deployments reject research while explicit local endpoints retain local access', () => {
    for (const context of [{ publicUrl }, { publicUrl: 'http://192.0.2.7:8048' }, { hosted: true }, { hosted: true, publicUrl: 'https://localhost:8443' }]) {
        assert.throws(() => validateAccessPolicy(research, context), /require authenticated client access/);
        assert.equal(validateAccessPolicy(policy('authenticated'), context).profile, 'authenticated');
    }
    for (const local of ['http://127.0.0.1:8048', 'https://localhost:8443', 'https://[::1]:8443']) {
        assert.equal(validateAccessPolicy(research, { publicUrl: local }).profile, 'local-research');
    }
});

test('hosted startup cannot activate persisted research and rejected updates preserve authenticated state', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'easi-store-hosted-policy-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await new AccessPolicy({ dataDir: directory }).open({ profile: 'local-research' });
    const previous = await readFile(path.join(directory, 'access-policy.json'));
    await assert.rejects(new AccessPolicy({ dataDir: directory, publicUrl }).open(), /require authenticated client access/);
    assert.deepEqual(await readFile(path.join(directory, 'access-policy.json')), previous);
    const access = await new AccessPolicy({ dataDir: directory, publicUrl }).open({ profile: 'authenticated' });
    const saved = await readFile(path.join(directory, 'access-policy.json'));
    await assert.rejects(access.update(research), /require authenticated client access/);
    assert.equal(access.record.profile, 'authenticated');
    assert.deepEqual(await readFile(path.join(directory, 'access-policy.json')), saved);
});

test('anonymous research never trusts a proxy header or a non-loopback Host, preserving the fixed local viewer bridge', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'easi-store-proxy-policy-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const access = await new AccessPolicy({ dataDir: directory }).open({ profile: 'local-research' });
    for (const host of ['127.0.0.1:8048', '127.2.3.4:8048', '[::1]:8048', 'localhost:8048']) assert.equal(access.allowsDicomweb(request({ host })), true, host);
    for (const host of ['store.example.test', 'localhost.attacker.test', 'localhost.', '127.1:8048', '127.0.0.1@attacker.test', '', undefined]) assert.equal(access.allowsDicomweb(request({ host })), false, String(host));
    for (const header of ['Forwarded', 'X-Forwarded-For', 'X-Forwarded-Proto', 'X-Forwarded-Host', 'X-Real-IP', 'Via', 'CF-Connecting-IP', 'X-Original-Host']) {
        assert.equal(access.allowsDicomweb(request({ [header]: '127.0.0.1' })), false, header);
    }
    assert.equal(access.allowsDicomweb(request({ 'x-easi-store-public-base': '/easi-store/dicomweb' })), true);
    assert.equal(access.allowsDicomweb(request({ 'x-easi-store-public-base': '/easi-store/dicomweb', forwarded: 'for=127.0.0.1' })), false);
    assert.equal(access.allowsDicomweb(request({ 'x-easi-store-public-base': '/another-proxy' })), false);
    assert.equal(access.allowsDicomweb(request({}, '192.0.2.7')), false);
});

test('effective public URL, OIDC callback-derived origin and explicit hosted mode all guard real server startup', async t => {
    for (const options of [{ publicUrl }, { hosted: true }, { authConfiguration: { mode: 'hybrid', oidc: {
        issuer: 'https://identity.example.test', clientId: 'generated-store', callbackUrl: publicUrl + '/api/v1/auth/oidc/callback',
        subjectRoles: {}, groupRoles: { generated: 'reader' }
    } } }]) {
        const directory = await mkdtemp(path.join(tmpdir(), 'easi-store-hosted-startup-'));
        t.after(() => rm(directory, { recursive: true, force: true }));
        await assert.rejects(createStoreServer({ dataDir: directory, port: 0, accessProfile: 'local-research', ...options }), /require authenticated client access/);
    }
});

test('hosted settings updates reject research without weakening authenticated DICOMweb', async t => {
    for (const options of [{ publicUrl }, { hosted: true }]) {
        const directory = await mkdtemp(path.join(tmpdir(), 'easi-store-hosted-http-'));
        const app = await createStoreServer({ dataDir: directory, port: 0, ...options });
        try {
            const address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
            await app.auth.setup({ username: 'generated-operator', password: 'generated-hosted-password' }, '127.0.0.1');
            const token = await app.auth.issueApiToken('Generated hosted qualification');
            const response = await fetch(base + '/api/v1/access-policy', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(research) });
            assert.equal(response.status, 400);
            assert.match((await response.json()).error.message, /require authenticated client access/);
            assert.equal(app.accessPolicy.record.profile, 'authenticated');
            assert.equal((await fetch(base + '/dicomweb/studies')).status, 401);
            assert.equal((await fetch(base + '/dicomweb/studies', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
        } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
    }
});

test('real anonymous proxy-shaped requests are denied but local bridge and authenticated callers keep working', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'easi-store-hosted-headers-'));
    const app = await createStoreServer({ dataDir: directory, port: 0, accessProfile: 'local-research' });
    try {
        const address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
        assert.equal((await fetch(base + '/dicomweb/studies', { headers: { 'X-EASI-Store-Public-Base': '/easi-store/dicomweb' } })).status, 200);
        for (const headers of [{ Forwarded: 'for=127.0.0.1' }, { 'X-Forwarded-For': '127.0.0.1' }, { Via: '1.1 generated-proxy' }, { 'X-Forwarded-Proto': 'https', 'X-EASI-Store-Public-Base': '/easi-store/dicomweb' }]) {
            assert.equal((await fetch(base + '/dicomweb/studies', { headers })).status, 401);
            assert.equal((await (await fetch(base + '/api/v1/access', { headers })).json()).dicomwebAuthenticationRequired, true);
        }
        await app.auth.setup({ username: 'generated-operator', password: 'generated-hosted-password' }, '127.0.0.1');
        const token = await app.auth.issueApiToken('Generated proxy qualification');
        assert.equal((await fetch(base + '/dicomweb/studies', { headers: { Forwarded: 'for=192.0.2.5', Authorization: `Bearer ${token}` } })).status, 200);
        assert.equal((await fetch(base + '/api/v1/summary')).status, 401);
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
