import { Worker } from 'node:worker_threads';
import { metadataService } from '../dicomweb/MetadataService.js';
import { httpError } from '../http/utils.js';

export class ThumbnailService {
    constructor() { this.active = 0; this.workers = new Set(); this.operations = new Set(); this.shutdown = new AbortController(); }
    async render(record, { frame = 1, signal } = {}) {
        if (this.shutdown.signal.aborted) throw httpError(503, 'Thumbnail service is shutting down.');
        const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
        const operation = this.performRender(record, { frame, signal: combined });
        this.operations.add(operation);
        try { return await operation; } finally { this.operations.delete(operation); }
    }
    async performRender(record, { frame, signal }) {
        signal.throwIfAborted();
        if (this.active >= 2) throw httpError(503, 'Thumbnail workers are busy. Retry shortly.');
        const release = metadataService.acquirePixelResponse();
        this.active++;
        let worker;
        try {
            const { metadata } = await metadataService.read(record, { signal });
            const [descriptor] = await metadataService.frames(record, [frame], { signal });
            if (descriptor.length > 32 * 1024 * 1024) throw httpError(415, 'This frame exceeds the thumbnail profile.');
            // Transfer one owned buffer to the worker. Avoid retaining multiple
            // full-sized copies of the frame while the worker renders it.
            const bytes = new Uint8Array(descriptor.length); let length = 0;
            for await (const part of metadataService.frameChunks(record, descriptor, { signal })) {
                signal.throwIfAborted();
                if (length + part.length > bytes.length) throw httpError(415, 'The original frame exceeds its declared geometry.');
                bytes.set(part, length); length += part.length;
            }
            if (length !== bytes.length) throw httpError(415, 'The original frame is truncated.');
            signal.throwIfAborted();
            worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { bytes: bytes.buffer, metadata, transferSyntaxUid: record.transferSyntaxUid, frameNumber: frame }, transferList: [bytes.buffer], resourceLimits: { maxOldGenerationSizeMb: 192 } });
            this.workers.add(worker);
            return await new Promise((resolve, reject) => {
                let settled = false;
                const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', canceled); error ? reject(error) : resolve(result); };
                const canceled = () => finish(signal.reason || httpError(499, 'Thumbnail request canceled.'));
                const timeout = setTimeout(() => finish(httpError(503, 'Thumbnail rendering timed out.')), 10000);
                signal?.addEventListener('abort', canceled, { once: true });
                worker.once('message', result => result.error ? finish(httpError(result.error.statusCode, result.error.message)) : finish(null, result.png));
                worker.once('error', () => finish(httpError(415, 'This image could not be rendered as a thumbnail.')));
                worker.once('exit', () => finish(httpError(503, 'Thumbnail worker stopped.')));
                if (signal?.aborted) canceled();
            });
        } finally {
            try { if (worker) { this.workers.delete(worker); await worker.terminate(); } }
            finally { this.active--; release(); }
        }
    }
    async close() {
        this.shutdown.abort(httpError(503, 'Thumbnail service is shutting down.'));
        await Promise.allSettled([...this.operations]);
        await Promise.allSettled([...this.workers].map(worker => worker.terminate()));
    }
}
