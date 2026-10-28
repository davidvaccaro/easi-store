import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, stat, readdir, unlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { JpegRgbaEncoder } from '@xinonix/easi-js/codecs';
import { createStoreServer } from '../src/server.js';
import { createDicom, uid, part10Header, element } from './fixtures/synthetic.js';
import { advancedDicom, encapsulated } from './fixtures/advanced-dicom.js';

const script = fileURLToPath(new URL('../examples/datasets/download_dataset.py', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function within(promise, message, milliseconds = 10000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
    finally { clearTimeout(timer); }
}
function consumer(t, { base, datasetId, version = 1, output, token = '', args = [] }) {
    const environment = { ...process.env, EASI_DATASET_TEST_TOKEN: token, PYTHONDONTWRITEBYTECODE: '1' };
    const child = spawn(python, [script, '--base-url', base, '--dataset', datasetId, '--version', String(version),
        '--output', output, '--token-env', 'EASI_DATASET_TEST_TOKEN', '--timeout', '3', ...args], { env: environment });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-65536); });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-65536); });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, summary: stdout.trim() ? JSON.parse(stdout.trim().split('\n').at(-1)) : null }));
    });
    return { child, done: within(done, 'The independent Python consumer did not finish within twenty seconds.', 20000) };
}
async function fixture(t, { originals, split = { seed: 'consumer-proof', ratios: { train: .7, validation: .2, test: .1 } } } = {}) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'easi-store-dataset-consumer-')));
    const app = await createStoreServer({ dataDir: join(directory, 'archive'), port: 0, accessProfile: 'local-research' });
    const address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
    t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    await app.auth.setup({ username: 'synthetic', password: 'synthetic-dataset-password' }, '127.0.0.1');
    const token = await app.auth.issueApiToken('Disposable Python dataset integration');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-EASI-Store': '1' };
    const studyUid = uid(), secondStudy = uid();
    if (!originals) {
        const rgba = new Uint8Array(8 * 8 * 4); for (let index = 0; index < rgba.length; index += 4) rgba.set([70, 120, 190, 255], index);
        let jpeg = Buffer.from(new JpegRgbaEncoder().encode(rgba, 8, 8, { quality: 90 }).bytes);
        if (jpeg.length % 2) jpeg = Buffer.concat([jpeg, Buffer.from([0])]);
        const report = { studyUid, seriesUid: uid(), sopUid: uid(), sopClassUid: '1.2.840.10008.5.1.4.1.1.88.11' };
        originals = [
            createDicom({ studyUid, patientId: 'SYNTHETIC-ONLY', issuer: 'EASI-TEST', frames: 3, rows: 8, columns: 8 }),
            createDicom({ studyUid: secondStudy, patientId: 'SYNTHETIC-ONLY', issuer: 'EASI-TEST', rows: 8, columns: 8 }),
            createDicom({ studyUid: uid(), patientId: 'OTHER-SYNTHETIC', issuer: 'EASI-TEST', rows: 8, columns: 8 }),
            advancedDicom({ studyUid, syntax: '1.2.840.10008.1.2.4.50', frames: 2, rows: 8, columns: 8, samples: 3, bits: 8,
                photometric: 'YBR_FULL', pixelElement: encapsulated([[jpeg], [jpeg]]) }).bytes,
            Buffer.concat([part10Header(report), ...[
                ['00080016', 'UI', report.sopClassUid], ['00080018', 'UI', report.sopUid], ['00080060', 'CS', 'SR'],
                ['00100010', 'PN', 'Synthetic^Report'], ['00100020', 'LO', 'SYNTHETIC-ONLY'], ['00100021', 'LO', 'EASI-TEST'],
                ['0020000D', 'UI', report.studyUid], ['0020000E', 'UI', report.seriesUid], ['0040A160', 'UT', 'Generated technical test report.']
            ].map(([tag, vr, value]) => element(tag, vr, value))])
        ];
    }
    const selection = [], expected = new Map();
    for (const bytes of originals) {
        const { instance } = await app.archive.ingest(Readable.from([bytes]));
        expected.set(instance.sopUid, bytes);
        if (!selection.some(item => item.studyUid === instance.studyUid && item.seriesUid === instance.seriesUid)) selection.push({ studyUid: instance.studyUid, seriesUid: instance.seriesUid });
    }
    let response = await fetch(base + '/api/v1/datasets', { method: 'POST', headers, body: JSON.stringify({ name: 'Synthetic consumer qualification', selection }) });
    assert.equal(response.status, 201); const dataset = await response.json();
    response = await fetch(`${base}/api/v1/datasets/${dataset.id}/versions`, { method: 'POST', headers,
        body: JSON.stringify({ revision: dataset.revision, split }) });
    assert.equal(response.status, 201); const version = await response.json();
    const manifestResponse = await fetch(`${base}/api/v1/datasets/${dataset.id}/versions/1/manifest`, { headers });
    assert.equal(manifestResponse.status, 200); const raw = Buffer.from(await manifestResponse.arrayBuffer()), manifest = JSON.parse(raw);
    const administrator = app.auth.identify({headers: {authorization: `Bearer ${token}`}});
    const downloadCredential = await app.auth.createApiToken({label: 'Read-only Python dataset consumer', role: 'reader', expiresInDays: 1}, administrator);
    return { app, directory, base, token: downloadCredential.token, headers, datasetId: dataset.id, versionReceipt: version, manifest, raw, expected };
}

async function localFiles(fixture, output) {
    for (const member of fixture.manifest.members) {
        const bytes = await readFile(join(output, 'originals', member.memberId + '.dcm'));
        assert.deepEqual(bytes, fixture.expected.get(member.sopUid)); assert.equal(sha(bytes), member.sha256);
    }
}

test('independent Python client authenticates with read-only credentials, freezes exact encoded originals and resumes by hashing existing files', { timeout: 30000 }, async t => {
    const f = await fixture(t), output = join(f.directory, 'download');
    // A newly imported instance in an already selected series must not expand
    // the earlier frozen version consumed by Python.
    const selected = f.manifest.members[0], identity = f.app.archive.getInstance(selected.studyUid, selected.seriesUid, selected.sopUid);
    await f.app.archive.ingest(Readable.from([createDicom({ studyUid: selected.studyUid, seriesUid: selected.seriesUid, patientId: identity.patientId, issuer: identity.issuer, rows: 8, columns: 8 })]));
    assert.equal(f.app.archive.stats().instances, 6);
    assert.equal((await fetch(`${f.base}/api/v1/datasets/${f.datasetId}/versions/1/manifest`)).status, 401, 'research mode does not make dataset management public');
    let result = await consumer(t, { ...f, output, token: '' }).done;
    assert.equal(result.code, 1, result.stderr || result.stdout); assert.equal(result.summary.error.code, 'authentication-required');
    result = await consumer(t, { ...f, output, args: ['--manifest-sha256', f.versionReceipt.manifestSha256] }).done;
    assert.equal(result.code, 0, result.stdout); assert.equal(result.summary.complete, true); assert.equal(result.summary.counts.downloaded, 5);
    assert.deepEqual(await readFile(join(output, 'manifest.json')), f.raw); await localFiles(f, output);
    const provenance = JSON.parse(await readFile(join(output, 'provenance.json')));
    assert.equal(provenance.manifestSha256, sha(f.raw)); assert.equal(provenance.manifestSha256, f.versionReceipt.manifestSha256);
    const datalist = JSON.parse(await readFile(join(output, 'datalist.json')));
    const images = [...datalist.training, ...datalist.validation, ...datalist.test, ...datalist.unassigned];
    assert.equal(images.length, 4); assert.equal(datalist.dicom_objects.length, 1); assert.equal(datalist.dicom_objects[0].role, 'structured-report');
    assert.ok(images.every(item => typeof item.image === 'string' && !Object.hasOwn(item, 'label')));
    const subjectPartitions = new Map();
    for (const item of [...images, ...datalist.dicom_objects]) {
        const member = f.manifest.members.find(member => member.memberId === item.memberId);
        assert.equal(item.subjectId, member.subjectId); assert.equal(item.partition, member.partition);
        if (subjectPartitions.has(item.subjectId)) assert.equal(subjectPartitions.get(item.subjectId), item.partition);
        subjectPartitions.set(item.subjectId, item.partition);
    }
    assert.equal(subjectPartitions.size, 2); assert.equal(datalist.unassigned.length, 0);
    assert.ok(f.manifest.members.some(member => member.transferSyntaxUid === '1.2.840.10008.1.2.4.50' && member.frames === 2));
    assert.ok(f.manifest.members.some(member => member.frames === 3));
    result = await consumer(t, { ...f, output }).done;
    assert.equal(result.code, 0); assert.equal(result.summary.counts['verified-existing'], 5); assert.equal(result.summary.counts.downloaded, 0);
    const damaged = f.manifest.members[0]; await writeFile(join(output, 'originals', damaged.memberId + '.dcm'), Buffer.alloc(damaged.bytes));
    result = await consumer(t, { ...f, output }).done;
    assert.equal(result.code, 0); assert.equal(result.summary.counts.downloaded, 1); assert.equal(result.summary.counts['verified-existing'], 4); await localFiles(f, output);
    const directoryEntries = await readdir(output);
    for (const name of directoryEntries.filter(name => name.endsWith('.json'))) assert.ok(!(await readFile(join(output, name), 'utf8')).includes(f.token));
});

for (const mode of ['missing', 'corrupt']) test(`Python consumer explicitly fails a ${mode} frozen original and never produces a completed datalist`, { timeout: 20000 }, async t => {
    const f = await fixture(t, { originals: [createDicom({ rows: 8, columns: 8 })] }), output = join(f.directory, 'download');
    const member = f.manifest.members[0], original = f.app.archive.getInstance(member.studyUid, member.seriesUid, member.sopUid);
    if (mode === 'missing') await unlink(original.path);
    else await writeFile(original.path, Buffer.alloc(member.bytes, 55));
    const result = await consumer(t, { ...f, output }).done;
    assert.equal(result.code, 1, result.stderr || result.stdout); assert.equal(result.summary.complete, false); assert.equal(result.summary.counts.failed, 1);
    const report = JSON.parse(await readFile(join(output, 'report.json')));
    assert.equal(report.complete, false); assert.equal(report.members[0].status, 'failed');
    await assert.rejects(stat(join(output, 'datalist.json')), { code: 'ENOENT' });
    await assert.rejects(stat(join(output, 'originals', member.memberId + '.dcm')), { code: 'ENOENT' });
});

test('Python consumer rejects a changed pinned manifest before issuing any member requests', { timeout: 20000 }, async t => {
    const f = await fixture(t), output = join(f.directory, 'download');
    const result = await consumer(t, { ...f, output, args: ['--manifest-sha256', 'a'.repeat(64)] }).done;
    assert.equal(result.code, 1, result.stderr || result.stdout); assert.equal(result.summary.error.code, 'manifest-hash-mismatch');
    await assert.rejects(stat(join(output, 'originals')), { code: 'ENOENT' });
});

async function httpFixture(t, handler) {
    const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return `http://127.0.0.1:${server.address().port}`;
}

for (const mode of ['redirect', 'member-path', 'split-conflict']) test(`Python consumer refuses ${mode} without credential forwarding or manifest expansion`, { timeout: 20000 }, async t => {
    const f = await fixture(t), output = join(f.directory, 'download');
    let destinationRequests = 0, memberRequests = 0;
    const destination = await httpFixture(t, (_req, res) => { destinationRequests++; res.end('must never be fetched'); });
    const manifest = structuredClone(f.manifest);
    if (mode === 'member-path') manifest.members[0].originalPath = destination + '/untrusted?secret=DO_NOT_LEAK_UNTRUSTED';
    if (mode === 'split-conflict') {
        const repeated = manifest.members.find(candidate => manifest.members.filter(member => member.subjectId === candidate.subjectId).length > 1);
        const group = manifest.members.filter(member => member.subjectId === repeated.subjectId);
        assert.ok(group.length > 1); group[1].partition = group[0].partition === 'train' ? 'test' : 'train';
    }
    const base = await httpFixture(t, (req, res) => {
        if (req.headers.authorization !== `Bearer ${f.token}`) { res.writeHead(401).end(); return; }
        if (req.url.endsWith('/manifest')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(manifest)); return; }
        memberRequests++;
        res.writeHead(302, { Location: destination + '/untrusted?secret=DO_NOT_LEAK_UNTRUSTED' }); res.end();
    });
    const result = await consumer(t, { ...f, base, output }).done;
    assert.equal(result.code, 1, result.stderr || result.stdout); assert.equal(destinationRequests, 0);
    if (mode === 'redirect') {
        assert.equal(memberRequests, manifest.members.length);
        const report = JSON.parse(await readFile(join(output, 'report.json')));
        assert.ok(report.members.every(member => member.error.code === 'redirect-refused'));
        assert.ok(!JSON.stringify(report).includes('DO_NOT_LEAK_UNTRUSTED')); assert.ok(!JSON.stringify(report).includes(f.token));
    } else {
        assert.equal(memberRequests, 0);
        assert.equal(result.summary.error.code, mode === 'member-path' ? 'invalid-member-path' : 'split-conflict');
    }
    await assert.rejects(stat(join(output, 'datalist.json')), { code: 'ENOENT' });
});

test('Python consumer rejects linked output parents and cannot overwrite a linked original', { timeout: 20000 }, async t => {
    const f = await fixture(t, { originals: [createDicom({ rows: 8, columns: 8 })] });
    const victim = join(f.directory, 'unrelated.txt'), sentinel = Buffer.from('Unrelated private synthetic file; never modify.');
    await writeFile(victim, sentinel);
    const parentLink = join(f.directory, 'linked-parent');
    await symlink(f.directory, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
    let result = await consumer(t, { ...f, output: join(parentLink, 'download') }).done;
    assert.equal(result.code, 1); assert.equal(result.summary.error.code, 'unsafe-output');
    if (process.platform !== 'win32') {
        const output = join(f.directory, 'download');
        result = await consumer(t, { ...f, output }).done; assert.equal(result.code, 0);
        const file = join(output, 'originals', f.manifest.members[0].memberId + '.dcm');
        await unlink(file); await symlink(victim, file);
        result = await consumer(t, { ...f, output }).done;
        assert.equal(result.code, 1); const report = JSON.parse(await readFile(join(output, 'report.json')));
        assert.equal(report.members[0].error.code, 'unsafe-output');
        await assert.rejects(stat(join(output, 'datalist.json')), { code: 'ENOENT' });
    }
    assert.deepEqual(await readFile(victim), sentinel);
});

test('interrupted independent Python download retains verified files and resumes the exact frozen membership', { timeout: 30000 }, async t => {
    const studyUid = uid(), seriesUid = uid();
    const f = await fixture(t, { originals: [1, 2, 3].map(instanceNumber => createDicom({ studyUid, seriesUid, instanceNumber, rows: 512, columns: 512, frames: 4 })) });
    const output = join(f.directory, 'download'); let memberRequests = 0, secondEntered, releaseSecond;
    const entered = new Promise(resolve => { secondEntered = resolve; });
    const gate = new Promise(resolve => { releaseSecond = resolve; });
    t.after(() => releaseSecond());
    const base = await httpFixture(t, (req, res) => {
        const original = req.url.endsWith('/original'), second = original && ++memberRequests === 2;
        const upstream = request(f.base + req.url, { headers: req.headers }, incoming => {
            res.writeHead(incoming.statusCode, incoming.headers);
            if (second) {
                incoming.pause(); secondEntered();
                gate.then(() => { if (!res.destroyed) incoming.pipe(res); else incoming.destroy(); });
            } else incoming.pipe(res);
            res.once('close', () => incoming.destroy());
        });
        upstream.on('error', () => res.destroy()); upstream.end();
    });
    const firstRun = consumer(t, { ...f, base, output, args: ['--workers', '1'] });
    await within(entered, 'The consumer did not begin its second original.');
    const firstMember = f.manifest.members[0], firstFile = join(output, 'originals', firstMember.memberId + '.dcm');
    assert.equal(sha(await readFile(firstFile)), firstMember.sha256);
    firstRun.child.kill('SIGTERM'); await pause(30); releaseSecond();
    const interrupted = await firstRun.done;
    if (process.platform !== 'win32') {
        assert.equal(interrupted.code, 1, interrupted.stderr || interrupted.stdout);
        const report = JSON.parse(await readFile(join(output, 'report.json')));
        assert.equal(report.interrupted, true); assert.equal(report.complete, false); assert.equal(report.counts.downloaded, 1);
    }
    assert.equal(memberRequests, 2, 'interruption must not expand or schedule the third original');
    await assert.rejects(stat(join(output, 'datalist.json')), { code: 'ENOENT' });
    const resumed = await consumer(t, { ...f, output, args: ['--workers', '1'] }).done;
    assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout);
    assert.equal(resumed.summary.counts['verified-existing'], 1); assert.equal(resumed.summary.counts.downloaded, 2);
    assert.deepEqual(await readFile(join(output, 'manifest.json')), f.raw); await localFiles(f, output);
});

test('Python datalist keeps unsplit subjects unassigned and refuses changed manifest bytes in an existing output', { timeout: 20000 }, async t => {
    const f = await fixture(t, { originals: [createDicom({ rows: 8, columns: 8 })], split: null }), output = join(f.directory, 'download');
    let result = await consumer(t, { ...f, output }).done; assert.equal(result.code, 0, result.stderr || result.stdout);
    const datalist = JSON.parse(await readFile(join(output, 'datalist.json')));
    assert.equal(datalist.unassigned.length, 1); assert.equal(datalist.training.length, 0); assert.equal(datalist.validation.length, 0); assert.equal(datalist.test.length, 0);
    assert.equal(datalist.unassigned[0].partition, null);
    let originalRequests = 0;
    const base = await httpFixture(t, (req, res) => {
        if (req.url.endsWith('/manifest')) { res.setHeader('Content-Type', 'application/json'); res.end(f.raw + '\n'); }
        else { originalRequests++; res.writeHead(500).end(); }
    });
    result = await consumer(t, { ...f, base, output }).done;
    assert.equal(result.code, 1); assert.equal(result.summary.error.code, 'snapshot-changed'); assert.equal(originalRequests, 0);
    assert.deepEqual(await readFile(join(output, 'manifest.json')), f.raw); await localFiles(f, output);
    await assert.rejects(stat(join(output, 'datalist.json')), { code: 'ENOENT' });
});
