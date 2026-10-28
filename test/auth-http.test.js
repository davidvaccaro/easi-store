import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash, scrypt as derive } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile as execute } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer as createSocketServer } from 'node:net';
import { once } from 'node:events';
import { createOidcFixture } from './fixtures/oidc-provider.js';
import { createStoreServer } from '../src/server.js';
import { createDicom } from './fixtures/synthetic.js';

const scrypt = promisify(derive), execFile = promisify(execute);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const password = 'generated-administrator-password';
const digest = value => createHash('sha256').update(value).digest('hex');
const jsonHeaders = { 'Content-Type': 'application/json', 'X-EASI-Store': '1' };

async function setup(t, options = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), 'easi-store-auth-http-')), dataDir = path.join(directory, 'archive');
    let app = await createStoreServer({ dataDir, port: 0, ...options }), closed = false;
    const address = await app.listen(); let base = `http://127.0.0.1:${address.port}`;
    t.after(async () => { if (!closed) await app.close(); await rm(directory, { recursive: true, force: true }); });
    const response = await fetch(base + '/api/v1/setup', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username: 'synthetic', password }) });
    assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie').split(';')[0];
    const request = (route, { method = 'GET', body, token, session = false, headers = {} } = {}) => fetch(base + route, {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(session ? { Cookie: cookie } : {}),
            ...(body === undefined ? {} : jsonHeaders), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) })
    });
    const mint = async role => {
        const created = await request('/api/v1/auth/tokens', { method: 'POST', session: true, body: { label: `Generated ${role} integration`, role, expiresInDays: 30 } });
        assert.equal(created.status, 201); const value = await created.json();
        assert.equal(typeof value.token, 'string'); assert.equal(typeof value.credential.id, 'string'); assert.equal(value.credential.role, role); return { token: value.token, record: value.credential };
    };
    const credentials = {};
    for (const role of ['reader', 'contributor', 'administrator']) credentials[role] = await mint(role);
    const original = createDicom({ rows: 8, columns: 8 });
    const stored = await request('/api/v1/instances', { method: 'POST', token: credentials.administrator.token, headers: { 'Content-Type': 'application/dicom' }, body: original });
    assert.equal(stored.status, 201); const instance = (await stored.json()).instance;
    const draft = await request('/api/v1/datasets', { method: 'POST', token: credentials.administrator.token,
        body: { name: 'Generated authorization cohort', selection: [{ studyUid: instance.studyUid, seriesUid: instance.seriesUid }] } });
    assert.equal(draft.status, 201); const dataset = await draft.json();
    const frozen = await request(`/api/v1/datasets/${dataset.id}/versions`, { method: 'POST', token: credentials.administrator.token, body: { revision: dataset.revision } });
    assert.equal(frozen.status, 201); const version = await frozen.json();
    const manifest = await (await request(`/api/v1/datasets/${dataset.id}/versions/${version.version}/manifest`, { token: credentials.administrator.token })).json();
    return { app, directory, dataDir, base, cookie, request, mint, credentials, original, instance, dataset, version, manifest,
        async restart() { if (!closed) await app.close(); app = await createStoreServer({ dataDir, port: 0, ...options }); closed = false; const next = await app.listen(); base = `http://127.0.0.1:${next.port}`; this.app = app; this.base = base; },
        async close() { if (!closed) { await app.close(); closed = true; } }
    };
}

function reference(f) {
    const { studyUid, seriesUid, sopUid } = f.instance;
    return { study: `/api/v1/studies/${studyUid}`, series: `/api/v1/studies/${studyUid}/series/${seriesUid}`,
        original: `/api/v1/download/${studyUid}/${seriesUid}/${sopUid}`,
        dicom: `/dicomweb/studies/${studyUid}/series/${seriesUid}/instances/${sopUid}`,
        dataset: `/api/v1/datasets/${f.dataset.id}`, manifest: `/api/v1/datasets/${f.dataset.id}/versions/1/manifest`,
        availability: `/api/v1/datasets/${f.dataset.id}/versions/1/availability`,
        member: `/api/v1/datasets/${f.dataset.id}/versions/1/members/${f.manifest.members[0].memberId}/original` };
}

for (const role of ['reader', 'contributor']) test(`${role} bearer has real archive access but cannot cross administrator route boundaries`, { timeout: 20000 }, async t => {
    const f = await setup(t), r = reference(f), token = f.credentials[role].token;
    for (const route of ['/api/v1/summary', '/api/v1/capabilities', '/api/v1/studies', r.study + '/series', r.series + '/instances',
        '/api/v1/datasets', r.dataset, r.dataset + '/readiness', r.manifest, r.member, '/api/v1/dataset-tools/download_dataset.py', r.dicom, r.dicom + '/metadata']) {
        const response = await f.request(route, { token }); assert.equal(response.status, 200, route); await response.body?.cancel();
    }
    const original = await f.request(r.original, { token }); assert.equal(original.status, 200); assert.deepEqual(Buffer.from(await original.arrayBuffer()), f.original);
    const exported = await f.request(r.study + '/export', { token }); assert.equal(exported.status, 200); await exported.arrayBuffer();
    const availability = await f.request(r.availability, { method: 'POST', token, body: { verifyHashes: true } }); assert.equal(availability.status, 200); assert.equal((await availability.json()).summary.available, 1);
    for (const route of ['/api/v1/identity', '/api/v1/auth/tokens', '/api/v1/access-policy', '/api/v1/connections', '/api/v1/jobs', '/api/v1/activity', '/api/v1/auth/activity']) {
        const response = await f.request(route, { token }); assert.equal(response.status, 403, route); await response.body?.cancel();
    }
    const before = f.app.archive.stats();
    for (const [route, method, body] of [
        ['/api/v1/auth/tokens', 'POST', { label: 'Escalation must fail', role: 'administrator', expiresInDays: 30 }],
        [`/api/v1/auth/tokens/${f.credentials.administrator.record.id}`, 'DELETE', undefined],
        ['/api/v1/access-policy', 'PUT', { version: 1, profile: 'local-research', dimse: { allowLoopback: true, peers: [] } }],
        ['/api/v1/connections', 'POST', { name: 'Unauthorized destination', type: 'dimse', host: '127.0.0.1', port: 9, calledAeTitle: 'NO_NETWORK' }],
        ['/api/v1/jobs', 'POST', { connectionId: 'untrusted', direction: 'send', selection: { studyUid: f.instance.studyUid } }],
        [r.study, 'DELETE', { confirmation: 'DELETE', revision: 'not-authorized' }],
        [r.dataset, 'DELETE', { confirmation: 'DELETE DATASET', revision: f.dataset.revision }]
    ]) {
        const response = await f.request(route, { method, token, body }); assert.equal(response.status, 403, method + ' ' + route); await response.body?.cancel();
    }
    assert.deepEqual(f.app.archive.stats(), before); assert.equal(f.app.connections.list().items.length, 0);
    assert.equal((await f.request('/api/v1/identity', { token: f.credentials.administrator.token })).status, 200, 'forbidden revocation cannot remove another credential');
});

test('reader cannot import or curate while contributor can import and create/freeze datasets', { timeout: 20000 }, async t => {
    const f = await setup(t), r = reference(f), reader = f.credentials.reader.token, contributor = f.credentials.contributor.token;
    for (const [route, body, headers] of [
        ['/api/v1/instances', createDicom({ rows: 8, columns: 8 }), { 'Content-Type': 'application/dicom' }],
        ['/api/v1/demo', {}, {}], ['/api/v1/datasets/demo', {}, {}],
        ['/api/v1/datasets', { name: 'Denied draft' }, {}], [r.dataset, { revision: f.dataset.revision, reviewNotes: 'Denied update' }, {}],
        [r.dataset + '/versions', { revision: f.dataset.revision }, {}], ['/dicomweb/studies', Buffer.from('not processed'), { 'Content-Type': 'multipart/related; type="application/dicom"; boundary=denied' }]
    ]) {
        const response = await f.request(route, { method: route === r.dataset ? 'PUT' : 'POST', token: reader, body, headers });
        assert.equal(response.status, 403, route); await response.body?.cancel();
    }
    assert.equal(f.app.archive.stats().instances, 1); assert.equal(f.app.datasets.get(f.dataset.id).versions.length, 1);
    let response = await f.request('/api/v1/instances', { method: 'POST', token: contributor, headers: { 'Content-Type': 'application/dicom' }, body: createDicom({ rows: 8, columns: 8 }) });
    assert.equal(response.status, 201);
    response = await f.request('/api/v1/datasets', { method: 'POST', token: contributor, body: { name: 'Contributor draft', selection: f.dataset.selection } });
    assert.equal(response.status, 201); let draft = await response.json();
    response = await f.request('/api/v1/datasets/' + draft.id, { method: 'PUT', token: contributor, body: { revision: draft.revision, reviewNotes: 'Generated contributor review' } });
    assert.equal(response.status, 200); draft = await response.json();
    response = await f.request(`/api/v1/datasets/${draft.id}/versions`, { method: 'POST', token: contributor, body: { revision: draft.revision } });
    assert.equal(response.status, 201); assert.equal((await response.json()).summary.instances, 1);
});

test('loopback research access never escalates supplied reader or invalid credentials into DICOMweb import rights', { timeout: 20000 }, async t => {
    const f = await setup(t, { accessProfile: 'local-research' }), reader = f.credentials.reader.token;
    assert.equal((await f.request('/dicomweb/studies')).status, 200);
    for (const token of [reader, 'invalid-bearer-value']) {
        const response = await f.request('/dicomweb/studies', { method: 'POST', token, body: Buffer.from('must not parse'), headers: { 'Content-Type': 'multipart/related; type="application/dicom"; boundary=not-imported' } });
        assert.equal(response.status, token === reader ? 403 : 401); await response.body?.cancel();
    }
    assert.equal(f.app.archive.stats().instances, 1);
    assert.equal((await f.request('/api/v1/summary')).status, 401, 'management never inherits anonymous research access');
});

test('token lifecycle is role-bound, secret-once, immediately revocable and persists across restart', { timeout: 20000 }, async t => {
    const f = await setup(t), administrator = f.credentials.administrator.token;
    const listing = await f.request('/api/v1/auth/tokens', { token: administrator }); assert.equal(listing.status, 200);
    const publicList = await listing.json(); assert.ok(publicList.items.some(item => item.id === f.credentials.reader.record.id));
    for (const item of Object.values(f.credentials)) { assert.ok(!JSON.stringify(publicList).includes(item.token)); assert.ok(!JSON.stringify(publicList).includes(digest(item.token))); }
    for (const body of [{ label: 'Bad role', role: 'owner', expiresInDays: 30 }, { label: 'Bad lifetime', role: 'reader', expiresInDays: 366 },
        { label: 'Bad scope', role: 'reader', expiresInDays: 30, permissions: ['identity.manage'] }]) {
        const response = await f.request('/api/v1/auth/tokens', { method: 'POST', token: administrator, body }); assert.equal(response.status, 400); await response.body?.cancel();
    }
    const revoked = await f.request('/api/v1/auth/tokens/' + f.credentials.reader.record.id, { method: 'DELETE', token: administrator }); assert.equal(revoked.status, 200); assert.equal((await revoked.json()).revoked, true);
    assert.equal((await f.request('/api/v1/summary', { token: f.credentials.reader.token })).status, 401);
    assert.equal((await f.request('/api/v1/summary', { token: f.credentials.contributor.token })).status, 200);
    await f.restart();
    assert.equal((await f.request('/api/v1/summary', { token: f.credentials.reader.token })).status, 401);
    assert.equal((await f.request('/api/v1/summary', { token: f.credentials.contributor.token })).status, 200);
    assert.equal((await f.request('/api/v1/summary', { session: true })).status, 401);
    const authState = await readFile(path.join(f.dataDir, 'auth.json'), 'utf8');
    for (const item of Object.values(f.credentials)) assert.ok(!authState.includes(item.token));
});

test('cookie mutations keep CSRF guards and unknown management mutations fail closed even for administrators', { timeout: 20000 }, async t => {
    const f = await setup(t);
    let response = await fetch(f.base + '/api/v1/auth/tokens', { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'CSRF must fail', role: 'administrator', expiresInDays: 30 }) });
    assert.equal(response.status, 403);
    response = await f.request('/api/v1/auth/tokens', { method: 'POST', session: true, body: { label: 'Foreign origin', role: 'reader', expiresInDays: 30 }, headers: { Origin: 'https://unrelated.invalid' } });
    assert.equal(response.status, 403);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        response = await f.request('/api/v1/not-a-declared-operation', { method, token: f.credentials.administrator.token, body: {} });
        assert.equal(response.status, 403, method); await response.body?.cancel();
    }
    for (const method of ['HEAD', 'OPTIONS']) {
        response = await f.request('/api/v1/auth/tokens', { method, token: f.credentials.reader.token }); assert.equal(response.status, 403, method); await response.body?.cancel();
        response = await f.request('/dicomweb/studies', { method }); assert.equal(response.status, 401, method); await response.body?.cancel();
    }
});

test('local password change requires a current local session and invalidates prior local sessions and tokens', { timeout: 20000 }, async t => {
    const f = await setup(t), nextPassword = 'generated-next-administrator-password';
    let response = await f.request('/api/v1/auth/password', { method: 'POST', token: f.credentials.administrator.token, body: { currentPassword: password, newPassword: nextPassword } });
    assert.equal(response.status, 403, 'a service token cannot change the local password');
    response = await f.request('/api/v1/auth/password', { method: 'POST', session: true, body: { currentPassword: 'incorrect-generated-password', newPassword: nextPassword } });
    assert.equal(response.status, 401);
    assert.equal((await f.request('/api/v1/summary', { token: f.credentials.administrator.token })).status, 200, 'failed change must not revoke credentials');
    response = await f.request('/api/v1/auth/password', { method: 'POST', session: true, body: { currentPassword: password, newPassword: nextPassword } });
    assert.equal(response.status, 200); assert.equal((await response.json()).reauthenticate, true);
    assert.equal((await f.request('/api/v1/summary', { session: true })).status, 401);
    for (const credential of Object.values(f.credentials)) assert.equal((await f.request('/api/v1/summary', { token: credential.token })).status, 401);
    response = await fetch(f.base + '/api/v1/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username: 'synthetic', password: nextPassword }) });
    assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(f.base + '/api/v1/identity', { headers: { Cookie: cookie } })).status, 200);
});

test('legacy scrypt administrator and hashed integration credential migrate without exposing or silently reducing their existing privilege', { timeout: 20000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'easi-store-legacy-auth-')), dataDir = path.join(directory, 'archive');
    await (await import('node:fs/promises')).mkdir(dataDir, { mode: 0o700 });
    const salt = randomBytes(16).toString('hex'), legacyToken = randomBytes(32).toString('base64url');
    const hash = Buffer.from(await scrypt(password, salt, 64)).toString('hex');
    await writeFile(path.join(dataDir, 'auth.json'), JSON.stringify({ version: 1, username: 'legacy-admin', salt, hash,
        apiTokens: [{ hash: digest(legacyToken), label: 'Generated legacy integration', createdAt: new Date().toISOString() }] }), { mode: 0o600 });
    const app = await createStoreServer({ dataDir, port: 0 }), address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
    t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    const headers = { Authorization: `Bearer ${legacyToken}` };
    let response = await fetch(base + '/api/v1/identity', { headers }); assert.equal(response.status, 200);
    assert.equal((await response.json()).identity.role, 'administrator');
    response = await fetch(base + '/api/v1/auth/tokens', { headers }); assert.equal(response.status, 200);
    const listing = await response.json(); assert.equal(listing.items.length, 1); assert.equal(listing.items[0].legacy, true);
    assert.equal(listing.items[0].role, 'administrator'); assert.ok(!JSON.stringify(listing).includes(legacyToken)); assert.ok(!JSON.stringify(listing).includes(digest(legacyToken)));
    const persisted = JSON.parse(await readFile(path.join(dataDir, 'auth.json'))); assert.equal(persisted.version, 2); assert.equal(persisted.hash, hash);
    response = await fetch(base + '/api/v1/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username: 'legacy-admin', password }) });
    assert.equal(response.status, 200);
    response = await fetch(base + '/api/v1/auth/tokens/' + listing.items[0].id, { method: 'DELETE', headers }); assert.equal(response.status, 200);
    assert.equal((await fetch(base + '/api/v1/summary', { headers })).status, 401);
});

test('security and import activity attribute principals while excluding credentials, passwords and denied input bodies', { timeout: 20000 }, async t => {
    const secret = 'GENERATED_CLIENT_SECRET_NOT_FOR_HTTP', marker = 'DENIED_BODY_NOT_FOR_AUDIT';
    const f = await setup(t, { authConfiguration: { mode: 'hybrid', oidc: { issuer: 'https://identity.example.invalid', clientId: 'synthetic-test-client', clientSecret: secret,
        callbackUrl: 'https://archive.example.invalid/api/v1/auth/oidc/callback', subjectRoles: { 'generated-subject': 'reader' }, groupRoles: {} } }, publicUrl: 'https://archive.example.invalid' });
    const administrator = f.credentials.administrator.token, contributor = f.credentials.contributor.token;
    let response = await f.request('/api/v1/identity', { token: administrator }); assert.equal(response.status, 200);
    const identity = await response.json(); assert.equal(identity.authentication.mode, 'hybrid');
    assert.ok(!JSON.stringify(identity).includes(secret)); assert.ok(!JSON.stringify(identity).includes('generated-subject'));
    response = await f.request('/api/v1/auth/tokens', { method: 'POST', token: f.credentials.reader.token, body: { label: marker, role: 'administrator', expiresInDays: 30 } });
    assert.equal(response.status, 403);
    response = await f.request('/api/v1/instances', { method: 'POST', token: contributor, headers: { 'Content-Type': 'application/dicom' }, body: createDicom({ rows: 8, columns: 8 }) });
    assert.equal(response.status, 201);
    response = await f.request('/api/v1/auth/activity', { token: administrator }); assert.equal(response.status, 200);
    const security = await response.json(); assert.ok(security.items.length > 0);
    assert.ok(security.items.some(item => item.actor?.id === 'token:' + f.credentials.reader.record.id && item.actor.role === 'reader' && item.outcome !== 'succeeded'));
    assert.ok(security.items.some(item => item.actor?.id === 'token:' + f.credentials.contributor.record.id && item.actor.role === 'contributor'));
    response = await f.request('/api/v1/activity', { token: administrator }); assert.equal(response.status, 200); const activity = await response.json();
    assert.ok(activity.items.some(item => JSON.parse(item.details || '{}').actor?.id === 'token:' + f.credentials.contributor.record.id));
    const serialized = JSON.stringify({ identity, security, activity });
    for (const text of [secret, marker, password, ...Object.values(f.credentials).map(credential => credential.token)]) assert.ok(!serialized.includes(text));
});

test('offline full backup/restore preserves credential roles and revocation while leaving browser sessions ephemeral', { timeout: 25000 }, async t => {
    const f = await setup(t), administrator = f.credentials.administrator.token;
    assert.equal((await f.request('/api/v1/auth/tokens/' + f.credentials.reader.record.id, { method: 'DELETE', token: administrator })).status, 200);
    await f.close();
    const backup = path.join(f.directory, 'backup'), restored = path.join(f.directory, 'restored');
    await execFile(process.execPath, [cli, 'backup', '--data-dir', f.dataDir, '--output', backup]);
    await execFile(process.execPath, [cli, 'restore', '--input', backup, '--data-dir', restored]);
    const app = await createStoreServer({ dataDir: restored, port: 0 }), address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
    t.after(() => app.close());
    const request = (route, token) => fetch(base + route, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await request('/api/v1/summary', f.credentials.reader.token)).status, 401);
    assert.equal((await request('/api/v1/summary', f.credentials.contributor.token)).status, 200);
    assert.equal((await request('/api/v1/identity', f.credentials.contributor.token)).status, 403);
    assert.equal(app.archive.db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(JSON.parse(await readFile(path.join(restored, 'auth.json'))).version, 2);
    const listing = await (await request('/api/v1/auth/tokens', administrator)).json();
    assert.equal(listing.items.find(item => item.id === f.credentials.reader.record.id).role, 'reader');
    assert.ok(listing.items.find(item => item.id === f.credentials.reader.record.id).revokedAt);
    assert.equal(listing.items.find(item => item.id === f.credentials.contributor.record.id).role, 'contributor');
    assert.equal((await fetch(base + '/api/v1/summary', { headers: { Cookie: f.cookie } })).status, 401);
    const r = reference(f), response = await request(r.original, f.credentials.contributor.token); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.original);
});

test('offline password-file recovery requires a stopped archive, revokes existing tokens and records the local operator without secret arguments', { timeout: 25000 }, async t => {
    const f = await setup(t), passwordFile = path.join(f.directory, 'private-recovery.json'), recoveredPassword = 'generated-offline-recovery-password';
    await writeFile(passwordFile, JSON.stringify({ username: 'synthetic', password: recoveredPassword }), { mode: 0o600 });
    await assert.rejects(execFile(process.execPath, [cli, 'reset-password', '--data-dir', f.dataDir, '--password-file', passwordFile]), /owns this archive/);
    assert.equal((await f.request('/api/v1/summary', { token: f.credentials.administrator.token })).status, 200);
    await f.close();
    const result = await execFile(process.execPath, [cli, 'reset-password', '--data-dir', f.dataDir, '--password-file', passwordFile]);
    assert.ok(!result.stdout.includes(recoveredPassword)); assert.ok(!result.stderr.includes(recoveredPassword));
    await f.restart();
    for (const credential of Object.values(f.credentials)) assert.equal((await f.request('/api/v1/summary', { token: credential.token })).status, 401);
    const response = await fetch(f.base + '/api/v1/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username: 'synthetic', password: recoveredPassword }) });
    assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie').split(';')[0];
    const security = await (await fetch(f.base + '/api/v1/auth/activity', { headers: { Cookie: cookie } })).json();
    assert.ok(security.items.some(item => item.action === 'identity.offline-recovery' && item.actor?.id === 'local-filesystem-operator' && item.outcome === 'succeeded'));
    assert.ok(!JSON.stringify(security).includes(recoveredPassword)); assert.equal(f.app.archive.stats().instances, 1);
});

test('real OIDC HTTP sessions enforce mapped roles, reject unmapped/replayed sign-ins and cannot change the local administrator password', { timeout: 25000 }, async t => {
    const provider = await createOidcFixture(t), reservation = createSocketServer();
    reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const publicUrl = `http://127.0.0.1:${port}`, configuration = provider.configuration({ callbackUrl: publicUrl + '/api/v1/auth/oidc/callback' });
    const f = await setup(t, { port, publicUrl, authConfiguration: configuration }), r = reference(f);
    async function signIn() {
        const started = await fetch(f.base + '/api/v1/auth/oidc/start', { method: 'POST', headers: jsonHeaders, body: '{}', redirect: 'manual' });
        assert.equal(started.status, 200); assert.match(started.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
        const transactionCookie = started.headers.get('set-cookie').split(';')[0];
        const callback = await provider.authorize((await started.json()).authorizationUrl);
        const response = await fetch(callback, { headers: { Cookie: transactionCookie }, redirect: 'manual' });
        assert.equal(response.status, 303);
        const session = response.headers.getSetCookie().find(value => value.startsWith('easi_store_session='));
        if (session) assert.match(session, /HttpOnly; SameSite=Strict/);
        return { response, callback, transactionCookie, cookie: session?.split(';')[0] };
    }
    const reader = await signIn(); assert.equal(reader.response.headers.get('location'), '/'); assert.ok(reader.cookie);
    let response = await fetch(f.base + '/api/v1/session', { headers: { Cookie: reader.cookie } });
    const session = await response.json(); assert.equal(session.identity.role, 'reader'); assert.equal(session.identity.source, 'oidc');
    assert.deepEqual(session.permissions, ['archive.read']);
    response = await fetch(f.base + r.original, { headers: { Cookie: reader.cookie } }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.original);
    response = await fetch(f.base + '/api/v1/instances', { method: 'POST', headers: { Cookie: reader.cookie, 'X-EASI-Store': '1', 'Content-Type': 'application/dicom' }, body: createDicom({ rows: 8, columns: 8 }) });
    assert.equal(response.status, 403);
    response = await fetch(reader.callback, { headers: { Cookie: reader.transactionCookie }, redirect: 'manual' });
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/?signin=failed');
    assert.ok(!response.headers.getSetCookie().some(value => value.startsWith('easi_store_session=')));
    provider.claims = { sub: 'unmapped-generated-subject', groups: ['not-mapped'], name: 'synthetic', email: 'synthetic@example.invalid' };
    const unmapped = await signIn(); assert.equal(unmapped.response.headers.get('location'), '/?signin=failed'); assert.equal(unmapped.cookie, undefined);
    provider.claims = { sub: 'mapped-generated-administrator', groups: ['research-admins'], name: 'Generated Organization Operator' };
    const organizationAdministrator = await signIn(); assert.ok(organizationAdministrator.cookie);
    response = await fetch(f.base + '/api/v1/identity', { headers: { Cookie: organizationAdministrator.cookie } }); assert.equal(response.status, 200);
    const identity = await response.json(); assert.equal(identity.identity.role, 'administrator'); assert.equal(identity.identity.source, 'oidc');
    assert.ok(!JSON.stringify(identity).includes(provider.clientSecret));
    response = await fetch(f.base + '/api/v1/auth/password', { method: 'POST', headers: { ...jsonHeaders, Cookie: organizationAdministrator.cookie }, body: JSON.stringify({ currentPassword: password, newPassword: 'generated-denied-external-password' }) });
    assert.equal(response.status, 403);
    response = await f.request('/api/v1/auth/password', { method: 'POST', session: true, body: { currentPassword: password, newPassword: 'generated-locally-rotated-password' } });
    assert.equal(response.status, 200);
    assert.equal((await fetch(f.base + '/api/v1/summary', { headers: { Cookie: organizationAdministrator.cookie } })).status, 200, 'local password rotation does not invalidate an independent OIDC session');
    assert.equal(f.app.archive.stats().instances, 1);
});
