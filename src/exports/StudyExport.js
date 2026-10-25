import yazl from 'yazl';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ArchiveError, validUid } from '../archive/errors.js';
import { VERSION } from '../version.js';

const HASH = /^[a-f0-9]{64}$/;
const README = Buffer.from(`EASI Store original study export\n\nThis archive contains original DICOM Part 10 files and manifest.json. It is not\nan anonymized or de-identified export: identifying information may remain in\nDICOM attributes, private elements, overlays and image pixels. Keep the export\nprivate and transfer it only to an authorized destination.\n\nInstance paths use DICOM UIDs instead of patient names. manifest.json records\neach original's path, UID hierarchy, encoded size and SHA-256 from Store's\narchive catalog. Every original is hashed again while streaming and compared\nwith that catalog record. A failed integrity check aborts the download; use\nonly a completed ZIP with a valid central directory. Verify extracted files\nagainst the manifest before relying on a copy.\n\nOriginal bytes and transfer syntaxes are preserved; no image decoding,\ntranscoding or anonymization occurs. DIMSE intake generates a Part 10 header\naround the transmitted dataset; this export contains Store's archived file.\n\nLarge exports use ZIP64 automatically. Use an extraction tool that supports\nZIP64 when the archive exceeds classic ZIP limits. No DICOMDIR is generated.\nThe manifest is an export integrity inventory, not an archive-database backup.\n`);

const failed = (message, status = 500, code = 'export-failed') => new ArchiveError(message, status, code);
const integrity = () => failed('An archived original failed export integrity verification. The download was stopped.', 500, 'export-integrity-failed');

function inventory(record, studyUid) {
    if (!record || record.studyUid !== studyUid || ![record.studyUid, record.seriesUid, record.sopUid, record.sopClassUid, record.transferSyntaxUid].every(validUid)
        || !Number.isSafeInteger(record.bytes) || record.bytes < 1 || !HASH.test(record.sha256) || typeof record.path !== 'string') {
        throw integrity();
    }
    return { path: `DICOM/${record.studyUid}/${record.seriesUid}/${record.sopUid}.dcm`, studyUid: record.studyUid,
        seriesUid: record.seriesUid, sopUid: record.sopUid, sopClassUid: record.sopClassUid,
        transferSyntaxUid: record.transferSyntaxUid, bytes: record.bytes, sha256: record.sha256 };
}

function manifest(records, studyUid, { maxManifestBytes, maxStudyBytes }) {
    const seen = new Set(), series = new Set(); let bytes = 0, entryBytes = 0;
    for (const record of records) {
        const item = inventory(record, studyUid);
        if (seen.has(item.path)) throw integrity(); seen.add(item.path); series.add(item.seriesUid);
        bytes += item.bytes;
        if (!Number.isSafeInteger(bytes) || bytes > maxStudyBytes) throw failed('The selected study exceeds the configured export byte limit.', 413, 'export-too-large');
        entryBytes += Buffer.byteLength(JSON.stringify(item)) + (seen.size > 1 ? 2 : 0);
        if (entryBytes > maxManifestBytes) throw failed('The study integrity manifest exceeds the configured export limit.', 413, 'export-too-large');
    }
    const createdAt = new Date();
    const summary = { manifestVersion: 1, product: 'EASI Store', productVersion: VERSION, exportedAt: createdAt.toISOString(),
        studyUid, seriesCount: series.size, instanceCount: records.length, totalOriginalBytes: bytes, anonymized: false,
        integrity: { algorithm: 'SHA-256', verification: 'Original bytes verified against the archive catalog while streaming before successful export completion.' } };
    const prefix = Buffer.from(JSON.stringify(summary).slice(0, -1) + ',"instances":[\n'), suffix = Buffer.from('\n]}\n');
    const length = prefix.length + entryBytes + suffix.length;
    if (length > maxManifestBytes) throw failed('The study integrity manifest exceeds the configured export limit.', 413, 'export-too-large');
    return { createdAt, summary, length, stream(signal) {
        return Readable.from((async function* () {
            signal.throwIfAborted(); yield prefix;
            for (let index = 0; index < records.length; index++) {
                signal.throwIfAborted();
                yield Buffer.from((index ? ',\n' : '') + JSON.stringify(inventory(records[index], studyUid)));
            }
            yield suffix;
        })(), { objectMode: false, highWaterMark: 65536 });
    } };
}

/** Streams original DICOM files, with one lazy original reader per export.
 * Authentication belongs to the host route. The archive lease covers snapshot,
 * file verification and the entire HTTP stream, excluding concurrent deletion.
 */
export class StudyExportService {
    constructor({ maxConcurrent = 2, maxInstances = 100000, maxManifestBytes = 64 * 1024 * 1024,
        maxStudyBytes = 1024 ** 4, operationTimeoutMs = 60 * 60 * 1000, forceZip64Format = false } = {}) {
        if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4
            || !Number.isInteger(maxInstances) || maxInstances < 1 || maxInstances > 100000
            || !Number.isInteger(maxManifestBytes) || maxManifestBytes < 1024 || maxManifestBytes > 64 * 1024 * 1024
            || !Number.isSafeInteger(maxStudyBytes) || maxStudyBytes < 1 || maxStudyBytes > 1024 ** 4
            || !Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 10 || operationTimeoutMs > 24 * 60 * 60 * 1000
            || typeof forceZip64Format !== 'boolean') throw new TypeError('Configure bounded study export limits.');
        Object.assign(this, { maxConcurrent, maxInstances, maxManifestBytes, maxStudyBytes, operationTimeoutMs, forceZip64Format });
        this.active = new Set(); this.originals = new Set(); this.originalsOpened = 0; this.originalBytesRead = 0; this.closed = false;
    }

    async export(request, response, archive, studyUid, { signal } = {}) {
        if (!validUid(studyUid)) throw failed('Use a valid Study Instance UID.', 400, 'invalid-study');
        if (this.closed) throw failed('The export service is stopping.', 503, 'export-unavailable');
        if (this.active.size >= this.maxConcurrent) throw failed('The study export service is busy. Retry after an active download finishes.', 429, 'export-busy');
        if (typeof archive?.acquireReadLease !== 'function' || typeof archive?.snapshotStudyOriginals !== 'function') throw new TypeError('Study export requires archive read leases and original snapshots.');
        signal?.throwIfAborted();
        const release = archive.acquireReadLease(), controller = new AbortController();
        let completed; const done = new Promise(resolve => { completed = resolve; });
        const operation = { controller, done, tasks: new Set(), handles: new Set(), streams: new Set(), error: null };
        this.active.add(operation);
        const timeout = setTimeout(() => controller.abort(failed('The study export exceeded its time limit.', 504, 'export-timeout')), this.operationTimeoutMs);
        const canceled = () => { if (!response.writableFinished) controller.abort(); };
        const externalCancel = () => controller.abort();
        response.on('close', canceled); request.on('aborted', canceled); signal?.addEventListener('abort', externalCancel, { once: true });
        let zip;
        try {
            controller.signal.throwIfAborted();
            const records = archive.snapshotStudyOriginals(studyUid, { maxInstances: this.maxInstances });
            if (!Array.isArray(records) || !records.length) throw failed('The selected study was not found.', 404, 'study-not-found');
            if (records.length > this.maxInstances) throw failed('The selected study exceeds the configured instance export limit.', 413, 'export-too-large');
            const document = manifest(records, studyUid, this);
            zip = new yazl.ZipFile();
            const stop = error => {
                if (controller.signal.aborted && !operation.error) { zip.outputStream.destroy(); return; }
                operation.error ||= error instanceof ArchiveError ? error : integrity();
                controller.abort(operation.error); zip.outputStream.destroy(operation.error);
            };
            operation.stop = stop;
            zip.on('error', stop); zip.outputStream.on('error', () => {});
            const entryOptions = { mtime: document.createdAt, mode: 0o100600, compress: false, forceZip64Format: this.forceZip64Format };
            zip.addBuffer(README, 'README.txt', entryOptions);
            for (const record of records) {
                const item = inventory(record, studyUid);
                zip.addReadStreamLazy(item.path, { ...entryOptions, size: record.bytes }, callback => {
                    const task = this.openOriginal(record, operation).then(stream => {
                        if (controller.signal.aborted) { stream.destroy(); callback(controller.signal.reason || new DOMException('Canceled', 'AbortError')); }
                        else callback(null, stream);
                    }, error => callback(error instanceof ArchiveError ? error : integrity()));
                    operation.tasks.add(task); void task.finally(() => operation.tasks.delete(task)).catch(() => {});
                });
            }
            zip.addReadStreamLazy('manifest.json', { ...entryOptions, size: document.length, compress: true }, callback => {
                if (controller.signal.aborted) callback(controller.signal.reason || new DOMException('Canceled', 'AbortError'));
                else {
                    const stream = document.stream(controller.signal); operation.streams.add(stream);
                    stream.on('error', stop); stream.once('close', () => operation.streams.delete(stream)); callback(null, stream);
                }
            });
            zip.end({ forceZip64Format: this.forceZip64Format });
            response.setHeader('Content-Type', 'application/zip');
            response.setHeader('Content-Disposition', `attachment; filename="easi-study-${studyUid}.zip"`);
            response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
            await pipeline(zip.outputStream, response, { signal: controller.signal });
            return { studyUid, instanceCount: document.summary.instanceCount, bytes: document.summary.totalOriginalBytes };
        } catch (error) {
            if (operation.error) throw operation.error;
            if (controller.signal.aborted && controller.signal.reason instanceof ArchiveError) throw controller.signal.reason;
            throw error;
        } finally {
            clearTimeout(timeout); controller.abort(); zip?.outputStream.destroy();
            for (const stream of operation.streams) stream.destroy();
            await Promise.allSettled([...operation.tasks]);
            await Promise.allSettled([...operation.handles].map(handle => handle.close()));
            response.off('close', canceled); request.off('aborted', canceled); signal?.removeEventListener('abort', externalCancel);
            this.active.delete(operation); release(); completed();
        }
    }

    async openOriginal(record, operation) {
        const signal = operation.controller.signal;
        signal.throwIfAborted();
        const handle = await open(record.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); operation.handles.add(handle);
        try {
            signal.throwIfAborted();
            const information = await handle.stat();
            if (!information.isFile() || information.size !== record.bytes) throw integrity();
            signal.throwIfAborted();
            const hash = createHash('sha256'); let length = 0;
            const verify = new Transform({ highWaterMark: 65536,
                transform: (chunk, _encoding, callback) => {
                    length += chunk.length; this.originalBytesRead += chunk.length; hash.update(chunk);
                    if (length > record.bytes) callback(integrity()); else callback(null, chunk);
                },
                flush: callback => callback(length === record.bytes && hash.digest('hex') === record.sha256 ? null : integrity()) });
            verify.on('error', () => {});
            const source = handle.createReadStream({ autoClose: true, highWaterMark: 65536, signal });
            const original = { source, verify }; this.originals.add(original); this.originalsOpened++;
            operation.streams.add(source); operation.streams.add(verify);
            const task = pipeline(source, verify, { signal }).catch(error => {
                if (!signal.aborted) operation.stop(error instanceof ArchiveError ? error : integrity());
                throw error;
            }).finally(() => {
                operation.handles.delete(handle); operation.streams.delete(source); operation.streams.delete(verify); this.originals.delete(original);
            });
            operation.tasks.add(task); void task.finally(() => operation.tasks.delete(task)).catch(() => {});
            return verify;
        } catch (error) { operation.handles.delete(handle); await handle.close(); throw error; }
    }

    getState() { return Object.freeze({ activeExports: this.active.size, activeOriginalReaders: this.originals.size,
        originalsOpened: this.originalsOpened, originalBytesRead: this.originalBytesRead }); }
    async close() {
        this.closed = true;
        const operations = [...this.active];
        for (const operation of operations) operation.controller.abort();
        await Promise.allSettled(operations.map(operation => operation.done));
    }
}

export function createStudyExportService(options) { return new StudyExportService(options); }
