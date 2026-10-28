#!/usr/bin/env node
// Real CLI processes, generated originals, and disposable local durable storage.
// This is a bounded operational qualification, not a throughput benchmark.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDicom, uid } from '../src/synthetic.js';
import { VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'src/cli.js');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let reportPath;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--report' && process.argv[index + 1]) reportPath = path.resolve(process.argv[++index]);
  else if (process.argv[index] === '--help') { console.log('Usage: node scripts/qualify-operations.mjs [--report PRIVATE_REPORT.json]\nRuns generated-only concurrent imports/reads, process-kill recovery, and offline CLI backup/restore in disposable local directories.'); process.exit(0); }
  else throw new Error('Use only the optional --report path.');
}
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Operational qualification requires Node.js 24.');
const startTime = Date.now(), timeout = new AbortController();
const deadline = setTimeout(() => timeout.abort(new Error('Operational qualification exceeded 30 seconds.')), 30000);
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'easi-store-operations-')));
const data = path.join(temporary, 'archive'), backup = path.join(temporary, 'backup'), restored = path.join(temporary, 'restored');
const children = new Set(); let partial;
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith('EASI_STORE_')) delete environment[key];
const report = { version: VERSION, checkedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, runtime: process.version,
  syntheticOnly: true, instances: 160, importConcurrency: 4, checks: [], originalMedicalDataUsed: false, credentialsRecorded: false, temporaryArchivesRemoved: false };
let step = 'prepare', cookie, retained, revoked, current;
const credentials = { username: 'generated-operations-admin', password: randomBytes(32).toString('base64url') };
const checked = (condition, message) => assert.ok(condition, message);
const pass = (name, facts = {}) => report.checks.push({ name, passed: true, ...facts });
const checkTime = () => timeout.signal.throwIfAborted();

function launch(args) {
  checkTime();
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const item = { child, exited: false, code: null, spawnFailed: false, bytes: 0 };
  children.add(item);
  // Startup output contains the private temporary path; never retain or print it.
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { item.bytes += chunk.length; });
  item.done = new Promise(resolve => { child.once('error', () => { item.spawnFailed = true; item.exited = true; resolve(); }); child.once('exit', code => { item.code = code; item.exited = true; resolve(); }); });
  return item;
}
async function waitExit(item, milliseconds) {
  return Promise.race([item.done.then(() => true), delay(milliseconds).then(() => false)]);
}
async function terminate(item, force = false) {
  if (!item || item.exited) return;
  if (process.platform === 'win32' && force) {
    const killer = spawn('taskkill', ['/PID', String(item.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await new Promise(resolve => { killer.once('error', resolve); killer.once('exit', resolve); });
  } else item.child.kill(force ? 'SIGKILL' : 'SIGTERM');
  if (!await waitExit(item, 3000)) { item.child.kill('SIGKILL'); checked(await waitExit(item, 2000), 'Disposable CLI process did not stop.'); }
}
async function runCli(args) {
  const item = launch(args);
  for (let attempt = 0; !item.exited && attempt < 200; attempt++) { checkTime(); await delay(25); }
  checked(item.exited && !item.spawnFailed && item.code === 0, 'Offline CLI operation did not finish successfully.');
}
async function freePort() {
  const socket = createServer(); await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
const port = await freePort(), base = `http://127.0.0.1:${port}`;
async function start(directory) {
  const item = launch(['start', '--host', '127.0.0.1', '--port', String(port), '--data-dir', directory, '--no-dimse']);
  for (let attempt = 0; attempt < 100; attempt++) {
    checkTime(); checked(!item.exited && !item.spawnFailed, 'Disposable CLI exited before serving requests.');
    try { const response = await fetch(base + '/api/health', { signal: AbortSignal.any([timeout.signal, AbortSignal.timeout(300)]) }); await response.body?.cancel(); if (response.status === 200) return item; } catch { checkTime(); }
    await delay(25);
  }
  throw new Error('Disposable CLI did not become live.');
}
async function api(route, { method = 'GET', body, bytes, token, authenticated = true } = {}) {
  return fetch(base + route, { method, redirect: 'error', signal: AbortSignal.any([timeout.signal, AbortSignal.timeout(5000)]),
    headers: { ...(authenticated ? token ? { Authorization: `Bearer ${token}` } : cookie ? { Cookie: cookie } : {} : {}),
      ...(method === 'GET' ? {} : { 'X-EASI-Store': '1', 'Content-Type': bytes ? 'application/dicom' : 'application/json' }) },
    ...(method === 'GET' ? {} : { body: bytes ?? JSON.stringify(body ?? {}) }) });
}
async function json(route, options = {}, status = 200) {
  const response = await api(route, options); checked(response.status === status, `Operational API expected ${status}, received ${response.status}.`); return response.json();
}
async function status(route, options, expected) { const response = await api(route, options); await response.body?.cancel(); checked(response.status === expected, 'Credential authorization changed during recovery.'); }
async function signIn(route) {
  const response = await api(route, { method: 'POST', authenticated: false, body: credentials });
  checked(response.status === 200, 'Generated local administrator sign-in failed.');
  cookie = response.headers.get('set-cookie')?.split(';')[0]; await response.body?.cancel(); checked(Boolean(cookie), 'Local sign-in did not return a session.');
}
async function original(record, token = retained) {
  const response = await api(`/api/v1/download/${record.instance.studyUid}/${record.instance.seriesUid}/${record.instance.sopUid}`, { token });
  checked(response.status === 200, 'An acknowledged original could not be read.');
  checked(sha(Buffer.from(await response.arrayBuffer())) === record.hash, 'An acknowledged original changed encoded bytes.');
}
async function mapConcurrent(items, count, task) {
  let cursor = 0; await Promise.all(Array.from({ length: count }, async () => { while (cursor < items.length) { checkTime(); const index = cursor++; await task(items[index], index); } }));
}
async function credentialChecks() {
  const session = await json('/api/v1/session', { token: retained }); checked(session.identity?.role === 'reader', 'Retained token lost its Reader role.');
  await status('/api/v1/health', { token: retained }, 403); await status('/api/v1/summary', { token: revoked }, 401);
}
async function verify(records) {
  checked((await json('/api/v1/summary', { token: retained })).instances === records.length, 'Recovery changed acknowledged catalog membership.');
  await mapConcurrent(records, 4, record => original(record)); await credentialChecks();
}

try {
  step = 'setup'; current = await start(data);
  await signIn('/api/v1/setup');
  const issued = await json('/api/v1/auth/tokens', { method: 'POST', body: { label: 'Generated retained Reader', role: 'reader', expiresInDays: 1 } }, 201);
  retained = issued.token;
  const removed = await json('/api/v1/auth/tokens', { method: 'POST', body: { label: 'Generated revoked Reader', role: 'reader', expiresInDays: 1 } }, 201);
  revoked = removed.token; await json('/api/v1/auth/tokens/' + removed.credential.id, { method: 'DELETE' }); await credentialChecks();
  pass('real-cli-loopback-authenticated-archive-and-role-bound-credentials');

  step = 'mixed-load'; const groups = Array.from({ length: 8 }, () => ({ studyUid: uid(), seriesUid: uid() }));
  const records = [], inputs = Array.from({ length: report.instances }, (_, index) => createDicom({ ...groups[index % groups.length], rows: index % 3 ? 64 : 128, columns: index % 3 ? 64 : 128,
    modality: ['CT', 'MR', 'US'][index % 3], frames: index % 3 === 2 ? 3 : 1, instanceNumber: Math.floor(index / groups.length) + 1, patientId: 'GENERATED-OPERATIONS-' + index % 4 }));
  let importing = true, queries = 0, parallelReads = 0, observerError;
  const observer = (async () => {
    while (importing) {
      await json('/api/v1/studies?limit=10', { token: retained }); queries++;
      await json('/api/v1/summary', { token: retained });
      if (records.length) { await original(records[records.length - 1]); parallelReads++; }
      await delay(10);
    }
  })().catch(error => { observerError = error; });
  try { await mapConcurrent(inputs, 4, async bytes => { const value = await json('/api/v1/instances', { method: 'POST', bytes }, 201); checked(Boolean(value.instance), 'Acknowledged import omitted its catalog identity.'); records.push({ instance: value.instance, hash: sha(bytes) }); }); }
  finally { importing = false; await observer; }
  if (observerError) throw observerError;
  checked(records.length === report.instances && queries > 0 && parallelReads > 0, 'Mixed import/query/original workloads did not overlap.');
  await verify(records); pass('four-concurrent-durable-import-workers-with-live-queries-and-original-sha256', { acknowledged: records.length, queries, concurrentOriginalReads: parallelReads, generatedBytes: inputs.reduce((sum, value) => sum + value.length, 0) });

  step = 'kill-during-partial-upload'; let partialResponse = false;
  const pending = createDicom({ rows: 512, columns: 512 });
  partial = httpRequest(base + '/api/v1/instances', { method: 'POST', headers: { Cookie: cookie, 'X-EASI-Store': '1', 'Content-Type': 'application/dicom', 'Content-Length': pending.length } });
  partial.on('error', () => {}); partial.on('response', response => { partialResponse = true; response.resume(); }); partial.write(pending.subarray(0, 65536));
  let observedPartial = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    checkTime(); for (const file of await readdir(path.join(data, 'spool'))) if (file.endsWith('.partial') && (await stat(path.join(data, 'spool', file))).size > 0) observedPartial = true;
    if (observedPartial) break; await delay(10);
  }
  checked(observedPartial && !partialResponse, 'Unfinished upload was not observed before process termination.');
  await terminate(current, true); partial.destroy(); partial = null; current = await start(data); await signIn('/api/v1/login'); await verify(records);
  checked((await readdir(path.join(data, 'spool'))).every(name => !name.endsWith('.partial')), 'Restart retained an unfinished partial upload.');
  checked((await readdir(path.join(data, 'journal'))).length === 0, 'Restart left unfinished durable journal work.');
  pass('process-kill-with-unfinished-upload-preserves-all-acks-and-no-phantom-catalog-entry', { acknowledgedVerified: records.length, unfinishedUploadAcknowledged: false, spoolRecovered: true, retainedAndRevokedTokensVerified: true });

  step = 'offline-backup-restore'; await terminate(current); current = null;
  await runCli(['backup', '--data-dir', data, '--output', backup]);
  const manifest = JSON.parse(await readFile(path.join(backup, 'backup-manifest.json'), 'utf8'));
  checked(manifest.stats.instances === records.length && manifest.files.some(file => file.path === 'auth.json'), 'Offline backup did not cover catalog and identity state.');
  await runCli(['restore', '--data-dir', restored, '--input', backup]); current = await start(restored); await signIn('/api/v1/login'); await verify(records);
  pass('offline-cli-backup-and-restore-preserve-originals-catalog-and-credential-revocation', { originalsVerified: records.length, backupFiles: manifest.files.length, restoredIntoSeparateDirectory: true });
  step = 'restored-integrity-audit';
  let audit = await json('/api/v1/health/audits', { method: 'POST', body: { verifyHashes: true } }, 202);
  for (let attempt = 0; audit.status === 'running' && attempt < 100; attempt++) { checkTime(); await delay(25); audit = await json('/api/v1/health/audits/' + audit.id); }
  checked(audit.status === 'completed' && Object.values(audit.counts).every(count => count === 0) && audit.progress.indexed === records.length, 'Restored archive failed full original integrity review.');
  pass('restored-archive-completes-read-only-original-size-and-sha256-audit', { originalsVerified: audit.progress.indexed, findings: 0 });
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = { step, reason: timeout.signal.aborted ? 'qualification-timeout' : error instanceof assert.AssertionError ? error.message : 'Operational qualification failed at the recorded step.' }; process.exitCode = 1;
} finally {
  clearTimeout(deadline); partial?.destroy();
  for (const child of children) try { await terminate(child, true); } catch { report.passed = false; report.cleanupError = true; process.exitCode = 1; }
  try { await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); report.temporaryArchivesRemoved = true; } catch { report.passed = false; report.cleanupError = true; process.exitCode = 1; }
  report.elapsedMs = Date.now() - startTime;
  if (reportPath) { await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  console.log(JSON.stringify(report, null, 2));
}
