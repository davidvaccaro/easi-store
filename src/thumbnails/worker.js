import { parentPort, workerData } from 'node:worker_threads';
import { renderThumbnail } from './render.js';
try {
    const png = renderThumbnail(new Uint8Array(workerData.bytes), workerData.metadata, workerData.transferSyntaxUid, workerData.frameNumber);
    parentPort.postMessage({ png }, [png.buffer]);
} catch (error) { parentPort.postMessage({ error: { message: error.message, statusCode: error.statusCode || 415 } }); }
