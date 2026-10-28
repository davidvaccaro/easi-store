// Client access is independent of the administrator session. Local research
// access never applies to the management API or to a forwarded client address.
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const badRequest = message => Object.assign(new Error(message), { statusCode: 400 });
const defaults = () => ({ version: 1, profile: 'authenticated', dimse: { allowLoopback: true, peers: [] } });
const ownKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeAddress(value) {
    if (typeof value !== 'string' || value.includes('%') || !isIP(value)) return null;
    if (isIP(value) === 4) return value;
    const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const mapped = normalized.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
    if (!mapped) return normalized;
    const upper = Number.parseInt(mapped[1], 16), lower = Number.parseInt(mapped[2], 16);
    return `${upper >>> 8}.${upper & 255}.${lower >>> 8}.${lower & 255}`;
}
export function isLoopbackAddress(value) {
    const address = normalizeAddress(value);
    return address === '::1' || address?.startsWith('127.') === true;
}
function localAuthority(value) {
    if (typeof value !== 'string' || !value || /[\s/@\\?#]/.test(value)) return false;
    let url;
    try { url = new URL(`http://${value}`); } catch { return false; }
    const match = value.match(/^(?:\[([^\]]+)\]|([^:]+))(?::[0-9]+)?$/);
    if (!match) return false;
    const name = match[1] || match[2];
    return name.toLowerCase() === 'localhost' || isLoopbackAddress(name);
}
function hostedDeployment({ publicUrl, hosted = false }) {
    if (typeof hosted !== 'boolean') throw badRequest('The hosted deployment setting must be boolean.');
    if (hosted) return true;
    if (publicUrl === undefined) return false;
    let url;
    try { url = new URL(publicUrl); } catch { throw badRequest('Configure a valid public Store URL.'); }
    return !localAuthority(url.host);
}
const proxyHeader = name => name === 'forwarded' || name === 'x-forwarded' || name.startsWith('x-forwarded-')
    || ['via', 'x-real-ip', 'client-ip', 'x-client-ip', 'true-client-ip', 'cf-connecting-ip',
        'fastly-client-ip', 'x-envoy-external-address', 'x-original-host', 'x-original-url'].includes(name);

export function validateAccessPolicy(value, { host = '127.0.0.1', dimseHost = host, publicUrl, hosted = false } = {}) {
    if (!object(value) || !ownKeys(value, ['version', 'profile', 'dimse']) || value.version !== 1
        || !['authenticated', 'local-research'].includes(value.profile)) throw badRequest('Use a version 1 access policy with an authenticated or local-research profile.');
    if (value.profile === 'local-research' && (!isLoopbackAddress(host) || !isLoopbackAddress(dimseHost))) {
        throw badRequest('Local research access requires literal loopback HTTP and DIMSE listeners. Bind both to 127.0.0.1 or ::1.');
    }
    if (value.profile === 'local-research' && hostedDeployment({ publicUrl, hosted })) {
        throw badRequest('Hosted or public Store deployments require authenticated client access. Use the authenticated access profile.');
    }
    const dimse = value.dimse;
    if (!object(dimse) || !ownKeys(dimse, ['allowLoopback', 'peers']) || typeof dimse.allowLoopback !== 'boolean'
        || !Array.isArray(dimse.peers) || dimse.peers.length > 256) throw badRequest('Configure DIMSE allowLoopback and at most 256 explicit calling-AE/IP peers.');
    const peers = [], unique = new Set();
    for (const peer of dimse.peers) {
        const address = object(peer) ? normalizeAddress(peer.address) : null;
        if (!object(peer) || !ownKeys(peer, ['callingAeTitle', 'address']) || typeof peer.callingAeTitle !== 'string'
            || !/^[\x20-\x7e]{1,16}$/.test(peer.callingAeTitle) || peer.callingAeTitle.trim() !== peer.callingAeTitle
            || peer.callingAeTitle.includes('\\') || !address || ['0.0.0.0', '::'].includes(address)) throw badRequest('Each DIMSE peer needs an exact calling AE title and a literal IPv4 or IPv6 address.');
        const key = JSON.stringify([peer.callingAeTitle, address]);
        if (unique.has(key)) throw badRequest('Duplicate DIMSE calling-AE/IP peer.');
        unique.add(key); peers.push({ callingAeTitle: peer.callingAeTitle, address });
    }
    if (!isLoopbackAddress(dimseHost) && !peers.length) throw badRequest('A non-loopback DIMSE listener requires at least one explicit calling-AE/IP peer.');
    return { version: 1, profile: value.profile, dimse: { allowLoopback: dimse.allowLoopback, peers } };
}

export class AccessPolicy {
    constructor({ dataDir, host = '127.0.0.1', dimseHost = host, publicUrl, hosted = false }) {
        this.path = path.join(dataDir, 'access-policy.json'); this.dataDir = dataDir;
        this.listeners = { host, dimseHost, publicUrl, hosted }; this.record = defaults(); this.updating = false;
    }
    async open({ profile, dimse } = {}) {
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        let record = defaults();
        try { record = JSON.parse(await readFile(this.path, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        // An explicit CLI override can repair an incompatible persisted policy
        // before validation, without ever temporarily opening a network listener.
        if (profile !== undefined) record.profile = profile;
        if (dimse !== undefined) record.dimse = dimse;
        this.record = validateAccessPolicy(record, this.listeners);
        if (profile !== undefined || dimse !== undefined) await this.update(this.record);
        return this;
    }
    snapshot() { return structuredClone(this.record); }
    allowsDicomweb(req) {
        if (this.record.profile !== 'local-research' || hostedDeployment(this.listeners)
            || !isLoopbackAddress(req.socket.remoteAddress)) return false;
        const headers = req.headers || {};
        if (!localAuthority(headers.host) || Object.keys(headers).some(name => proxyHeader(name.toLowerCase()))) return false;
        // The fixed, read-only local EASI View bridge uses this path marker,
        // never forwarding headers as evidence that a remote user is local.
        return headers['x-easi-store-public-base'] === undefined || headers['x-easi-store-public-base'] === '/easi-store/dicomweb';
    }
    canAssociate({ callingAeTitle, remoteAddress }) {
        if (typeof callingAeTitle !== 'string' || !/^[\x20-\x7e]{1,16}$/.test(callingAeTitle)
            || callingAeTitle.trim() !== callingAeTitle || callingAeTitle.includes('\\')) return false;
        if (this.record.profile === 'local-research') return isLoopbackAddress(remoteAddress);
        if (this.record.dimse.allowLoopback && isLoopbackAddress(remoteAddress)) return true;
        const address = normalizeAddress(remoteAddress);
        return !!address && this.record.dimse.peers.some(peer => peer.address === address && peer.callingAeTitle === callingAeTitle);
    }
    publicDescription(req) {
        return { profile: this.record.profile, dicomwebAuthenticationRequired: !this.allowsDicomweb(req),
            administratorAuthenticationRequired: true, dimseSecurity: 'Calling AE title and source IP policy; no HTTP user session or DICOM TLS.' };
    }
    async update(value) {
        const next = validateAccessPolicy(value, this.listeners);
        if (this.updating) throw Object.assign(new Error('An access policy update is already in progress. Retry shortly.'), { statusCode: 409 });
        this.updating = true;
        const temp = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
        try {
            const file = await open(temp, 'wx', 0o600);
            try { await file.writeFile(JSON.stringify(next) + '\n'); await file.sync(); } finally { await file.close(); }
            await rename(temp, this.path);
            // Rename durability precedes publication of the active policy.
            if (process.platform !== 'win32') {
                const directory = await open(this.dataDir, 'r');
                try { await directory.sync(); } finally { await directory.close(); }
            }
            this.record = next;
            return this.snapshot();
        } finally { this.updating = false; await rm(temp, { force: true }); }
    }
}
