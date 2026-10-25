import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive } from './archive/Archive.js';
import { handleDicomweb } from './dicomweb/router.js';
import { Auth, isLoopback } from './http/Auth.js';
import { AccessPolicy, isLoopbackAddress } from './http/AccessPolicy.js';
import { createStudyExportService } from './exports/StudyExport.js';
import { json, httpError, readJson } from './http/utils.js';
import { createDemoStudy } from './synthetic.js';
import { ConnectionService, handleConnectionRoutes } from './connections/ConnectionService.js';
import { ThumbnailService } from './thumbnails/ThumbnailService.js';
import { VERSION } from './version.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };
export const CAPABILITIES = {
    name: 'EASI Store', version: VERSION, status: 'v1 workflow preview', standardBaseline: 'DICOM PS3.18 2026d',
    dicomweb: { basePath: '/dicomweb', qido: ['studies', 'series', 'instances'],
        stow: ['multipart/related; type="application/dicom"'], wado: ['original instances', 'original series', 'original studies'],
        transcoding: { completeInstance: false, nativeFrames: 'Little Endian word conversion; original compressed frames preserved' },
        metadata: ['study', 'series', 'instance'], frames: true, bulkdata: true, rendered: false, fullConformance: false },
    archive: { storage: 'Filesystem with SHA-256 integrity', catalog: 'SQLite WAL',
        duplicates: 'Byte-identical reimports are idempotent; conflicting SOP Instance UIDs are rejected.',
        originalBytesPreserved: true, patientIdentity: 'Patient ID + issuer; missing issuer scoped to source.' },
    security: { localAdmin: true, apiBearerTokens: true, externalIdentity: false },
    viewer: { name: 'EASI View', version: '1.0.0-rc.1', releaseCandidate: true, loading: 'Metadata-first DICOMweb; requested originals loaded on demand' },
    management: { originalStudyExport: 'Streaming ZIP/ZIP64 with SHA-256 manifest',
        studyRemoval: { previewRequired: true, confirmation: 'DELETE', scope: 'Store archival copies only' } },
    dimse: { enabled: false, roles: ['C-ECHO SCP/SCU', 'C-STORE SCP/SCU', 'C-FIND SCP/SCU', 'C-GET SCP/SCU', 'C-MOVE SCP'],
        queryRetrieve: ['Study Root', 'Patient Root'], moveDestinations: 'Explicitly configured peers only', tls: false },
    connections: { configuredPeers: ['dicomweb', 'dimse'], transferJobs: true, restartRecovery: true, retry: true, cancel: true },
    thumbnails: { managementApi: true, profile: 'Native 8/16-bit monochrome, native 8-bit RGB/YBR, 8-bit baseline JPEG grayscale/YBR' },
    limitations: ['Not stable 1.0 or a qualified clinical system.', 'Whole-instance transcoding, XML metadata and advanced rendered services are not implemented.',
        'PostgreSQL, object storage, OIDC, automatic routing, worklists, storage commitment and DICOM TLS are planned.']
};

export async function createStoreServer(options) {
    const { dataDir, host = '127.0.0.1', port = 8048, publicUrl, maxInstanceBytes = 536870912,
        staticRoot = path.join(root, 'dist/public'), credentials = {}, accessProfile, dimsePolicy, dimseHost = isLoopbackAddress(host) ? host : '127.0.0.1' } = options;
    const archive = await Archive.open({ dataDir, maxInstanceBytes });
    let auth;
    try { auth = await new Auth(dataDir).open(); } catch (error) { await archive.close(); throw error; }
    let accessPolicy;
    try { accessPolicy = await new AccessPolicy({ dataDir, host, dimseHost }).open({ profile: accessProfile, dimse: dimsePolicy }); }
    catch (error) { await archive.close(); throw error; }
    let connections;
    try { connections = await ConnectionService.open({ archive, credentials }); } catch (error) { await archive.close(); throw error; }
    const thumbnails = new ThumbnailService();
    const studyExports = createStudyExportService();
    const activeReaders = new Set();
    let activeUploads = 0, closing = false;
    const capabilities = structuredClone(CAPABILITIES);
    capabilities.security.accessProfiles = ['authenticated', 'local-research'];
    capabilities.security.accessProfile = accessPolicy.record.profile;
    capabilities.security.dimseAccess = 'Loopback or explicit calling AE title + source IP allowlist; no DICOM TLS.';
    const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (host !== '0.0.0.0' && host !== '::') allowedHosts.add(host);
    if (publicUrl) allowedHosts.add(new URL(publicUrl).hostname);
    const cookie = (token, req, clear = false) => `easi_store_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 43200}${publicUrl?.startsWith('https://') || req.socket.encrypted ? '; Secure' : ''}`;
    const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 300_000, headersTimeout: 20_000 }, async (req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        let releaseRead;
        try {
            if (closing) throw httpError(503, 'The archive is shutting down. Retry shortly.');
            const requestUrl = new URL(req.url, 'http://localhost');
            const p = requestUrl.pathname;
            let requestHost;
            try { requestHost = new URL(`http://${req.headers.host || ''}`).hostname; } catch { throw httpError(400, 'Invalid Host header.'); }
            if (!allowedHosts.has(requestHost)) throw httpError(403, 'This host is not configured. Set an explicit EASI_STORE_PUBLIC_URL to enable it.');
            const method = req.method;
            const forwardedBase = req.headers['x-easi-store-public-base'];
            if (forwardedBase !== undefined && forwardedBase !== '/easi-store/dicomweb') throw httpError(400, 'Unsupported public DICOMweb base path.');
            const publicBasePath = forwardedBase || '/dicomweb';
            const identity = auth.identify(req);
            const dicomwebPath = p === '/dicomweb' || p.startsWith('/dicomweb/');
            const localDicomwebAccess = dicomwebPath && accessPolicy.allowsDicomweb(req);
            const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
            if (mutation) {
                const origin = req.headers.origin;
                const expected = publicUrl ? new URL(publicUrl).origin : `http://${req.headers.host}`;
                if (origin && origin !== expected) throw httpError(403, 'Cross-origin writes are not allowed.');
                if (identity !== 'bearer' && !localDicomwebAccess && req.headers['x-easi-store'] !== '1') throw httpError(403, 'Include the X-EASI-Store: 1 request header.');
            }
            if (p === '/api/health' && method === 'GET') return json(res, 200, { status: 'ok', version: VERSION });
            if (p === '/api/v1/access' && method === 'GET') return json(res, 200, accessPolicy.publicDescription(req));
            if (p === '/api/v1/session' && method === 'GET') return json(res, 200, { authenticated: Boolean(identity), setupRequired: !auth.record,
                bootstrapRequired: !auth.record && !isLoopback(req.socket.remoteAddress) });
            if ((p === '/api/v1/setup' || p === '/api/v1/login') && method === 'POST') {
                const body = await readJson(req);
                const token = await auth[p.endsWith('setup') ? 'setup' : 'login'](body, req.socket.remoteAddress);
                res.setHeader('Set-Cookie', cookie(token, req));
                return json(res, 200, { authenticated: true, setupRequired: false });
            }
            if (p.startsWith('/api/') || p === '/dicomweb' || p.startsWith('/dicomweb/')) {
                if (!identity && !localDicomwebAccess) throw httpError(401, 'Sign in or use an API bearer token to access the archive.');
            }
            // A read lease lasts through streaming/worker completion, so an
            // administrator cannot remove originals from an active reader.
            if ((method === 'GET' || method === 'HEAD') && (dicomwebPath || p.startsWith('/api/v1/download/') || /\/thumbnail$/.test(p))) {
                releaseRead = archive.acquireReadLease();
                activeReaders.add(res);
            }
            const studyExport = p.match(/^\/api\/v1\/studies\/([0-9.]+)\/export$/);
            if (studyExport && method === 'GET') {
                await studyExports.export(req, res, archive, studyExport[1]); return;
            }
            const deletionPreview = p.match(/^\/api\/v1\/studies\/([0-9.]+)\/deletion-preview$/);
            if (deletionPreview && method === 'GET') return json(res, 200, archive.previewStudyDeletion(deletionPreview[1]));
            const removeStudy = p.match(/^\/api\/v1\/studies\/([0-9.]+)$/);
            if (removeStudy && method === 'DELETE') {
                const body = await readJson(req, 4096);
                if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['confirmation', 'revision'].includes(key))) throw httpError(400, 'Confirm the current study removal preview.');
                if (activeUploads) throw httpError(409, 'Finish or cancel active imports before removing a study.');
                const result = await archive.deleteStudy(removeStudy[1], body);
                return json(res, result.reclamationPending ? 202 : 200, result);
            }
            if (p === '/api/v1/access-policy' && method === 'GET') return json(res, 200, accessPolicy.snapshot());
            if (p === '/api/v1/access-policy' && method === 'PUT') {
                const policy = await accessPolicy.update(await readJson(req, 65536));
                capabilities.security.accessProfile = policy.profile;
                return json(res, 200, policy);
            }
            if (p === '/api/v1/logout' && method === 'POST') {
                auth.logout(req); res.setHeader('Set-Cookie', cookie('', req, true)); return json(res, 200, { authenticated: false });
            }
            if (p.startsWith('/api/v1/connections') || p.startsWith('/api/v1/jobs')) {
                if (await handleConnectionRoutes(req, res, { service: connections })) return;
            }
            const thumbnail = p.match(/^\/api\/v1\/studies\/([0-9.]+)\/series\/([0-9.]+)(?:\/instances\/([0-9.]+))?\/thumbnail$/);
            if (thumbnail && method === 'GET') {
                const records = thumbnail[3] ? [archive.getInstance(thumbnail[1], thumbnail[2], thumbnail[3])].filter(Boolean) : archive.listInstances(thumbnail[1], thumbnail[2]);
                if (!records.length) throw httpError(404, 'Image not found.');
                const chosen = records[Math.floor((records.length - 1) / 2)];
                const record = archive.getInstance(chosen.studyUid, chosen.seriesUid, chosen.sopUid);
                const frame = Number(requestUrl.searchParams.get('frame') || 1);
                if (!Number.isSafeInteger(frame) || frame < 1) throw httpError(400, 'Thumbnail frame numbers are 1-based.');
                const controller = new AbortController();
                const closed = () => { if (!res.writableEnded) controller.abort(); };
                res.on('close', closed);
                try { const png = await thumbnails.render(record, { frame, signal: controller.signal }); res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); res.end(png); }
                finally { res.off('close', closed); }
                return;
            }
            if (p === '/api/v1/summary' && method === 'GET') return json(res, 200, archive.stats());
            if (p === '/api/v1/capabilities' && method === 'GET') return json(res, 200, capabilities);
            if (p === '/api/v1/studies' && method === 'GET') {
                const limit = Number(requestUrl.searchParams.get('limit') || 100), offset = Number(requestUrl.searchParams.get('offset') || 0);
                if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw httpError(400, 'Invalid pagination.');
                return json(res, 200, archive.listStudies({ search: (requestUrl.searchParams.get('search') || '').slice(0, 256), limit, offset }));
            }
            if (p === '/api/v1/activity' && method === 'GET') return json(res, 200, { items: archive.activity({ limit: 100 }) });
            const series = p.match(/^\/api\/v1\/studies\/([0-9.]+)\/series$/);
            if (series && method === 'GET') return json(res, 200, { items: archive.listSeries(series[1]) });
            const instances = p.match(/^\/api\/v1\/studies\/([0-9.]+)\/series\/([0-9.]+)\/instances$/);
            if (instances && method === 'GET') return json(res, 200, { items: archive.listInstances(instances[1], instances[2]) });
            const download = p.match(/^\/api\/v1\/download\/([0-9.]+)\/([0-9.]+)\/([0-9.]+)$/);
            if (download && method === 'GET') {
                const instance = archive.getInstance(...download.slice(1));
                if (!instance) throw httpError(404, 'Instance not found.');
                res.writeHead(200, { 'Content-Type': 'application/dicom', 'Content-Length': instance.bytes,
                    'Content-Disposition': `attachment; filename="${instance.id}.dcm"` });
                await pipeline(createReadStream(instance.path), res); return;
            }
            const upload = method === 'POST' && (p === '/api/v1/instances' || p === '/api/v1/demo' || p.startsWith('/dicomweb/studies'));
            if (upload) {
                if (activeUploads >= 4) throw httpError(503, 'The archive is busy importing. Retry shortly.');
                activeUploads++;
                try {
                    if (p === '/api/v1/instances') {
                        if (!/^application\/dicom(?:;|$)/i.test(req.headers['content-type'] || '')) throw httpError(415, 'Send the original bytes as application/dicom.');
                        const result = await archive.ingest(req, { source: 'upload' });
                        return json(res, result.status === 'stored' ? 201 : 200, result);
                    }
                    if (p === '/api/v1/demo') {
                        const study = createDemoStudy(); const outcomes = [];
                        for (const bytes of study) outcomes.push(await archive.ingest(Readable.from([bytes]), { source: 'synthetic-demo' }));
                        return json(res, 201, { imported: outcomes.length, studyUid: outcomes[0].instance.studyUid, summary: archive.stats() });
                    }
                    if (await handleDicomweb(req, res, { archive, basePath: '/dicomweb', publicBasePath })) return;
                } finally { activeUploads--; }
            } else if (p === '/dicomweb' || p.startsWith('/dicomweb/')) {
                if (await handleDicomweb(req, res, { archive, basePath: '/dicomweb', publicBasePath })) return;
            }
            if (p.startsWith('/api/') || p.startsWith('/dicomweb')) throw httpError(404, 'Endpoint not found.');
            if (method !== 'GET' && method !== 'HEAD') throw httpError(405, 'Method not allowed.');
            const normalized = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
            const filename = path.resolve(staticRoot, normalized);
            if (!filename.startsWith(path.resolve(staticRoot) + path.sep)) throw httpError(404, 'File not found.');
            let info; try { info = await stat(filename); } catch { throw httpError(404, 'File not found.'); }
            if (!info.isFile()) throw httpError(404, 'File not found.');
            res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'text/plain; charset=utf-8', 'Content-Length': info.size,
                'Cache-Control': normalized.startsWith('vendor/') ? 'public, max-age=86400' : 'no-cache' });
            if (method === 'HEAD') res.end(); else await pipeline(createReadStream(filename), res);
        } catch (error) {
            if (res.headersSent) { res.destroy(); return; }
            const status = error.statusCode || error.status || 500;
            json(res, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
                { error: { code: status === 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`, message: status >= 500 ? 'The archive could not complete this request. Check server status and retry.' : error.message } });
            if (status >= 500) console.error(`Request failed (${error.code || error.name || 'Error'}).`);
        } finally { activeReaders.delete(res); releaseRead?.(); }
    });
    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
    return { server, archive, auth, capabilities, connections, accessPolicy, studyExports,
        async listen() {
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
            return server.address();
        },
        async close() {
            closing = true;
            await studyExports.close();
            // A paused client must not hold an original read lease forever.
            // Imports receive a short grace period, then their normal durable
            // ingest/recovery path handles an interrupted request.
            for (const response of activeReaders) response.destroy();
            if (server.listening) await new Promise(resolve => {
                const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
                deadline.unref();
                server.close(() => { clearTimeout(deadline); resolve(); }); server.closeIdleConnections();
            });
            await thumbnails.close();
            await connections.close();
            await archive.close();
        }
    };
}
