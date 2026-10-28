#!/usr/bin/env node
// Explicit synthetic deployment qualification. Requires Docker and Chrome,
// never an existing archive, external tenant, global CA installation or secret.
import assert from 'node:assert/strict';
import { execFile as execute } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, realpath, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive } from '../src/archive/Archive.js';
import { Auth } from '../src/http/Auth.js';
import { createDicom } from '../src/synthetic.js';
import { browserSession, delay } from './qualification/browser-session.mjs';

const execFile = promisify(execute), root = fileURLToPath(new URL('../', import.meta.url));
const q = JSON.stringify, digest = value => createHash('sha256').update(value).digest('hex');
const argumentsList = process.argv.slice(2);
if (argumentsList.length && (argumentsList.length !== 2 || argumentsList[0] !== '--output')) throw new Error('Usage: node scripts/qualify-hosted-oidc.mjs [--output /private/report-directory]');
const output = path.resolve(argumentsList[1] || path.join(root, 'artifacts/qualification/hosted-oidc'));
await mkdir(output, { recursive: true, mode: 0o700 });
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'easi-store-hosted-oidc-')));
const prefix = 'easi-hosted-' + randomBytes(5).toString('hex'), network = prefix + '-network';
const names = { proxy: prefix + '-proxy', identity: prefix + '-identity', store: prefix + '-store' };
const images = { identity: 'quay.io/keycloak/keycloak:26.8.1', proxy: 'caddy:2.11.7-alpine', store: 'node:24.22.1-bookworm-slim' };
const checks = [], containers = [], browsers = [], imageProof = {}, sourceInputs = {};
const sensitive = new Set();
let currentStep = 'prepare', networkCreated = false, ca;
const environment = { ...process.env };
const docker = async (...args) => (await execFile('docker', args, { env: environment, maxBuffer: 2 * 1024 * 1024, timeout: 120000 })).stdout.trim();
const record = (name, details = {}) => { checks.push({ name, ...details }); console.log('PASS ' + name); };
const redact = value => {
    let text = String(value);
    for (const secret of sensitive) text = text.replaceAll(secret, '[redacted]');
    return text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
        .replace(/([?&](?:code|state|session_state|nonce)=)[^&\s]+/g, '$1[redacted]');
};
const resource = (filename, target) => ['--mount', `type=bind,source=${filename},target=${target},readonly`];
async function privateJson(filename, value) { await writeFile(filename, JSON.stringify(value), { mode: 0o600 }); }
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function until(action, description, attempts = 150) {
    for (let index = 0; index < attempts; index++) { try { if (await action()) return; } catch { /* bounded startup polling */ } await delay(400); }
    throw new Error(description);
}
async function inventory(directory, base = '') {
    for (const entry of await readdir(path.join(directory, base), { withFileTypes: true })) {
        const name = path.posix.join(base, entry.name);
        if (entry.isDirectory()) await inventory(directory, name);
        else if (entry.isFile()) sourceInputs[name] = digest(await readFile(path.join(directory, name)));
        else throw new Error('The qualification runtime must contain ordinary source files.');
    }
}
function tlsRequest(host, port, pathname, options = {}) {
    return new Promise((resolve, reject) => {
        const req = httpsRequest({ hostname: '127.0.0.1', port, servername: host, path: pathname, method: options.method || 'GET',
            ca: options.ca === undefined ? ca : options.ca, timeout: 10000,
            headers: { Host: `${host}:${port}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers } }, response => {
            const chunks = []; let bytes = 0;
            response.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) response.destroy(new Error('Qualification response exceeded its bound.')); else chunks.push(chunk); });
            response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        req.on('timeout', () => req.destroy(new Error('Qualification request timed out.'))); req.on('error', reject);
        if (options.body !== undefined) req.write(JSON.stringify(options.body)); req.end();
    });
}

try {
    currentStep = 'snapshot runtime';
    const runtime = path.join(temporary, 'runtime'); await mkdir(runtime);
    for (const name of ['src', 'dist', 'package.json', 'package-lock.json', 'examples']) await cp(path.join(root, name), path.join(runtime, name), { recursive: true });
    await inventory(runtime);
    const modules = await realpath(path.join(root, 'node_modules'));
    for (const [kind, image] of Object.entries(images)) {
        const information = JSON.parse(await docker('image', 'inspect', image))[0];
        imageProof[kind] = { image, id: information.Id, repoDigests: information.RepoDigests, architecture: information.Architecture };
    }
    const port = await freePort(), storeHost = 'easi-store-qa.test', identityHost = 'easi-identity-qa.test';
    const storeUrl = `https://${storeHost}:${port}`, identityUrl = `https://${identityHost}:${port}`;
    const realm = 'easi-store-qa', clientId = 'easi-store-qa', secret = randomBytes(32).toString('base64url');
    sensitive.add(secret);
    const roles = ['reader', 'contributor', 'administrator', 'unmapped'];
    const passwords = Object.fromEntries(roles.map(role => [role, randomBytes(24).toString('base64url')]));
    Object.values(passwords).forEach(value => sensitive.add(value));
    const group = { reader: 'readers', contributor: 'curators', administrator: 'operators' };
    const data = path.join(temporary, 'archive');
    const archive = await Archive.open({ dataDir: data });
    let seed;
    const original = createDicom({ rows: 16, columns: 16 });
    try {
        const auth = await new Auth(data).open();
        const recoveryPassword = randomBytes(24).toString('base64url'); sensitive.add(recoveryPassword);
        try { await auth.setup({ username: 'generated-recovery', password: recoveryPassword }, '127.0.0.1'); }
        finally { await auth.close(); }
        seed = (await archive.ingest(Readable.from([original]), { source: 'generated-hosted-qualification' })).instance;
    } finally { await archive.close(); }
    const realmFile = path.join(temporary, 'realm.json');
    await writeFile(realmFile, JSON.stringify({ realm, enabled: true, registrationAllowed: false, resetPasswordAllowed: false,
        defaultSignatureAlgorithm: 'RS256', groups: [{ name: 'easi-store', subGroups: Object.values(group).map(name => ({ name })) }],
        users: roles.map(role => ({ username: role, enabled: true, email: `${role}@easi-qualification.invalid`, emailVerified: true, firstName: 'Generated', lastName: role,
            credentials: [{ type: 'password', value: passwords[role], temporary: false }], groups: group[role] ? [`/easi-store/${group[role]}`] : [] })),
        clients: [{ clientId, enabled: true, protocol: 'openid-connect', publicClient: false, secret,
            clientAuthenticatorType: 'client-secret', standardFlowEnabled: true, implicitFlowEnabled: false, fullScopeAllowed: false,
            directAccessGrantsEnabled: false, serviceAccountsEnabled: false, redirectUris: [storeUrl + '/api/v1/auth/oidc/callback'],
            defaultClientScopes: ['profile'], attributes: { 'pkce.code.challenge.method': 'S256', 'id.token.signed.response.alg': 'RS256', 'client.secret.authentication.allowed.method': 'client_secret_basic' },
            protocolMappers: [{ name: 'easi-store-groups', protocol: 'openid-connect', protocolMapper: 'oidc-group-membership-mapper',
                config: { 'claim.name': 'groups', 'full.path': 'true', 'id.token.claim': 'true', 'access.token.claim': 'false', 'userinfo.token.claim': 'false' } }] }] }), { mode: 0o644 });
    const authFile = path.join(temporary, 'auth.json');
    await privateJson(authFile, { mode: 'hybrid', oidc: { issuer: identityUrl + '/realms/' + realm, clientId, clientSecret: secret,
        callbackUrl: storeUrl + '/api/v1/auth/oidc/callback', label: 'Synthetic Keycloak qualification', groupsClaim: 'groups', subjectRoles: {},
        groupRoles: Object.fromEntries(Object.entries(group).map(([role, name]) => [`/easi-store/${name}`, role])) } });
    const caddyData = path.join(temporary, 'caddy-data'), caddyConfig = path.join(temporary, 'caddy-config');
    await mkdir(caddyData); await mkdir(caddyConfig);
    const caddyFile = path.join(temporary, 'Caddyfile');
    await writeFile(caddyFile, `{
    admin off
    auto_https disable_redirects
    skip_install_trust
}
${storeUrl} {
    tls internal
    reverse_proxy store:8048 {
        header_up -Forwarded
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Host {host}
        header_up X-Forwarded-Proto https
    }
}
${identityUrl} {
    tls internal
    reverse_proxy keycloak:8080 {
        header_up -Forwarded
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Host {host}
        header_up X-Forwarded-Proto https
    }
}
`, { mode: 0o644 });
    currentStep = 'start isolated containers';
    await docker('network', 'create', '--driver', 'bridge', network); networkCreated = true;
    const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    await docker('run', '--detach', '--pull=never', '--name', names.proxy, '--network', network,
        '--network-alias', storeHost, '--network-alias', identityHost, '--user', user, '--read-only', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE',
        '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:size=64m', '-p', `127.0.0.1:${port}:${port}`,
        ...resource(caddyFile, '/etc/caddy/Caddyfile'), '--mount', `type=bind,source=${caddyData},target=/data`,
        '--mount', `type=bind,source=${caddyConfig},target=/config`, images.proxy); containers.push(names.proxy);
    const caFile = path.join(temporary, 'ca.pem');
    await until(async () => { ca = await readFile(path.join(caddyData, 'caddy/pki/authorities/local/root.crt')); return true; }, 'Caddy did not generate its isolated local CA.');
    await writeFile(caFile, ca, { mode: 0o644 });
    // Verify the published TLS path before waiting for either backend.
    await until(async () => { await tlsRequest(storeHost, port, '/api/health'); return true; }, 'The loopback HTTPS proxy did not become reachable.');
    await docker('run', '--detach', '--pull=never', '--name', names.identity, '--network', network, '--network-alias', 'keycloak',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', ...resource(realmFile, '/opt/keycloak/data/import/realm.json'),
        images.identity, 'start-dev', '--import-realm', '--hostname', identityUrl, '--proxy-headers', 'xforwarded'); containers.push(names.identity);
    await docker('run', '--detach', '--pull=never', '--name', names.store, '--network', network, '--network-alias', 'store',
        '--user', user, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:size=64m',
        '--workdir', '/app', ...resource(runtime, '/app'), ...resource(modules, '/node_modules'), ...resource(authFile, '/run/auth.json'),
        ...resource(caFile, '/run/local-ca.pem'), '--mount', `type=bind,source=${data},target=/data`,
        '--env', 'NODE_EXTRA_CA_CERTS=/run/local-ca.pem', images.store,
        'node', 'src/cli.js', 'start', '--host', '0.0.0.0', '--port', '8048', '--data-dir', '/data', '--no-dimse', '--hosted',
        '--public-url', storeUrl, '--auth-config', '/run/auth.json', '--access-profile', 'authenticated'); containers.push(names.store);
    currentStep = 'verify HTTPS discovery and protected endpoints';
    await until(async () => (await tlsRequest(identityHost, port, `/realms/${realm}/.well-known/openid-configuration`)).status === 200, 'Keycloak HTTPS discovery did not become ready.');
    await until(async () => (await tlsRequest(storeHost, port, '/api/health')).status === 200, 'Store HTTPS service did not become ready.');
    const discovery = JSON.parse((await tlsRequest(identityHost, port, `/realms/${realm}/.well-known/openid-configuration`)).body);
    assert.equal(discovery.issuer, identityUrl + '/realms/' + realm);
    assert.ok(discovery.token_endpoint_auth_methods_supported.includes('client_secret_basic'));
    assert.ok(discovery.id_token_signing_alg_values_supported.includes('RS256'));
    assert.ok(discovery.code_challenge_methods_supported.includes('S256'));
    await assert.rejects(tlsRequest(storeHost, port, '/api/health', { ca: [] }));
    record('real Keycloak discovery and Store HTTPS validate against an explicit ephemeral CA; untrusted TLS fails');
    for (const endpoint of ['/dicomweb/studies', '/api/v1/summary']) assert.equal((await tlsRequest(storeHost, port, endpoint)).status, 401);
    assert.equal((await tlsRequest(storeHost, port, '/dicomweb/studies', { headers: { 'X-Forwarded-For': '127.0.0.1' } })).status, 401);
    record('anonymous and spoofed-forwarding requests remain unauthorized through the HTTPS proxy');
    // Caddy sends its intermediate CA in the TLS chain; Chrome's isolated
    // SPKI exception must match that presented certificate, not an omitted root.
    const intermediate = await readFile(path.join(caddyData, 'caddy/pki/authorities/local/intermediate.crt'));
    const key = new X509Certificate(intermediate).publicKey.export({ type: 'spki', format: 'der' });
    const pinnedCa = createHash('sha256').update(key).digest('base64');
    const originalPath = `/api/v1/download/${seed.studyUid}/${seed.seriesUid}/${seed.sopUid}`;
    for (const role of roles) {
        currentStep = 'browser sign-in ' + role;
        const browser = await browserSession(path.join(temporary, 'browser-' + role), [
            `--host-resolver-rules=MAP ${storeHost} 127.0.0.1, MAP ${identityHost} 127.0.0.1`,
            '--no-proxy-server', `--ignore-certificate-errors-spki-list=${pinnedCa}`
        ]); browsers.push(browser);
        await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
        const evaluate = expression => browser.evaluate(expression);
        const click = async selector => {
            const point = await evaluate(`(()=>{const element=document.querySelector(${q(selector)});if(!element||element.disabled)return null;element.scrollIntoView({block:'center'});const box=element.getBoundingClientRect();return box.width&&box.height?{x:box.left+box.width/2,y:box.top+box.height/2}:null;})()`);
            assert.ok(point, 'Expected qualification control unavailable.');
            await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
            await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
        };
        const text = (selector, value) => evaluate(`(()=>{const element=document.querySelector(${q(selector)});if(!element)throw new Error('Expected qualification field unavailable');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${q(value)});element.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
        const api = (endpoint, options = {}) => evaluate(`(async()=>{const response=await fetch(${q(endpoint)},${q({ credentials: 'same-origin', ...options })});return {status:response.status,body:await response.json().catch(()=>null)};})()`);
        await browser.send('Page.navigate', { url: storeUrl });
        await browser.until('Boolean(document.querySelector(".auth-organization"))', 'Store organizational sign-in control unavailable.');
        await click('.auth-organization');
        await browser.until('Boolean(document.querySelector("input[name=username]"))&&Boolean(document.querySelector("input[name=password]"))', 'Real Keycloak login form unavailable.');
        const transaction = (await browser.send('Network.getCookies', { urls: [storeUrl + '/api/v1/auth/oidc'] })).cookies.find(item => item.name === 'easi_store_oidc');
        if (transaction) sensitive.add(transaction.value);
        assert.ok(transaction?.secure && transaction.httpOnly && transaction.sameSite === 'Lax');
        await text('input[name=username]', role); await text('input[name=password]', passwords[role]); await click('button[type=submit], input[type=submit]');
        if (role === 'unmapped') {
            await browser.until('location.hostname===' + q(storeHost) + '&&Boolean(document.querySelector(".auth-callback-error"))', 'Unmapped Keycloak account was not safely denied.');
            assert.equal((await api('/api/v1/session')).body.authenticated, false);
            record('real Keycloak unmapped account receives no Store session or default role');
        } else {
            await browser.until('Boolean(document.querySelector(".primary-nav"))', 'Mapped Keycloak account did not reach Store.');
            const session = await api('/api/v1/session');
            assert.equal(session.body.identity.role, role); assert.equal(session.body.identity.source, 'oidc');
            assert.equal((await api('/dicomweb/studies')).status, 200);
            const cookies = (await browser.send('Network.getCookies', { urls: [storeUrl] })).cookies;
            const cookie = cookies.find(item => item.name === 'easi_store_session');
            if (cookie) sensitive.add(cookie.value);
            assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Strict');
            const bytes = await evaluate(`(async()=>{const response=await fetch(${q(originalPath)},{headers:{Accept:'application/dicom'}});const bytes=await response.arrayBuffer();return {status:response.status,hash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('')};})()`);
            assert.equal(bytes.status, 200); assert.equal(bytes.hash, digest(original));
            const management = await api('/api/v1/access-policy'); assert.equal(management.status, role === 'administrator' ? 200 : 403);
            const upload = createDicom({ rows: 8, columns: 8 });
            const imported = await evaluate(`(async()=>{const body=Uint8Array.from(atob(${q(upload.toString('base64'))}),x=>x.charCodeAt(0));const response=await fetch('/api/v1/instances',{method:'POST',headers:{'Content-Type':'application/dicom','X-EASI-Store':'1'},body});return response.status;})()`);
            assert.equal(imported, role === 'reader' ? 403 : 201);
            record(`real Keycloak ${role} browser sign-in enforces group role and original/import/administration permissions with Secure cookies`);
            if (role === 'administrator') {
                const headers = { Cookie: `${cookie.name}=${cookie.value}`, 'X-EASI-Store': '1' };
                const body = { version: 1, profile: 'local-research', dimse: { allowLoopback: true, peers: [] } };
                assert.equal((await tlsRequest(storeHost, port, '/api/v1/access-policy', { method: 'PUT', headers, body })).status, 400);
                assert.equal((await tlsRequest(storeHost, port, '/api/v1/access-policy', { method: 'PUT', headers: { ...headers, Origin: 'https://unrelated.invalid' }, body })).status, 403);
                assert.equal((await api('/api/v1/access-policy')).body.profile, 'authenticated');
                assert.equal((await tlsRequest(storeHost, port, '/dicomweb/studies')).status, 401);
                const badHost = await docker('exec', names.store, 'node', '--input-type=module', '-e', `import http from 'node:http';const status=await new Promise((resolve,reject)=>{const request=http.get('http://127.0.0.1:8048/dicomweb/studies',{headers:{Host:'unrelated.invalid'}},response=>{response.resume();resolve(response.statusCode)});request.on('error',reject)});console.log(status)`);
                assert.equal(badHost, '403');
                record('hosted research downgrade, foreign-origin mutation and unconfigured Host are rejected without changing access policy');
            }
            await click('.sidebar-account');
            await browser.until('Boolean(document.querySelector(".auth-organization"))', 'Store logout did not return to sign-in.');
            assert.equal((await api('/api/v1/session')).body.authenticated, false);
            assert.equal((await api('/dicomweb/studies')).status, 401);
            record(`HTTPS logout ends the ${role} Store session and protects archive requests`);
        }
        assert.equal(browser.errors.length, 0); assert.equal(browser.consoleErrors.length, 0);
        browser.close(); browsers.pop();
    }
    const report = { passed: checks.length, checks, syntheticOnly: true, originalMedicalDataUsed: false,
        realProvider: { product: 'Keycloak', version: '26.8.1', protocol: 'code + S256 + RS256 + client_secret_basic', groupClaim: 'groups; full paths in ID token', scopes: 'openid profile' },
        proxy: { product: 'Caddy', version: '2.11.7', loopbackPublishedOnly: true, privateDockerNetwork: true },
        tls: { nodeCertificateVerification: true, ephemeralCaExplicitlyTrusted: true, chromeIsolatedCaSpkiPin: true, globalTrustChanged: false },
        images: imageProof, sourceInputs, secretsRecorded: false, sessionsOrTokensRecorded: false,
        limits: ['Single-host synthetic Keycloak deployment; no live Entra/Okta tenant qualification.', 'Keycloak start-dev is used only for isolated provider qualification, not a production Keycloak operating recipe.', 'Native DIMSE and external-network transport are separate profiles.'] };
    await privateJson(path.join(output, 'results.json'), report);
    await rm(path.join(output, 'failure.json'), { force: true });
    console.log(JSON.stringify({ passed: checks.length, report: path.join(output, 'results.json'), syntheticOnly: true }));
} catch (error) {
    const browserDiagnostics = [];
    for (const browser of browsers) {
        try { browserDiagnostics.push(JSON.parse(redact(JSON.stringify(await browser.evaluate('({title:document.title,origin:location.origin,path:location.pathname,text:document.body?.innerText.slice(0,1500)})'))))); }
        catch { browserDiagnostics.push({ unavailable: true }); }
    }
    const containerDiagnostics = {};
    for (const name of containers) {
        try { const value = await execFile('docker', ['logs', '--tail', '40', name], { env: environment, maxBuffer: 256 * 1024, timeout: 10000 }); containerDiagnostics[name] = redact(value.stdout + value.stderr); }
        catch { containerDiagnostics[name] = 'Container diagnostic unavailable.'; }
    }
    await privateJson(path.join(output, 'failure.json'), { step: currentStep, passed: checks.length, syntheticOnly: true,
        error: { name: error.name, message: redact(error.message) }, browserDiagnostics, containerDiagnostics });
    throw new Error(`Hosted OIDC qualification failed during ${currentStep}. See the protected, redacted failure report.`);
} finally {
    for (const browser of browsers) browser.close();
    // A failed docker run may leave a Created container before returning its ID.
    for (const name of Object.values(names).reverse()) await docker('rm', '--force', name).catch(() => {});
    if (networkCreated) await docker('network', 'rm', network).catch(() => {});
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
