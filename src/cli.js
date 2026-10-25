#!/usr/bin/env node
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStoreServer } from './server.js';
import { Archive } from './archive/Archive.js';
import { Auth } from './http/Auth.js';
import { isLoopbackAddress } from './http/AccessPolicy.js';
import { StorageScp } from './dimse/StorageScp.js';
import { createDemoStudy } from './synthetic.js';
import { VERSION } from './version.js';

export function defaultDataDir() {
    if (process.platform === 'darwin') return path.join(homedir(), 'Library/Application Support/EASI Store');
    if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData/Local'), 'EASI Store');
    return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local/share'), 'easi-store');
}
function parseArgs(args) {
    const values = { command: args.shift() || 'start' };
    while (args.length) {
        const key = args.shift();
        if (['--open', '--no-dimse'].includes(key)) values[key.slice(2)] = true;
        else if (['--data-dir', '--host', '--port', '--output', '--input', '--dimse-port', '--ae-title', '--public-url', '--label', '--credentials-file', '--access-profile', '--dimse-peers-file', '--dimse-host'].includes(key) && args[0] && !args[0].startsWith('--')) values[key.slice(2)] = args.shift();
        else throw new Error(`Unknown or incomplete option: ${key}`);
    }
    return values;
}
function portNumber(value, name) { const number = Number(value); if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`${name} must be 1–65535.`); return number; }
async function fileHash(p) { const hash = createHash('sha256'); for await (const chunk of createReadStream(p)) hash.update(chunk); return hash.digest('hex'); }
async function inventory(dir, base = dir) {
    const result = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Refusing a symbolic link in archive data.');
        if (entry.isDirectory()) result.push(...await inventory(p, base));
        else result.push({ path: path.relative(base, p).split(path.sep).join('/'), bytes: (await stat(p)).size, sha256: await fileHash(p) });
    }
    return result;
}
export async function main(args = process.argv.slice(2)) {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('EASI Store requires Node.js 24 LTS. Use the portable installer to include Node.');
    const o = parseArgs([...args]);
    const dataDir = path.resolve(o['data-dir'] || process.env.EASI_STORE_DATA_DIR || defaultDataDir());
    if (o.command === 'doctor') {
        console.log(JSON.stringify({ product: 'EASI Store', version: VERSION, node: process.version, platform: process.platform,
            architecture: process.arch, dataDir, dataExists: existsSync(dataDir), uiBuilt: existsSync(fileURLToPath(new URL('../dist/public/index.html', import.meta.url))),
            dicomweb: 'QIDO/STOW/originals + nested metadata/frame/bulk retrieval', dimse: 'C-ECHO / durable C-STORE / C-FIND / C-GET / configured C-MOVE', productionQualified: false }, null, 2)); return;
    }
    if (o.command === 'token') {
        const archive = await Archive.open({ dataDir });
        try { const auth = await new Auth(dataDir).open(); console.log(await auth.issueApiToken(o.label)); }
        finally { await archive.close(); }
        return;
    }
    if (o.command === 'demo') {
        const archive = await Archive.open({ dataDir });
        try { for (const bytes of createDemoStudy()) await archive.ingest(Readable.from([bytes]), { source: 'synthetic-demo' }); console.log('Imported 12 generated synthetic CT images.'); }
        finally { await archive.close(); } return;
    }
    if (o.command === 'backup') {
        if (!o.output) throw new Error('Provide --output for a new private backup directory. Stop EASI Store first.');
        const output = path.resolve(o.output);
        if (output === dataDir || output.startsWith(dataDir + path.sep) || dataDir.startsWith(output + path.sep)) throw new Error('Backup and archive data directories must be separate.');
        const archive = await Archive.open({ dataDir });
        try {
            if (existsSync(output)) throw new Error('Backup destination must not exist.');
            archive.checkpoint();
            await mkdir(output, { mode: 0o700, recursive: false });
            // SQLite backup is offline: this process owns the archive lock and no writes occur.
            // Ignore process lock and transient spool; journal recovery ran during open().
            for (const entry of await readdir(dataDir, { withFileTypes: true })) {
                if (entry.name.includes('lock') || ['spool', 'tmp'].includes(entry.name)) continue;
                if (entry.isSymbolicLink()) throw new Error('Refusing a symbolic link in archive data.');
                await cp(path.join(dataDir, entry.name), path.join(output, entry.name), { recursive: true, errorOnExist: true });
            }
            const files = await inventory(output);
            await writeFile(path.join(output, 'backup-manifest.json'), JSON.stringify({ product: 'EASI Store', version: VERSION, createdAt: new Date().toISOString(), stats: archive.stats(), files }, null, 2), { mode: 0o600 });
            console.log(`Verified offline backup written (${files.length} files). It contains archive data and credentials; keep it private.`);
        } finally { await archive.close(); }
        return;
    }
    if (o.command === 'restore') {
        if (!o.input) throw new Error('Provide --input with a verified backup directory and --data-dir with a new destination.');
        if (existsSync(dataDir)) throw new Error('Restore destination must not exist.');
        const input = path.resolve(o.input), manifest = JSON.parse(await readFile(path.join(input, 'backup-manifest.json'), 'utf8'));
        if (manifest.product !== 'EASI Store' || !['0.1.0', '0.2.0', '0.2.1', VERSION].includes(manifest.version) || !Array.isArray(manifest.files)) throw new Error('Unsupported backup manifest.');
        for (const file of manifest.files) {
            const p = path.resolve(input, file.path);
            if (!p.startsWith(input + path.sep) || (await stat(p)).size !== file.bytes || await fileHash(p) !== file.sha256) throw new Error('Backup integrity verification failed.');
        }
        await mkdir(dataDir, { mode: 0o700 });
        for (const file of manifest.files) {
            const p = path.resolve(dataDir, file.path);
            await mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
            await cp(path.join(input, file.path), p); await chmod(p, 0o600);
        }
        const archive = await Archive.open({ dataDir });
        try { console.log(`Restored ${archive.stats().instances} instances; integrity verified.`); } finally { await archive.close(); }
        return;
    }
    if (o.command !== 'start') throw new Error('Commands: start, doctor, demo, token, backup, restore.');
    const host = o.host || process.env.EASI_STORE_HOST || '127.0.0.1';
    const dimseHost = o['dimse-host'] || process.env.EASI_STORE_DIMSE_HOST || (isLoopbackAddress(host) ? host : '127.0.0.1');
    const port = portNumber(o.port || process.env.EASI_STORE_PORT || 8048, 'HTTP port');
    const credentialsFile = o['credentials-file'] || process.env.EASI_STORE_CREDENTIALS_FILE;
    let credentials = {};
    if (credentialsFile) {
        const info = await stat(credentialsFile);
        if (!info.isFile() || info.size > 65536 || process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Use a private credentials JSON file (owner access only, at most 64 KiB).');
        credentials = JSON.parse(await readFile(credentialsFile, 'utf8'));
        if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('The credentials file must contain a named credential object.');
    }
    const accessProfile = o['access-profile'] || process.env.EASI_STORE_ACCESS_PROFILE;
    const dimsePeersFile = o['dimse-peers-file'] || process.env.EASI_STORE_DIMSE_PEERS_FILE;
    let dimsePolicy;
    if (dimsePeersFile) {
        const info = await stat(dimsePeersFile);
        if (!info.isFile() || info.size > 65536) throw new Error('Use a DIMSE policy JSON file of at most 64 KiB.');
        dimsePolicy = JSON.parse(await readFile(dimsePeersFile, 'utf8'));
    }
    const app = await createStoreServer({ dataDir, host, port, publicUrl: o['public-url'] || process.env.EASI_STORE_PUBLIC_URL, credentials, accessProfile, dimsePolicy, dimseHost });
    let dimse;
    try {
        await app.listen();
        if (!o['no-dimse'] && process.env.EASI_STORE_DIMSE !== 'off') {
            const dimsePort = portNumber(o['dimse-port'] || process.env.EASI_STORE_DIMSE_PORT || 4248, 'DIMSE port');
            dimse = new StorageScp({ archive: app.archive, auth: app.auth, host: dimseHost, port: dimsePort, aeTitle: o['ae-title'] || process.env.EASI_STORE_AE_TITLE || 'EASISTORE',
                resolveMoveDestination: aeTitle => app.connections.resolveMoveDestination(aeTitle),
                associationPolicy: peer => app.accessPolicy.canAssociate(peer),
                archiveReady: () => app.accessPolicy.record.profile === 'local-research' || Boolean(app.auth.record) });
            await dimse.listen(); app.capabilities.dimse.enabled = true;
            app.capabilities.dimse.host = dimseHost; app.capabilities.dimse.port = dimsePort; app.capabilities.dimse.aeTitle = dimse.aeTitle;
            console.log(`DIMSE: ${dimse.aeTitle} on ${dimseHost}:${dimsePort} (C-ECHO / durable C-STORE / FIND / GET / MOVE).`);
        }
    } catch (error) { await dimse?.close(); await app.close(); throw error; }
    const url = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host}:${port}/`;
    console.log(`EASI Store ${VERSION} preview: ${url}`);
    console.log(`Archive data: ${dataDir}`);
    console.log(`Client access: ${app.accessPolicy.record.profile}${app.accessPolicy.record.profile === 'local-research' ? ' (loopback DICOMweb and DIMSE clients need no administrator session)' : ' (DICOMweb requires a session or bearer token; DIMSE uses AE/IP access policy)'}.`);
    if (!app.auth.record) console.log('Open the browser to create your administrator. Container bootstrap token: <data directory>/bootstrap-token.');
    if (o.open) {
        const command = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url];
        const child = spawn(command[0], command.slice(1), { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref();
    }
    let stopping = false;
    const stop = async () => {
        if (stopping) return; stopping = true;
        console.log('Finishing pending archive operations…');
        await dimse?.close(); await app.close();
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop().catch(() => { process.exitCode = 1; }));
    return { app, dimse, stop };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
    console.error(error.code === 'EADDRINUSE' ? 'A port is already in use. Choose --port / --dimse-port or stop the existing EASI Store.' : error.message);
    process.exitCode = 1;
});
