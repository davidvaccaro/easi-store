import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AccessPolicy, normalizeAddress, isLoopbackAddress, validateAccessPolicy } from '../src/http/AccessPolicy.js';
import { createStoreServer } from '../src/server.js';
import { createDicom, uid } from './fixtures/synthetic.js';

const policy = (profile = 'authenticated', dimse = { allowLoopback: true, peers: [] }) => ({ version: 1, profile, dimse });
const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:8048', ...headers } });
async function fixture(t, options = {}) {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'easi-store-access-'));
    let app = await createStoreServer({ dataDir, port: 0, ...options });
    let address = await app.listen();
    let base = `http://127.0.0.1:${address.port}`;
    t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
    return { dataDir, get app() { return app; }, get base() { return base; }, async restart() {
        await app.close(); app = await createStoreServer({ dataDir, port: 0 });
        address = await app.listen(); base = `http://127.0.0.1:${address.port}`;
    } };
}
async function administrator(base) {
    const response = await fetch(base + '/api/v1/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EASI-Store': '1' },
        body: JSON.stringify({ username: 'synthetic', password: 'independent-synthetic-password' }) });
    assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
}

test('access policy canonicalizes source addresses, never trusts forwarded headers, and requires both AE and IP', async t => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'easi-store-policy-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
    const access = await new AccessPolicy({ dataDir }).open({ profile: 'local-research' });
    for (const address of ['127.0.0.1', '127.6.7.8', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
        assert.equal(isLoopbackAddress(address), true, address); assert.equal(access.allowsDicomweb(request(address)), true);
    }
    for (const address of ['192.0.2.4', '::ffff:c000:204', '2001:db8::1', 'localhost', '', undefined, 'fe80::1%lo0']) {
        assert.equal(access.allowsDicomweb(request(address, { 'x-forwarded-for': '127.0.0.1' })), false, String(address));
    }
    assert.equal(normalizeAddress('0:0:0:0:0:ffff:c000:204'), '192.0.2.4');
    await access.update(policy('authenticated', { allowLoopback: false, peers: [{ callingAeTitle: 'RESEARCH', address: '::ffff:c000:204' }] }));
    assert.equal(access.canAssociate({ callingAeTitle: 'RESEARCH', remoteAddress: '192.0.2.4' }), true);
    assert.equal(access.canAssociate({ callingAeTitle: 'OTHER', remoteAddress: '192.0.2.4' }), false);
    assert.equal(access.canAssociate({ callingAeTitle: 'RESEARCH', remoteAddress: '192.0.2.5' }), false);
    assert.equal(access.canAssociate({ callingAeTitle: 'RESEARCH', remoteAddress: '127.0.0.1' }), false);
    assert.equal(access.canAssociate({ callingAeTitle: 'RESEARCH', remoteAddress: 'bad', forwardedFor: '192.0.2.4' }), false);
    const authenticated = access.snapshot();
    await access.update({ ...authenticated, profile: 'local-research' });
    assert.equal(access.canAssociate({ callingAeTitle: 'OTHER', remoteAddress: '127.0.0.1' }), true, 'research access permits all valid actual loopback clients');
    assert.equal(access.canAssociate({ callingAeTitle: 'RESEARCH', remoteAddress: '192.0.2.4' }), false, 'research mode cannot use a saved remote peer');
    assert.deepEqual(access.snapshot().dimse, authenticated.dimse, 'research preserves authenticated-mode trust settings');
    await access.update({ ...access.snapshot(), profile: 'authenticated' });
    assert.equal(access.canAssociate({ callingAeTitle: 'OTHER', remoteAddress: '127.0.0.1' }), false);
    assert.equal(access.canAssociate({ callingAeTitle: 'RESEARCH', remoteAddress: '192.0.2.4' }), true);
    assert.deepEqual((await new AccessPolicy({ dataDir }).open()).snapshot(), access.snapshot());
    if (process.platform !== 'win32') assert.equal((await stat(path.join(dataDir, 'access-policy.json'))).mode & 0o077, 0);
});

test('local research rejects network listeners and invalid peers before activating policy', () => {
    for (const listeners of [{ host: '0.0.0.0' }, { host: '::' }, { host: 'localhost' }, { dimseHost: '0.0.0.0' }]) {
        assert.throws(() => validateAccessPolicy(policy('local-research'), listeners), /literal loopback/);
    }
    assert.throws(() => validateAccessPolicy(policy(), { dimseHost: '0.0.0.0' }), /explicit calling-AE\/IP/);
    assert.equal(validateAccessPolicy(policy('authenticated', { allowLoopback: false,
        peers: [{ callingAeTitle: 'RESEARCH', address: '192.0.2.4' }] }), { host: '0.0.0.0', dimseHost: '0.0.0.0' }).profile, 'authenticated');
    for (const invalid of [policy('unknown'), { ...policy(), version: 2 }, { ...policy(), extra: true },
        policy('authenticated', { allowLoopback: true, peers: [{ callingAeTitle: '*', address: 'localhost' }] }),
        policy('authenticated', { allowLoopback: true, peers: [{ callingAeTitle: 'RESEARCH', address: '0.0.0.0' }] }),
        policy('authenticated', { allowLoopback: true, peers: [{ callingAeTitle: 'RESEARCH', address: '::' }] }),
        policy('authenticated', { allowLoopback: true, peers: [{ callingAeTitle: 'RESEARCH', address: 'fe80::1%en0' }] }),
        policy('authenticated', { allowLoopback: true, peers: [{ callingAeTitle: 'RESEARCH', address: '192.0.2.4' }, { callingAeTitle: 'RESEARCH', address: '::ffff:c000:204' }] })]) {
        assert.throws(() => validateAccessPolicy(invalid));
    }
});

test('authenticated remains the default and only an authenticated administrator can change client access', async t => {
    const f = await fixture(t);
    assert.deepEqual(await (await fetch(f.base + '/api/v1/access')).json(), { profile: 'authenticated', dicomwebAuthenticationRequired: true,
        administratorAuthenticationRequired: true, dimseSecurity: 'Calling AE title and source IP policy; no HTTP user session or DICOM TLS.' });
    assert.equal((await fetch(f.base + '/api/v1/access-policy')).status, 401);
    assert.equal((await fetch(f.base + '/dicomweb/studies')).status, 401);
    const cookie = await administrator(f.base);
    const update = (value, headers = {}) => fetch(f.base + '/api/v1/access-policy', { method: 'PUT', headers: { Cookie: cookie,
        'Content-Type': 'application/json', 'X-EASI-Store': '1', ...headers }, body: JSON.stringify(value) });
    assert.equal((await update(policy('local-research'), { Cookie: '' })).status, 401);
    assert.equal((await update(policy('local-research'), { Origin: 'https://unrelated.invalid' })).status, 403);
    assert.equal((await update(policy('local-research'), { 'X-EASI-Store': '' })).status, 403);
    assert.equal((await update(policy('local-research'))).status, 200);
    assert.equal((await fetch(f.base + '/dicomweb/studies')).status, 200);
    for (const p of ['/api/v1/summary', '/api/v1/studies', '/api/v1/access-policy', '/api/v1/connections', '/api/v1/jobs']) {
        assert.equal((await fetch(f.base + p)).status, 401, p);
    }
    const saved = await readFile(path.join(f.dataDir, 'access-policy.json'), 'utf8');
    assert.equal(JSON.parse(saved).profile, 'local-research');
    assert.equal((await update(policy('wrong'))).status, 400);
    assert.equal(f.app.accessPolicy.record.profile, 'local-research', 'failed updates preserve the active policy');
    await f.restart();
    assert.equal((await fetch(f.base + '/dicomweb/studies')).status, 200, 'research access survives restart without an administrator session');
    assert.equal((await fetch(f.base + '/api/v1/summary', { headers: { Cookie: cookie } })).status, 401);
    const token = await f.app.auth.issueApiToken('Synthetic test client');
    assert.equal((await fetch(f.base + '/api/v1/access-policy', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(policy()) })).status, 200);
    assert.equal((await fetch(f.base + '/dicomweb/studies')).status, 401, 'switching back immediately restores required client authentication');
    assert.equal((await fetch(f.base + '/dicomweb/studies', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
});

test('explicit local research permits standard unauthenticated QIDO/STOW/WADO before administrator setup', async t => {
    const f = await fixture(t, { accessProfile: 'local-research' });
    const studyUid = uid(), seriesUid = uid(), sopUid = uid(), bytes = createDicom({ studyUid, seriesUid, sopUid });
    const boundary = 'independent-synthetic-research';
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const headers = { 'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}` };
    let response = await fetch(f.base + '/dicomweb/studies', { method: 'POST', headers, body });
    assert.equal(response.status, 200, await response.clone().text());
    response = await fetch(f.base + '/dicomweb/studies'); assert.equal(response.status, 200);
    assert.equal((await response.json())[0]['0020000D'].Value[0], studyUid);
    response = await fetch(f.base + `/dicomweb/studies/${studyUid}/series/${seriesUid}/instances/${sopUid}`, { headers: { Accept: 'multipart/related; type="application/dicom"; transfer-syntax=*' } });
    assert.equal(response.status, 200); assert.ok(Buffer.from(await response.arrayBuffer()).includes(bytes), 'WADO contains the exact original Part 10 bytes');
    response = await fetch(f.base + `/dicomweb/studies/${studyUid}/metadata`); assert.equal(response.status, 200); await response.json();
    assert.equal(f.app.auth.record, null, 'DICOM services do not create or impersonate an administrator');
    assert.equal((await fetch(f.base + '/api/v1/instances', { method: 'POST', headers: { 'Content-Type': 'application/dicom', 'X-EASI-Store': '1' }, body: bytes })).status, 401);
    assert.equal((await fetch(f.base + '/dicomweb/studies', { method: 'POST', headers: { ...headers, Origin: 'https://unrelated.invalid' }, body })).status, 403);
    const hostileStatus = await new Promise((resolve, reject) => {
        const req = http.get(f.base + '/dicomweb/studies', { headers: { Host: 'unrelated.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
    });
    assert.equal(hostileStatus, 403);
    const description = await (await fetch(f.base + '/api/v1/access')).json();
    assert.equal(description.dicomwebAuthenticationRequired, false);
    assert.deepEqual(Object.keys(description).sort(), ['administratorAuthenticationRequired', 'dicomwebAuthenticationRequired', 'dimseSecurity', 'profile']);
});
