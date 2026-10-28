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
import { MoveCoordinator } from './dimse/MoveCoordinator.js';
import { DatasetService } from './datasets/DatasetService.js';
import { DatasetRoutes } from './datasets/router.js';
import { authorize, permissionsFor, publicIdentity, hasSuppliedCredential } from './auth/permissions.js';
import { withRequestContext, setRequestActor } from './auth/RequestContext.js';
import { SecurityAudit, auditAction } from './auth/SecurityAudit.js';

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
    security: { localAdmin: true, apiBearerTokens: true, externalIdentity: 'Optional configured OpenID Connect provider',
        roles: ['reader', 'contributor', 'administrator'], scopedTokens: true },
    viewer: { name: 'EASI View', version: '1.0.0-rc.1', releaseCandidate: true, loading: 'Metadata-first DICOMweb; requested originals loaded on demand' },
    management: { originalStudyExport: 'Streaming ZIP/ZIP64 with SHA-256 manifest',
        studyRemoval: { previewRequired: true, confirmation: 'DELETE', scope: 'Store archival copies only' } },
    datasets: { savedSelections: true, immutableVersions: true, sha256Membership: true,
        optionalSubjectGroupedSplits: true, indexedTechnicalChecks: true, verifiedPythonDownloads: true,
        anonymization: false, annotationInterpretation: false, modelTraining: false },
    dimse: { enabled: false, roles: ['C-ECHO SCP/SCU', 'C-STORE SCP/SCU', 'C-FIND SCP/SCU', 'C-GET SCP/SCU', 'C-MOVE SCP/SCU'],
        queryRetrieve: ['Study Root', 'Patient Root'], moveDestinations: 'Explicitly configured peers only',
        retrievalMethods: ['c-get', 'c-move'], moveRetrieval: 'Enumerated IMAGE requests into the existing Store receiver; same-peer callbacks only', tls: false },
    connections: { configuredPeers: ['dicomweb', 'dimse'], transferJobs: true, restartRecovery: true, retry: true, cancel: true },
    thumbnails: { managementApi: true, profile: 'Native 8/16-bit monochrome, native 8-bit RGB/YBR, 8-bit baseline JPEG grayscale/YBR' },
    limitations: ['Not stable 1.0 or a qualified clinical system.', 'Whole-instance transcoding, XML metadata and advanced rendered services are not implemented.',
        'PostgreSQL, object storage, automatic routing, worklists, storage commitment and DICOM TLS are planned.']
};

export async function createStoreServer(options) {
    const { dataDir, authConfiguration, host = '127.0.0.1', port = 8048, publicUrl: configuredPublicUrl, maxInstanceBytes = 536870912,
        staticRoot = path.join(root, 'dist/public'), credentials = {}, accessProfile, dimsePolicy, autoStartJobs = true, dimseHost = isLoopbackAddress(host) ? host : '127.0.0.1' } = options;
    const publicUrl = configuredPublicUrl || (authConfiguration?.oidc?.callbackUrl ? new URL(authConfiguration.oidc.callbackUrl).origin : undefined);
    const archive = await Archive.open({ dataDir, maxInstanceBytes });
    let auth, securityAudit;
    try {
        securityAudit = new SecurityAudit(archive);
        auth = await new Auth(dataDir, { configuration: authConfiguration, publicUrl }).open();
        if (auth.description().mode === 'oidc' && !auth.record) throw httpError(400, 'Create the local recovery administrator before enabling SSO-only mode.');
    } catch (error) { await auth?.close(); await archive.close(); throw error; }
    let accessPolicy;
    try { accessPolicy = await new AccessPolicy({ dataDir, host, dimseHost }).open({ profile: accessProfile, dimse: dimsePolicy }); }
    catch (error) { await archive.close(); throw error; }
    let connections, moveCoordinator, datasets;
    try {
        moveCoordinator = new MoveCoordinator({ archive });
        datasets = new DatasetService({ archive });
        connections = await ConnectionService.open({ archive, credentials, moveCoordinator, autoStartJobs });
    } catch (error) { await moveCoordinator?.close(); await archive.close(); throw error; }
    const thumbnails = new ThumbnailService();
    const studyExports = createStudyExportService();
    const datasetRoutes = new DatasetRoutes({ service: datasets });
    const activeReaders = new Set();
    let activeUploads = 0, closing = false;
    const capabilities = structuredClone(CAPABILITIES);
    capabilities.security.accessProfiles = ['authenticated', 'local-research'];
    capabilities.security.accessProfile = accessPolicy.record.profile;
    capabilities.security.dimseAccess = 'Loopback or explicit calling AE title + source IP allowlist; no DICOM TLS.';
    const authentication = () => { const value = auth.description(); return { mode: value.mode, localLogin: value.localLoginAvailable, ssoLogin: value.oidcAvailable, providerName: value.oidcLabel || 'your organization' }; };
    const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (host !== '0.0.0.0' && host !== '::') allowedHosts.add(host);
    if (publicUrl) allowedHosts.add(new URL(publicUrl).hostname);
    const cookie = (token, req, clear = false) => `easi_store_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 43200}${publicUrl?.startsWith('https://') || req.socket.encrypted ? '; Secure' : ''}`;
    const transactionCookie = (value, clear = false) => `easi_store_oidc=${value}; Path=/api/v1/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 600}${publicUrl?.startsWith('https://') ? '; Secure' : ''}`;
    const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 300_000, headersTimeout: 20_000 }, (req, res) => withRequestContext(async () => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        let releaseRead, identity = null, auditId, auditOutcome;
        let auditFinished = false;
        const finishAudit = () => {
            if (auditFinished || auditId === undefined) return; auditFinished = true;
            try { securityAudit.finish(auditId, identity, auditOutcome || (res.writableFinished ? res.statusCode < 400 ? 'succeeded' : 'denied' : 'interrupted')); }
            catch { console.error('A security activity completion could not be recorded. Inspect archive storage health.'); }
        };
        res.once('finish', finishAudit); res.once('close', finishAudit);
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
            identity = auth.identify(req); setRequestActor(identity);
            const dicomwebPath = p === '/dicomweb' || p.startsWith('/dicomweb/');
            const localDicomwebAccess = dicomwebPath && !identity && !hasSuppliedCredential(req) && accessPolicy.allowsDicomweb(req);
            const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
            if (mutation) {
                const origin = req.headers.origin;
                const expected = publicUrl ? new URL(publicUrl).origin : `http://${req.headers.host}`;
                if (origin && origin !== expected) throw httpError(403, 'Cross-origin writes are not allowed.');
                if (identity?.type !== 'bearer' && !localDicomwebAccess && req.headers['x-easi-store'] !== '1') throw httpError(403, 'Include the X-EASI-Store: 1 request header.');
            }
            const action = auditAction(method, p);
            if (action) auditId = securityAudit.begin(identity, action);
            if (p === '/api/health' && method === 'GET') return json(res, 200, { status: 'ok', version: VERSION });
            if (p === '/api/v1/access' && method === 'GET') return json(res, 200, accessPolicy.publicDescription(req));
            if (p === '/api/v1/session' && method === 'GET') return json(res, 200, { authenticated: Boolean(identity), setupRequired: !auth.record,
                bootstrapRequired: !auth.record && !isLoopback(req.socket.remoteAddress), identity: publicIdentity(identity),
                permissions: permissionsFor(identity), authentication: authentication() });
            if (p === '/api/v1/auth/oidc/start' && method === 'POST') {
                if (!auth.record) throw httpError(409, 'Complete local administrator setup first.');
                const body = await readJson(req, 1024); if (Object.keys(body).length) throw httpError(400, 'The SSO request takes no parameters.');
                auth.rateLimit(req.socket.remoteAddress);
                const started = await auth.startOidc(); res.setHeader('Set-Cookie', transactionCookie(started.transactionCookie));
                return json(res, 200, { authorizationUrl: started.authorizationUrl });
            }
            if (p === '/api/v1/auth/oidc/callback' && method === 'GET') {
                const browserToken = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('easi_store_oidc='))?.slice('easi_store_oidc='.length);
                try {
                    const result = await auth.completeOidc({ url: new URL(req.url, publicUrl || 'http://localhost'), transactionCookie: browserToken });
                    identity = result.principal; setRequestActor(identity);
                    res.setHeader('Set-Cookie', [cookie(result.token, req), transactionCookie('', true)]);
                    res.writeHead(303, { Location: '/' }); res.end();
                } catch {
                    auditOutcome = 'denied'; res.setHeader('Set-Cookie', transactionCookie('', true));
                    res.writeHead(303, { Location: '/?signin=failed' }); res.end();
                }
                return;
            }
            if ((p === '/api/v1/setup' || p === '/api/v1/login') && method === 'POST') {
                const body = await readJson(req);
                const token = await auth[p.endsWith('setup') ? 'setup' : 'login'](body, req.socket.remoteAddress);
                identity = auth.identify({ headers: { cookie: `easi_store_session=${token}` } }); setRequestActor(identity);
                res.setHeader('Set-Cookie', cookie(token, req));
                return json(res, 200, { authenticated: true, setupRequired: false });
            }
            if (p.startsWith('/api/') || p === '/dicomweb' || p.startsWith('/dicomweb/')) {
                if (!identity && !localDicomwebAccess) throw httpError(401, 'Sign in or use an API bearer token to access the archive.');
                if (identity) authorize(identity, method, p);
            }
            if (p === '/api/v1/identity' && method === 'GET') {
                const config = auth.configuration || {}; const provider = config.oidc || {};
                return json(res, 200, { authentication: { ...authentication(), ...(provider.issuer ? { issuer: provider.issuer, clientId: provider.clientId,
                    callbackUrl: provider.callbackUrl, groupsClaim: provider.groupsClaim } : {}) }, identity: publicIdentity(identity), permissions: permissionsFor(identity) });
            }
            if (p === '/api/v1/auth/tokens' && method === 'GET') return json(res, 200, auth.listTokens(identity));
            if (p === '/api/v1/auth/tokens' && method === 'POST') {
                const result = await auth.createApiToken(await readJson(req, 4096), identity);
                return json(res, 201, { token: result.token, credential: result.record });
            }
            const tokenRoute = p.match(/^\/api\/v1\/auth\/tokens\/([a-f0-9-]+)$/);
            if (tokenRoute && method === 'DELETE') return json(res, 200, await auth.revokeApiToken(tokenRoute[1], identity));
            if (p === '/api/v1/auth/password' && method === 'POST') {
                auth.rateLimit(req.socket.remoteAddress);
                const result = await auth.changePassword(await readJson(req, 16384), identity);
                res.setHeader('Set-Cookie', cookie('', req, true)); return json(res, 200, result);
            }
            if (p === '/api/v1/auth/activity' && method === 'GET') return json(res, 200, securityAudit.list());
            // A read lease lasts through streaming/worker completion, so an
            // administrator cannot remove originals from an active reader.
            if ((method === 'GET' || method === 'HEAD') && (dicomwebPath || p.startsWith('/api/v1/download/') || /\/thumbnail$/.test(p)
                || p.startsWith('/api/v1/datasets/') && /\/original$/.test(p))) {
                releaseRead = archive.acquireReadLease();
                activeReaders.add(res);
            }
            if (await datasetRoutes.handle(req, res, p)) return;
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
    }));
    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
    return { server, archive, auth, capabilities, connections, accessPolicy, studyExports, moveCoordinator, datasets, securityAudit,
        async listen() {
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
            return server.address();
        },
        async close() {
            closing = true;
            datasetRoutes.close(); await auth.close();
            // Record queue shutdown intent before the receiver aborts a move,
            // so unfinished jobs remain resumable instead of becoming failed.
            await connections.close();
            await moveCoordinator.close();
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
            await archive.close();
        }
    };
}
