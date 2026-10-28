import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStoreServer } from '../src/server.js';
import { createDicom } from './fixtures/synthetic.js';

async function fixture(t) {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'easi-store-health-http-'));
    let available = 8 * 1024 ** 3;
    const capacity = async () => ({ bsize: 1, blocks: 16 * 1024 ** 3, bfree: available, bavail: available });
    const app = await createStoreServer({ dataDir, port: 0, healthOptions: { capacity } });
    t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
    const address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
    await app.auth.setup({ username: 'generated-admin', password: 'generated-health-test-password' }, '127.0.0.1');
    const administrator = await app.auth.issueApiToken('Generated health administrator');
    const request = (route, { token = administrator, method = 'GET', body } = {}) => fetch(base + route, {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const tokens = {};
    for (const role of ['reader', 'contributor']) {
        const response = await request('/api/v1/auth/tokens', { method: 'POST', body: { label: `Generated ${role}`, role, expiresInDays: 1 } });
        assert.equal(response.status, 201); tokens[role] = (await response.json()).token;
    }
    return { app, request, tokens, base, dataDir, setAvailable: value => { available = value; } };
}

test('health administration is role protected while readiness exposes only minimal state', async t => {
    const f = await fixture(t);
    let response = await f.request('/api/ready', { token: null });
    assert.equal(response.status, 200); assert.deepEqual(Object.keys(await response.json()).sort(), ['ready', 'version']);
    assert.equal((await f.request('/api/v1/health', { token: null })).status, 401);
    for (const token of Object.values(f.tokens)) {
        assert.equal((await f.request('/api/v1/health', { token })).status, 403);
        assert.equal((await f.request('/api/v1/health/settings', { token, method: 'PUT', body: {} })).status, 403);
        assert.equal((await f.request('/api/v1/health/audits', { token, method: 'POST', body: {} })).status, 403);
    }
    response = await f.request('/api/v1/health'); assert.equal(response.status, 200);
    const snapshot = await response.json(); assert.equal(snapshot.sqlite.status, 'ok'); assert.equal(snapshot.ready, true);
    assert.ok(!JSON.stringify(snapshot).includes(f.dataDir));
    const update = { ...snapshot.settings, reserveBytes: 128 * 1024 ** 2, warningBytes: 512 * 1024 ** 2, maxConcurrentImports: 2 };
    response = await f.request('/api/v1/health/settings', { method: 'PUT', body: update }); assert.equal(response.status, 200);
    const settings = await response.json(); assert.notEqual(settings.revision, update.revision);
    assert.equal((await f.request('/api/v1/health/settings', { method: 'PUT', body: update })).status, 409);
    assert.equal((await f.request('/api/v1/health/settings', { method: 'PUT', body: { ...settings, path: '/untrusted' } })).status, 400);
    assert.equal(JSON.parse(await readFile(path.join(f.dataDir, 'health-settings.json'))).maxConcurrentImports, 2);
});

test('low capacity produces an actionable import refusal while retained originals stay readable', async t => {
    const f = await fixture(t), original = createDicom();
    const stored = await f.app.archive.ingest([original]);
    f.setAvailable(1024);
    let response = await f.request('/api/ready', { token: null }); assert.equal(response.status, 503);
    assert.deepEqual(Object.keys(await response.json()).sort(), ['ready', 'version']);
    response = await fetch(f.base + '/api/v1/instances', { method: 'POST', headers: { Authorization: `Bearer ${f.tokens.contributor}`, 'Content-Type': 'application/dicom' }, body: createDicom() });
    assert.equal(response.status, 507); const error = (await response.json()).error;
    assert.equal(error.code, 'insufficient-storage'); assert.match(error.message, /reserve/); assert.ok(!error.message.includes(f.dataDir));
    assert.equal(f.app.archive.stats().instances, 1);
    const { studyUid, seriesUid, sopUid } = stored.instance;
    response = await f.request(`/api/v1/download/${studyUid}/${seriesUid}/${sopUid}`, { token: f.tokens.reader });
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    assert.equal((await f.request('/api/health', { token: null })).status, 200);
});

test('an integrity audit returns bounded nonidentifying results and records the administrator action', async t => {
    const f = await fixture(t); await f.app.archive.ingest([createDicom()]);
    assert.equal((await f.request('/api/v1/health/audits', { method: 'POST', body: { repair: true } })).status, 400);
    let response = await f.request('/api/v1/health/audits', { method: 'POST', body: { verifyHashes: true } });
    assert.equal(response.status, 202); let report = await response.json();
    const route = `/api/v1/health/audits/${report.id}`;
    assert.equal((await f.request(route, { token: f.tokens.reader })).status, 403);
    for (let attempt = 0; report.status === 'running' && attempt < 200; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10)); response = await f.request(route); assert.equal(response.status, 200); report = await response.json();
    }
    assert.equal(report.status, 'completed'); assert.equal(report.progress.indexed, 1); assert.equal(report.counts.corrupt, 0);
    assert.equal((await f.request(route, { method: 'DELETE', token: f.tokens.contributor })).status, 403);
    assert.equal((await f.request(route, { method: 'DELETE' })).status, 200);
    assert.equal((await f.request('/api/v1/health/audits/00000000-0000-0000-0000-000000000000')).status, 404);
    const activity = await (await f.request('/api/v1/auth/activity')).json();
    assert.ok(activity.items.some(item => item.action === 'health.post' && item.actor?.role === 'administrator'));
    const text = JSON.stringify({ report, activity }); assert.ok(!text.includes('generated-health-test-password')); assert.ok(!text.includes(f.dataDir));
});

test('a full catalog during audit admission refuses the operation without exposing filesystem details', async t => {
    const f = await fixture(t), begin = f.app.securityAudit.begin;
    const privateDetail = 'private-filesystem-location';
    f.app.securityAudit.begin = () => { throw Object.assign(new Error(privateDetail), { code: 'ERR_SQLITE_ERROR', errcode: 13 }); };
    try {
        const response = await f.request('/api/v1/health/audits', { method: 'POST', body: { verifyHashes: true } });
        assert.equal(response.status, 507); const result = await response.json();
        assert.equal(result.error.code, 'insufficient-storage'); assert.match(result.error.message, /filesystem is full/);
        assert.ok(!JSON.stringify(result).includes(privateDetail)); assert.equal(f.app.archive.health.getAudit(), null);
        assert.equal((await f.request('/api/health', { token: null })).status, 200);
    } finally { f.app.securityAudit.begin = begin; }
});
