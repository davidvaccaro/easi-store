#!/usr/bin/env node
// Explicitly local corpus qualification. Reports and the disposable archive may
// contain medical identifiers: keep the entire output directory private.
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStoreServer } from '../src/server.js';
import { VERSION } from '../src/version.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function* files(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const name = path.join(directory, entry.name);
        if (entry.isDirectory()) yield* files(name);
        else if (entry.isFile()) yield name;
    }
}
async function hashBody(body) {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of body) { hash.update(chunk); bytes += chunk.length; }
    return { sha256: hash.digest('hex'), bytes };
}
export async function qualifyCorpus({ inputs, output, resume = false, keepArchive = false }) {
    if (!inputs?.length || !output) throw new Error('Provide explicit local input directories and a new private output directory.');
    const roots = await Promise.all(inputs.map(value => realpath(value))), destination = path.resolve(output);
    if (roots.some(root => destination === root || destination.startsWith(root + path.sep) || root.startsWith(destination + path.sep))) throw new Error('Corpus and output directories must be separate.');
    const markerPath = path.join(destination, 'qualification.json'), detailsPath = path.join(destination, 'instances.ndjson');
    const identity = digest(JSON.stringify(roots));
    if (!resume) {
        await mkdir(destination, { mode: 0o700 });
        await writeFile(markerPath, JSON.stringify({ schema: 1, version: VERSION, inputIdentity: identity, id: randomUUID() }), { flag: 'wx', mode: 0o600 });
    } else {
        const marker = JSON.parse(await readFile(markerPath, 'utf8'));
        if (marker.schema !== 1 || marker.version !== VERSION || marker.inputIdentity !== identity) throw new Error('Resume requires the same qualified version and input directories.');
    }
    const records = new Map();
    if (resume) {
        const existing = await readFile(detailsPath, 'utf8');
        for (const line of existing.trim().split('\n').filter(Boolean)) { const item = JSON.parse(line); records.set(item.key, item); }
    }
    const detail = await open(detailsPath, resume ? 'a' : 'wx', 0o600);
    let app, report;
    const start = Date.now();
    try {
        app = await createStoreServer({ dataDir: path.join(destination, 'archive'), port: 0, autoStartJobs: false });
        if (!app.auth.record) await app.auth.setup({ username: 'local-corpus-qualification', password: randomUUID() + randomUUID() }, '127.0.0.1');
        const token = await app.auth.issueApiToken('Local corpus qualification'), headers = { Authorization: `Bearer ${token}` };
        const address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
        const summarize = () => {
            const outcomes = {}, errors = {};
            for (const item of records.values()) {
                outcomes[item.outcome] = (outcomes[item.outcome] || 0) + 1;
                if (item.code) errors[item.code] = (errors[item.code] || 0) + 1;
            }
            return { version: VERSION, localOnly: true, originalInputsUnchanged: true, startedAt: new Date(start).toISOString(),
                updatedAt: new Date().toISOString(), elapsedSeconds: (Date.now() - start) / 1000,
                files: records.size, outcomes, errors, archive: app.archive.stats(),
                note: 'Per-file records and the archive are private. Acceptance, duplicate/conflict policy, retrieval integrity and viewer rendering are separate outcomes.' };
        };
        for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) for await (const file of files(roots[rootIndex])) {
            const info = await stat(file), relative = path.relative(roots[rootIndex], file), key = digest(`${rootIndex}\0${relative}\0${info.size}\0${info.mtimeMs}`);
            if (records.has(key)) continue;
            const record = { key, rootIndex, file: relative, bytes: info.size };
            const input = await open(file, 'r'); let part10;
            try { const prefix = Buffer.alloc(132); const { bytesRead } = await input.read(prefix, 0, 132, 0); part10 = bytesRead === 132 && prefix.toString('ascii', 128) === 'DICM'; }
            finally { await input.close(); }
            if (!part10) record.outcome = 'not-part10';
            else {
                const hash = createHash('sha256');
                async function* upload() { for await (const chunk of createReadStream(file)) { hash.update(chunk); yield chunk; } }
                try {
                    const response = await fetch(base + '/api/v1/instances', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/dicom', 'Content-Length': String(info.size) },
                        duplex: 'half', body: Readable.toWeb(Readable.from(upload())), signal: AbortSignal.timeout(120000) });
                    const result = await response.json(); record.httpStatus = response.status;
                    if (response.status === 200 || response.status === 201) {
                        const instance = result.instance, expected = hash.digest('hex');
                        const query = await fetch(`${base}/dicomweb/studies?StudyInstanceUID=${encodeURIComponent(instance.studyUid)}`, { headers });
                        if (query.status !== 200 || !(await query.json()).some(item => item['0020000D']?.Value?.[0] === instance.studyUid)) throw new Error('query-integrity');
                        const original = await fetch(`${base}/api/v1/download/${instance.studyUid}/${instance.seriesUid}/${instance.sopUid}`, { headers });
                        if (original.status !== 200) throw new Error('retrieval-status');
                        const returned = await hashBody(original.body);
                        if (expected !== instance.sha256 || returned.sha256 !== expected || returned.bytes !== info.size) throw new Error('retrieval-integrity');
                        record.outcome = result.status; record.verifiedSha256 = expected;
                    } else {
                        record.outcome = response.status === 409 ? 'conflict' : 'rejected'; record.code = result.error?.code || `HTTP_${response.status}`;
                        record.message = String(result.error?.message || '').slice(0, 512);
                    }
                } catch (error) { record.outcome = 'failed'; record.code = ['query-integrity', 'retrieval-status', 'retrieval-integrity'].includes(error.message) ? error.message : 'request-failed'; }
            }
            records.set(key, record); await detail.writeFile(JSON.stringify(record) + '\n');
            if (records.size % 100 === 0) {
                await detail.sync(); report = summarize();
                await writeFile(path.join(destination, 'progress.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
                console.log(JSON.stringify({ processed: records.size, elapsedSeconds: Math.round(report.elapsedSeconds), outcomes: report.outcomes }));
            }
        }
        await detail.sync(); report = summarize();
        let audit = await app.archive.health.startAudit({ verifyHashes: true });
        while (audit.status === 'running') { await delay(100); audit = app.archive.health.getAudit(audit.id); }
        report.integrityAudit = { status: audit.status, verifyHashes: audit.verifyHashes, progress: audit.progress, counts: audit.counts, findingsTruncated: audit.findingsTruncated, errorCode: audit.errorCode };
        report.completed = true; report.archiveRetained = keepArchive;
        report.passedIntegrity = !report.outcomes.failed && audit.status === 'completed' && Object.values(audit.counts).every(value => value === 0);
        await writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
        return report;
    } finally {
        await detail.close(); await app?.close();
        if (report?.completed && !keepArchive) await rm(path.join(destination, 'archive'), { recursive: true, force: true });
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = { inputs: [] };
    for (let index = 2; index < process.argv.length; index++) {
        const option = process.argv[index];
        if (option === '--input') options.inputs.push(process.argv[++index]);
        else if (option === '--output') options.output = process.argv[++index];
        else if (option === '--resume') options.resume = true;
        else if (option === '--keep-archive') options.keepArchive = true;
        else throw new Error('Usage: node scripts/qualify-corpus.mjs --input DIRECTORY [--input DIRECTORY] --output NEW_PRIVATE_DIRECTORY [--resume] [--keep-archive]');
    }
    const report = await qualifyCorpus(options); console.log(JSON.stringify(report, null, 2));
    if (!report.passedIntegrity) process.exitCode = 1;
}
