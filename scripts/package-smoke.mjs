#!/usr/bin/env node
// Execute only on an artifact produced by this checkout's trusted packager.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

let artifact = process.argv[2];
if (artifact === '--latest') {
  const directory = path.resolve('artifacts');
  const suffix = `${process.platform}-${process.arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const candidates = (await readdir(directory)).filter(filename => filename.startsWith('easi-store-') && filename.endsWith(suffix));
  if (candidates.length !== 1) throw new Error('Expected exactly one bundled current-platform artifact; provide its explicit path.');
  artifact = path.join(directory, candidates[0]);
}
if (!artifact) throw new Error('Usage: node scripts/package-smoke.mjs /absolute/path/to/trusted-current-platform-artifact (or --latest)');
const archivePath = path.resolve(artifact);
const scratch = await mkdtemp(path.join(tmpdir(), 'easi-store-portable-smoke-'));
let child;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    const process = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.on('data', bytes => { output += bytes; });
    process.stderr.on('data', bytes => { output += bytes; });
    process.once('error', reject);
    process.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} failed (${code}): ${output.slice(-4000)}`)));
  });
}
async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const current = child;
  const exited = new Promise(resolve => {
    const timer = setTimeout(() => { if (current.exitCode === null && current.signalCode === null) current.kill('SIGKILL'); }, 15_000);
    current.once('close', () => { clearTimeout(timer); resolve(); });
  });
  // A Windows .cmd launcher owns a child process; terminate only this test's
  // exact process tree. Unix launchers exec Node and receive graceful SIGTERM.
  if (process.platform === 'win32') {
    await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(current.pid), '/T', '/F']);
  } else current.kill('SIGTERM');
  await exited;
}

try {
  await run('tar', ['-xf', archivePath, '-C', scratch]);
  const directories = (await readdir(scratch, { withFileTypes: true })).filter(item => item.isDirectory());
  if (directories.length !== 1) throw new Error('Artifact must contain exactly one application directory.');
  const bundle = path.join(scratch, directories[0].name);
  const manifest = JSON.parse(await readFile(path.join(bundle, 'ARTIFACT.json'), 'utf8'));
  const target = `${process.platform}-${process.arch}`;
  if (manifest.target !== target || !manifest.runtime || manifest.runtime.target !== target) throw new Error('Smoke test requires a runtime bundle for this native OS/CPU.');
  for (const file of manifest.files) {
    const location = path.resolve(bundle, file.path);
    if (!location.startsWith(bundle + path.sep) || (await stat(location)).size !== file.bytes || await digest(location) !== file.sha256) throw new Error(`Artifact inventory mismatch: ${file.path}`);
  }
  const runtime = process.platform === 'win32' ? path.join(bundle, 'runtime/node.exe') : path.join(bundle, 'runtime/bin/node');
  const runtimeVersion = await run(runtime, ['--version']);
  if (runtimeVersion !== `v${manifest.runtime.version}`) throw new Error('Bundled runtime version does not match its manifest.');
  const emptyPath = path.join(scratch, 'without-node');
  await mkdir(emptyPath);
  if (process.platform !== 'win32') {
    await symlink('/usr/bin/dirname', path.join(emptyPath, 'dirname'));
    // Do not launch a real browser during a packaging check.
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    await writeFile(path.join(emptyPath, opener), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const dataDir = path.join(scratch, 'archive-data');
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const entry = path.join(bundle, process.platform === 'win32' ? 'Start EASI Store.cmd' : process.platform === 'darwin' ? 'Start EASI Store.command' : 'Start EASI Store.sh');
  await access(entry);
  let output = '';
  const launch = async () => {
    const environment = { ...process.env, PATH: emptyPath, EASI_STORE_DATA_DIR: dataDir, EASI_STORE_PORT: String(port), EASI_STORE_DIMSE: 'off' };
    const command = process.platform === 'win32' ? process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', `call "${entry}"`] : [entry];
    child = spawn(command, args, { cwd: bundle, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: process.platform === 'win32' });
    child.stdout.on('data', bytes => { output = (output + bytes).slice(-8000); });
    child.stderr.on('data', bytes => { output = (output + bytes).slice(-8000); });
    let launchError;
    child.once('error', error => { launchError = error; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Portable launcher exited before health: ${output}`);
      try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* service starting */ }
      await delay(100);
    }
    throw new Error(`Portable service failed to become healthy: ${output}`);
  };
  const password = randomBytes(24).toString('base64url');
  const credentials = { username: 'portable-check', password };
  const mutation = (endpoint, value, cookie) => fetch(`${base}/api/v1/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EASI-Store': '1', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(value) });
  await launch();
  let response = await mutation('setup', credentials);
  if (!response.ok) throw new Error(`Portable first setup failed: ${response.status}`);
  let cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Portable setup did not establish a session.');
  response = await mutation('demo', {}, cookie);
  if (!response.ok) throw new Error(`Portable synthetic import failed: ${response.status}`);
  response = await fetch(`${base}/api/v1/summary`, { headers: { Cookie: cookie } });
  const before = await response.json();
  if (!response.ok || before.instances !== 12) throw new Error('Portable archive did not retain the 12 synthetic instances.');
  await stop();
  await launch();
  response = await mutation('login', credentials);
  if (!response.ok) throw new Error(`Portable restart login failed: ${response.status}`);
  cookie = response.headers.get('set-cookie')?.split(';')[0];
  response = await fetch(`${base}/api/v1/summary`, { headers: { Cookie: cookie } });
  const after = await response.json();
  if (!response.ok || after.instances !== before.instances || after.bytes !== before.bytes) throw new Error('Portable restart lost catalog state.');
  await stop();
  console.log(JSON.stringify({ artifact: archivePath, sha256: await digest(archivePath), target, runtime: runtimeVersion, inventoryFilesVerified: manifest.files.length, systemNodeAvailableToLauncher: false, setup: 'passed', syntheticInstances: after.instances, restartPersistence: 'passed' }, null, 2));
} finally {
  await stop();
  await rm(scratch, { recursive: true, force: true });
}
