import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn, execFile as execute } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DimseClient, NodeDimseCStoreScuTransport } from '@xinonix/easi-js/dimse/node';
import { createDicom } from './fixtures/synthetic.js';
const execFile = promisify(execute);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function port() {
    const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const number = server.address().port; await new Promise(resolve => server.close(resolve)); return number;
}
async function launch(args, env = {}) {
    const child = spawn(process.execPath, [cli, 'start', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
    const exited = once(child, 'exit');
    await Promise.race([new Promise((resolve, reject) => {
        const check = setInterval(() => { if (output.includes('Client access:')) { clearInterval(check); resolve(); }
            else if (child.exitCode !== null) { clearInterval(check); reject(new Error(errors)); } }, 10);
        check.unref();
    }), exited.then(() => { throw new Error(errors); })]);
    let stopping;
    return { child, stop() {
        if (stopping) return stopping;
        stopping = (async () => {
            assert.equal(child.exitCode, null, `The server exited before the test requested shutdown. ${errors}`);
            assert.equal(child.signalCode, null, `The server was terminated before the test requested shutdown. ${errors}`);
            const requested = child.kill('SIGTERM');
            assert.equal(requested, true, `The test could not request server shutdown. ${errors}`);
            const [code, signal] = await exited;
            // Windows may force-terminate a child for SIGTERM rather than run
            // its POSIX shutdown handler. Accept that result only after this
            // helper successfully requested it from a still-running child.
            if (process.platform === 'win32' && (signal === 'SIGTERM' || code === 1 && signal === null)) return;
            assert.equal(code, 0, errors);
            assert.equal(signal, null, errors);
        })();
        return stopping;
    } };
}

test('CLI research profile runs standard DIMSE and DICOMweb clients without an administrator session and persists access choice', { timeout: 20000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'easi-store-cli-access-'));
    let serverProcess; t.after(async () => { if (serverProcess) await serverProcess.stop(); await rm(dir, { recursive: true, force: true }); });
    const httpPort = await port(), dimsePort = await port();
    const args = ['--data-dir', dir, '--port', String(httpPort), '--dimse-port', String(dimsePort), '--dimse-host', '127.0.0.1'];
    serverProcess = await launch([...args, '--access-profile', 'local-research']);
    const base = `http://127.0.0.1:${httpPort}`;
    assert.equal((await (await fetch(base + '/api/v1/access')).json()).dicomwebAuthenticationRequired, false);
    assert.equal((await fetch(base + '/api/v1/summary')).status, 401);
    const association = { host: '127.0.0.1', port: dimsePort, calledAeTitle: 'EASISTORE', callingAeTitle: 'RESEARCH', timeoutMs: 5000 };
    assert.equal((await new DimseClient(association).echo()).status, 0);
    assert.equal((await new NodeDimseCStoreScuTransport().write(association, createDicom())).ok, true);
    assert.equal((await (await fetch(base + '/dicomweb/studies')).json()).length, 1);
    await serverProcess.stop(); serverProcess = null;
    assert.equal(JSON.parse(await readFile(join(dir, 'access-policy.json'), 'utf8')).profile, 'local-research');
    serverProcess = await launch(args);
    assert.equal((await fetch(base + '/dicomweb/studies')).status, 200);
    await serverProcess.stop(); serverProcess = null;
    serverProcess = await launch(args, { EASI_STORE_ACCESS_PROFILE: 'authenticated' });
    assert.equal((await fetch(base + '/dicomweb/studies')).status, 401);
});

test('CLI rejects research network exposure and untrusted network DIMSE but accepts a headless exact AE/IP policy', { timeout: 20000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'easi-store-cli-peers-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const common = ['start', '--data-dir', join(dir, 'archive'), '--port', String(await port()), '--dimse-port', String(await port())];
    await assert.rejects(execFile(process.execPath, [cli, ...common, '--host', '0.0.0.0', '--access-profile', 'local-research']), /literal loopback/);
    await assert.rejects(execFile(process.execPath, [cli, ...common, '--dimse-host', '0.0.0.0']), /explicit calling-AE\/IP/);
    const peers = join(dir, 'dimse-policy.json');
    await writeFile(peers, JSON.stringify({ allowLoopback: false, peers: [{ callingAeTitle: 'RESEARCH', address: '127.0.0.1' }] }));
    const serverProcess = await launch(common.slice(1).concat(['--dimse-host', '127.0.0.1', '--dimse-peers-file', peers]));
    try {
        const saved = JSON.parse(await readFile(join(dir, 'archive', 'access-policy.json'), 'utf8'));
        assert.deepEqual(saved.dimse, { allowLoopback: false, peers: [{ callingAeTitle: 'RESEARCH', address: '127.0.0.1' }] });
    } finally { await serverProcess.stop(); }
});
