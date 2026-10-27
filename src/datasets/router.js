import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { json, httpError, readJson } from '../http/utils.js';
import { createResearchDemo } from './demo.js';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const datasetPath = new RegExp(`^/api/v1/datasets/(${UUID})(?:/(.*))?$`);
const VERSION_PATH = /^versions\/([1-9][0-9]{0,8})(?:\/(.*))?$/;
const memberPath = new RegExp(`^members/(${UUID})/original$`);
const consumerFile = fileURLToPath(new URL('../../examples/datasets/download_dataset.py', import.meta.url));
const integrity = () => httpError(503, 'This snapshot original failed integrity verification. The download was stopped.');

/** Management-only dataset routes. The host enforces authentication/origin
 * checks and retains the archive read lease through each original response. */
export class DatasetRoutes {
    constructor({ service, maxDownloads = 4, maxChecks = 2, maxManifests = 2 }) {
        this.service = service; this.maxDownloads = maxDownloads; this.maxChecks = maxChecks;
        this.downloads = 0; this.checks = 0; this.controllers = new Set(); this.closed = false;
        this.manifests = 0; this.maxManifests = maxManifests;
        this.demoActive = false;
    }
    close() { this.closed = true; for (const controller of this.controllers) controller.abort(); }
    async handle(req, res, pathname) {
        if (pathname !== '/api/v1/dataset-tools/download_dataset.py' && pathname !== '/api/v1/datasets' && !pathname.startsWith('/api/v1/datasets/')) return false;
        if (this.closed) throw httpError(503, 'Dataset operations are shutting down.');
        if (pathname === '/api/v1/dataset-tools/download_dataset.py' && req.method === 'GET') {
            const script = await readFile(consumerFile);
            res.writeHead(200, { 'Content-Type': 'text/x-python; charset=utf-8', 'Content-Disposition': 'attachment; filename="download_dataset.py"', 'Content-Length': script.length });
            res.end(script); return true;
        }
        if (pathname === '/api/v1/datasets') {
            if (req.method === 'GET') { json(res, 200, await this.service.list()); return true; }
            if (req.method === 'POST') { json(res, 201, await this.service.create(await readJson(req, 262144))); return true; }
            return false;
        }
        if (pathname === '/api/v1/datasets/demo' && req.method === 'POST') {
            const body = await readJson(req, 1024);
            if (Object.keys(body).length) throw httpError(400, 'The generated research demo takes no parameters.');
            if (this.demoActive) throw httpError(429, 'A generated research cohort is already being imported.');
            const controller = new AbortController(); this.controllers.add(controller); this.demoActive = true;
            const canceled = () => { if (!res.writableFinished) controller.abort(); };
            req.on('aborted', canceled); res.on('close', canceled);
            try { json(res, 201, await createResearchDemo(this.service, { signal: controller.signal })); }
            finally { req.off('aborted', canceled); res.off('close', canceled); this.controllers.delete(controller); this.demoActive = false; }
            return true;
        }
        const match = pathname.match(datasetPath); if (!match) return false;
        const [, id, suffix = ''] = match;
        if (!suffix) {
            if (req.method === 'GET') { json(res, 200, await this.service.get(id)); return true; }
            if (req.method === 'PUT') { json(res, 200, await this.service.update(id, await readJson(req, 262144))); return true; }
            if (req.method === 'DELETE') { json(res, 200, await this.service.remove(id, await readJson(req, 1024))); return true; }
        }
        if (suffix === 'readiness' && req.method === 'GET') { json(res, 200, await this.service.readiness(id)); return true; }
        if (suffix === 'versions' && req.method === 'POST') { json(res, 201, await this.service.createSnapshot(id, await readJson(req, 4096))); return true; }
        const versionMatch = suffix.match(VERSION_PATH); if (!versionMatch) return false;
        const version = Number(versionMatch[1]), action = versionMatch[2];
        if (action === 'manifest' && req.method === 'GET') {
            if (this.manifests >= this.maxManifests) throw httpError(429, 'Dataset manifest readers are busy. Retry shortly.');
            this.manifests++;
            try {
                const text = await this.service.getManifestText(id, version), bytes = Buffer.from(text);
                const digest = createHash('sha256').update(bytes).digest('hex');
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
                    'Content-Disposition': `attachment; filename="dataset-${id}-v${version}.json"`,
                    'X-EASI-Manifest-SHA256': digest, ETag: `"sha256-${digest}"` });
                await pipeline(Readable.from([bytes]), res);
            } finally { this.manifests--; }
            return true;
        }
        if (action === 'availability' && req.method === 'POST') {
            const options = await readJson(req, 1024);
            if (Object.keys(options).some(key => key !== 'verifyHashes') || options.verifyHashes !== undefined && typeof options.verifyHashes !== 'boolean') throw httpError(400, 'Choose whether to verify snapshot content hashes.');
            if (this.checks >= this.maxChecks) throw httpError(429, 'Snapshot verification is busy. Retry after a check finishes.');
            const controller = new AbortController(); this.controllers.add(controller); this.checks++;
            const canceled = () => { if (!res.writableFinished) controller.abort(); };
            req.on('aborted', canceled); res.on('close', canceled);
            try { json(res, 200, await this.service.checkAvailability(id, version, { verifyHashes: options.verifyHashes ?? false, signal: controller.signal })); }
            finally { req.off('aborted', canceled); res.off('close', canceled); this.controllers.delete(controller); this.checks--; }
            return true;
        }
        const member = action?.match(memberPath);
        if (member && req.method === 'GET') {
            if (this.downloads >= this.maxDownloads) throw httpError(429, 'Dataset original readers are busy. Retry shortly.');
            this.downloads++;
            let handle;
            try {
                const record = await this.service.getMember(id, version, member[1]);
                const status = await this.service.inspectObject(record, { verifyHashes: false });
                if (status === 'missing') throw httpError(410, 'This snapshot original is no longer available.');
                if (status !== 'available') throw integrity();
                try { handle = await open(record.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
                catch { throw httpError(410, 'This snapshot original is no longer available.'); }
                const info = await handle.stat();
                if (!info.isFile() || info.size !== record.bytes) throw integrity();
                const hash = createHash('sha256'); let received = 0;
                const verify = new Transform({ transform(chunk, _encoding, callback) {
                    received += chunk.length;
                    if (received > record.bytes) return callback(integrity());
                    hash.update(chunk); callback(null, chunk);
                }, flush(callback) { callback(received === record.bytes && hash.digest('hex') === record.sha256 ? null : integrity()); } });
                res.writeHead(200, { 'Content-Type': 'application/dicom', 'Content-Length': record.bytes,
                    'Content-Disposition': `attachment; filename="${record.sopUid}.dcm"`, ETag: `"sha256-${record.sha256}"` });
                await pipeline(handle.createReadStream({ autoClose: false }), verify, res);
            } finally { await handle?.close(); this.downloads--; }
            return true;
        }
        return false;
    }
}
