#!/usr/bin/env node
// Execute only on an artifact produced by this checkout's trusted packager.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readZip } from '../test/fixtures/independent-zip.js';

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
    const { sensitiveOutput = false, ...spawnOptions } = options;
    let output = '', errors = '';
    const process = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.on('data', bytes => { output += bytes; });
    process.stderr.on('data', bytes => { errors += bytes; });
    process.once('error', reject);
    process.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} failed (${code})${sensitiveOutput ? '' : `: ${(output + errors).slice(-4000)}`}`)));
  });
}

async function checkedJson(response, expectedStatus = 200) {
  if (response.status !== expectedStatus) { await response.body?.cancel(); throw new Error(`Portable API expected HTTP ${expectedStatus}, received ${response.status}.`); }
  return response.json();
}
async function completedHealthAudit(base, cookie, id, instances, bytes) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const report = await checkedJson(await fetch(`${base}/api/v1/health/audits/${id}`, {headers:{Cookie:cookie}}));
    if (report.status !== 'running') {
      if (report.status !== 'completed' || report.verifyHashes !== true || report.progress.indexed !== instances || report.progress.bytes !== bytes || Object.values(report.counts).some(value => value !== 0) || report.findings.length || report.findingsTruncated) throw new Error('Portable full integrity review did not verify every unchanged original.');
      return report;
    }
    await delay(100);
  }
  throw new Error('Portable full integrity review did not complete in time.');
}
async function publicHealth(base, ready, version) {
  const live = await checkedJson(await fetch(`${base}/api/health`));
  const readiness = await checkedJson(await fetch(`${base}/api/ready`), ready ? 200 : 503);
  if (live.status !== 'ok' || live.version !== version || readiness.ready !== ready || readiness.version !== version || Object.keys(readiness).sort().join(',') !== 'ready,version') throw new Error('Portable liveness or minimal readiness response is incorrect.');
}
async function packagedSupplyChain(bundle, inventory) {
  const application = JSON.parse(await readFile(path.join(bundle, 'package.json'), 'utf8'));
  const sbom = JSON.parse(await readFile(path.join(bundle, 'SBOM.cdx.json'), 'utf8'));
  const root = sbom.metadata?.component;
  const fullName = root?.group ? `${root.group}/${root.name}` : root?.name;
  if (sbom.bomFormat !== 'CycloneDX' || root?.type !== 'application' || fullName !== application.name || root.version !== inventory.version || root['bom-ref'] !== `${application.name}@${inventory.version}` || application.version !== inventory.version) throw new Error('Portable CycloneDX inventory does not identify the packaged release.');
  for (const name of Object.keys(application.dependencies || {})) {
    const installed = JSON.parse(await readFile(path.join(bundle, 'node_modules', name, 'package.json'), 'utf8'));
    if (!sbom.components?.some(item => (item.group ? `${item.group}/${item.name}` : item.name) === name && item.version === installed.version)) throw new Error(`Portable CycloneDX inventory omitted a runtime dependency: ${name}.`);
  }
  if (!sbom.dependencies?.some(item => item.ref === root['bom-ref']) || !(await readFile(path.join(bundle, 'SECURITY.md'), 'utf8')).trim()) throw new Error('Portable security guidance or root dependency graph is missing.');
  if (inventory.runtime.packageManagersIncluded !== false) throw new Error('Portable runtime did not declare package-manager omission.');
  for (const relative of ['lib/node_modules/npm','lib/node_modules/corepack','node_modules/npm','node_modules/corepack','bin/npm','bin/npx','bin/corepack','npm','npm.cmd','npm.ps1','npx','npx.cmd','npx.ps1','corepack','corepack.cmd','corepack.ps1']) {
    try { await lstat(path.join(bundle, 'runtime', relative)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Portable runtime retained an unused package manager: ${relative}.`);
  }
}
async function singlePart(response, expectedLocation) {
  if (response.status !== 200) throw new Error(`Portable frame/bulk retrieval failed: ${response.status}.`);
  const boundary = response.headers.get('content-type')?.match(/^multipart\/related;.*boundary="([^"]+)"/i)?.[1];
  if (!boundary) throw new Error('Portable pixel retrieval did not return a multipart boundary.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) throw new Error('Portable synthetic frame response unexpectedly exceeded 1 MiB.');
  const opening = Buffer.from(`--${boundary}\r\n`), closing = Buffer.from(`\r\n--${boundary}--\r\n`);
  if (!bytes.subarray(0, opening.length).equals(opening) || !bytes.subarray(-closing.length).equals(closing)) throw new Error('Portable pixel response has invalid multipart framing.');
  const headerEnd = bytes.indexOf('\r\n\r\n');
  if (headerEnd < opening.length || headerEnd > 16384) throw new Error('Portable pixel response has invalid multipart headers.');
  const headers = bytes.subarray(opening.length, headerEnd).toString('ascii');
  if (!/Content-Type: application\/octet-stream; transfer-syntax=1\.2\.840\.10008\.1\.2\.1(?:\r\n|$)/i.test(headers) || !headers.split('\r\n').some(line => line === `Content-Location: ${expectedLocation}`)) throw new Error('Portable native frame response has incorrect media, transfer syntax, or identity.');
  return bytes.subarray(headerEnd + 4, bytes.length - closing.length);
}

async function phase2Dicomweb(base, cookie, sample) {
  const headers = { Cookie: cookie }, pixelHeaders = { ...headers, Accept: 'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1' };
  const resource = `/dicomweb/studies/${sample.studyUid}/series/${sample.seriesUid}/instances/${sample.sopUid}`;
  const list = await checkedJson(await fetch(`${base}/dicomweb/studies?StudyInstanceUID=${sample.studyUid}&includefield=00080020,00080050,00080061,00081030,00100010,00100020,00100021,00100030,0020000D,00201206,00201208`, { headers }));
  if (list.length !== 1 || list[0]['0020000D']?.Value?.[0] !== sample.studyUid) throw new Error('Portable QIDO did not accept the standalone viewer return fields.');
  for (const suffix of [`/dicomweb/studies/${sample.studyUid}/metadata`, `/dicomweb/studies/${sample.studyUid}/series/${sample.seriesUid}/metadata`, `${resource}/metadata`]) {
    const metadata = await checkedJson(await fetch(`${base}${suffix}`, { headers }));
    const instance = metadata.find(item => item['00080018']?.Value?.[0] === sample.sopUid);
    if (!instance || instance['7FE00010']?.InlineBinary || instance['7FE00010']?.Value) throw new Error('Portable metadata did not exclude inline pixels.');
    if (instance['52009229']?.Value?.[0]?.['00289110']?.Value?.[0]?.['00280030']?.Value?.join(',') !== '0.7,0.8' || instance['52009230']?.Value?.length !== 2) throw new Error('Portable metadata lost nested functional groups.');
    const pixelUri = instance['7FE00010']?.BulkDataURI;
    if (pixelUri !== `${resource}/bulkdata/7FE00010`) throw new Error('Portable metadata did not supply the protected pixel bulk URI.');
    if (suffix === `${resource}/metadata`) {
      const bulk = await singlePart(await fetch(`${base}${pixelUri}`, { headers: pixelHeaders }), pixelUri);
      if (!bulk.equals(sample.pixels)) throw new Error('Portable native bulk retrieval changed sample bytes.');
      const nestedUri = instance['77771010']?.Value?.[0]?.['77771011']?.BulkDataURI;
      if (nestedUri !== `${resource}/bulkdata/77771010/1/77771011`) throw new Error('Portable metadata lost a nested bulk reference.');
      const nested = await singlePart(await fetch(`${base}${nestedUri}`, { headers: pixelHeaders }), nestedUri);
      if (!nested.equals(sample.nestedBytes)) throw new Error('Portable nested bulk retrieval changed bytes.');
    }
  }
  for (const frame of [1,2]) {
    const location = `${resource}/frames/${frame}`;
    const bytes = await singlePart(await fetch(`${base}${location}`, { headers: pixelHeaders }), location);
    if (!bytes.equals(sample.pixels.subarray((frame - 1) * sample.frameBytes, frame * sample.frameBytes))) throw new Error('Portable native frame selection returned incorrect samples.');
  }
  const thumbnail = await fetch(`${base}/api/v1/studies/${sample.studyUid}/series/${sample.seriesUid}/instances/${sample.sopUid}/thumbnail?frame=2`, { headers });
  if (thumbnail.status !== 200 || thumbnail.headers.get('content-type') !== 'image/png') throw new Error(`Portable thumbnail rendering failed: ${thumbnail.status}.`);
  const png = Buffer.from(await thumbnail.arrayBuffer());
  if (!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.subarray(12,16).toString('ascii') !== 'IHDR' || png.readUInt32BE(16) < 1 || png.readUInt32BE(16) > 128 || png.readUInt32BE(20) < 1 || png.readUInt32BE(20) > 128) throw new Error('Portable thumbnail did not produce a bounded PNG image.');
  for (const suffix of [`${resource}/metadata`, `${resource}/frames/1`, `${resource}/bulkdata/7FE00010`, `/api/v1/studies/${sample.studyUid}/series/${sample.seriesUid}/thumbnail`]) {
    const response = await fetch(`${base}${suffix}`); await response.body?.cancel();
    if (response.status !== 401) throw new Error('Portable medical data route allowed an unauthenticated request.');
  }
  let response = await fetch(`${base}${resource}/metadata`, { headers: { ...headers, 'X-EASI-Store-Public-Base': '/untrusted-prefix' } });
  await response.body?.cancel(); if (response.status !== 400) throw new Error('Portable server accepted an untrusted public response prefix.');
  response = await fetch(`${base}${resource}/frames/2`, { headers: { ...pixelHeaders, 'X-EASI-Store-Public-Base': '/easi-store/dicomweb' } });
  await singlePart(response, `/easi-store${resource}/frames/2`);
}

async function datasetPost(base, cookie, suffix, body) {
  return fetch(`${base}/api/v1/datasets${suffix}`, { method:'POST', headers:{'Content-Type':'application/json','X-EASI-Store':'1',...(cookie ? {Cookie:cookie} : {})},body:JSON.stringify(body) });
}
async function datasetSmoke(base, cookie, sample, original, bundle) {
  const headers = {Cookie:cookie};
  const dataset = await checkedJson(await datasetPost(base,cookie,'',{name:'Portable frozen synthetic cohort',selection:[{studyUid:sample.studyUid,seriesUid:sample.seriesUid}]}),201);
  const readiness = await checkedJson(await fetch(`${base}/api/v1/datasets/${dataset.id}/readiness`,{headers}));
  if (dataset.selection.length !== 1 || readiness.summary.subjects !== 1 || readiness.summary.studies !== 1 || readiness.summary.series !== 1 || readiness.summary.instances !== 1 || readiness.summary.bytes !== original.length || readiness.series[0]?.frames !== sample.frames) throw new Error('Portable dataset readiness did not describe the explicit synthetic selection.');
  const version = await checkedJson(await datasetPost(base,cookie,`/${dataset.id}/versions`,{revision:dataset.revision}),201);
  const response = await fetch(`${base}/api/v1/datasets/${dataset.id}/versions/${version.version}/manifest`,{headers});
  if (response.status !== 200) throw new Error(`Portable dataset manifest failed: ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer()), sha256 = createHash('sha256').update(bytes).digest('hex'), manifest = JSON.parse(bytes);
  if (version.version !== 1 || version.manifestSha256 !== sha256 || response.headers.get('x-easi-manifest-sha256') !== sha256 || manifest.schemaVersion !== 1 || manifest.kind !== 'easi-store-dataset' || manifest.datasetId !== dataset.id || manifest.version !== version.version || manifest.snapshotId !== version.snapshotId || manifest.split !== null || manifest.members.length !== 1 || manifest.summary.instances !== 1) throw new Error('Portable immutable dataset manifest has inconsistent membership, identity or SHA-256.');
  const member = manifest.members[0], memberPath = `/api/v1/datasets/${dataset.id}/versions/${version.version}/members/${member.memberId}/original`;
  if (member.studyUid !== sample.studyUid || member.seriesUid !== sample.seriesUid || member.sopUid !== sample.sopUid || member.bytes !== original.length || member.sha256 !== createHash('sha256').update(original).digest('hex') || member.frames !== sample.frames || member.rows !== sample.rows || member.columns !== sample.columns || member.role !== 'image' || member.partition !== null || member.originalPath !== memberPath) throw new Error('Portable frozen member does not match its selected original.');
  const download = await fetch(`${base}${memberPath}`,{headers});
  if (download.status !== 200 || download.headers.get('content-type') !== 'application/dicom' || !Buffer.from(await download.arrayBuffer()).equals(original)) throw new Error('Portable frozen-member retrieval changed original encoded bytes.');
  const availability = await checkedJson(await datasetPost(base,cookie,`/${dataset.id}/versions/${version.version}/availability`,{verifyHashes:true}));
  if (!availability.verified || availability.summary.total !== 1 || availability.summary.available !== 1 || availability.summary.missing || availability.summary.changed || availability.summary.unreadable || !availability.items[0]?.verified) throw new Error('Portable dataset could not verify its exact original hash.');
  const consumerPath = '/api/v1/dataset-tools/download_dataset.py', consumer = await fetch(`${base}${consumerPath}`,{headers});
  const packagedConsumer = await readFile(path.join(bundle,'examples/datasets/download_dataset.py'));
  if (consumer.status !== 200 || !Buffer.from(await consumer.arrayBuffer()).equals(packagedConsumer)) throw new Error('Portable authenticated downloader route did not return the actual bundled Python consumer.');
  for (const suffix of ['/api/v1/datasets',`/api/v1/datasets/${dataset.id}`,`/api/v1/datasets/${dataset.id}/readiness`,`/api/v1/datasets/${dataset.id}/versions/${version.version}/manifest`,memberPath,consumerPath]) {
    const publicResponse = await fetch(`${base}${suffix}`);await publicResponse.body?.cancel();
    if (publicResponse.status !== 401) throw new Error('Portable dataset management or original download allowed an unauthenticated request.');
  }
  for (const suffix of ['',`/${dataset.id}/versions`,`/${dataset.id}/versions/${version.version}/availability`]) {
    const publicResponse = await datasetPost(base,null,suffix,{});await publicResponse.body?.cancel();
    if (publicResponse.status !== 401) throw new Error('Portable dataset mutation allowed an unauthenticated request.');
  }
  return {datasetId:dataset.id,version:version.version,snapshotId:version.snapshotId,manifestSha256:sha256,manifestBytes:bytes,memberPath};
}
async function datasetAfterRemoval(base, cookie, snapshot) {
  const dataset = await checkedJson(await fetch(`${base}/api/v1/datasets/${snapshot.datasetId}`,{headers:{Cookie:cookie}}));
  if (dataset.versions.length !== 1 || dataset.versions[0].snapshotId !== snapshot.snapshotId || dataset.versions[0].manifestSha256 !== snapshot.manifestSha256) throw new Error('Portable restart lost the persisted dataset version.');
  const response = await fetch(`${base}/api/v1/datasets/${snapshot.datasetId}/versions/${snapshot.version}/manifest`,{headers:{Cookie:cookie}});
  if (response.status !== 200 || response.headers.get('x-easi-manifest-sha256') !== snapshot.manifestSha256 || !Buffer.from(await response.arrayBuffer()).equals(snapshot.manifestBytes)) throw new Error('Portable removal or restart changed frozen dataset membership or manifest bytes.');
  const availability = await checkedJson(await datasetPost(base,cookie,`/${snapshot.datasetId}/versions/${snapshot.version}/availability`,{verifyHashes:true}));
  if (availability.verified || availability.summary.total !== 1 || availability.summary.missing !== 1 || availability.summary.available || availability.summary.changed || availability.summary.unreadable) throw new Error('Portable frozen version did not explicitly report its removed original.');
  const original = await fetch(`${base}${snapshot.memberPath}`,{headers:{Cookie:cookie}});await original.body?.cancel();
  if (original.status !== 410) throw new Error('Portable frozen member silently substituted or resurrected a removed original.');
}

async function completedJob(base, cookie, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await checkedJson(await fetch(`${base}/api/v1/jobs/${id}`, { headers: { Cookie: cookie } }));
    if (job.state === 'completed') {
      if (job.completed !== 1 || job.total !== 1 || job.failed !== 0) throw new Error('Portable transfer completed with inconsistent checkpoints.');
      return job;
    }
    if (['failed','canceled'].includes(job.state)) throw new Error(`Portable self transfer ended in ${job.state}.`);
    await delay(100);
  }
  throw new Error('Portable self transfer did not complete in time.');
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
  await packagedSupplyChain(bundle, manifest);
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
  const dataDir = path.join(scratch, 'archive & notes !');
  const credentialsFile = path.join(scratch, 'private-peer-credentials.json');
  await writeFile(credentialsFile, '{}', { mode: 0o600 });
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const entry = path.join(bundle, process.platform === 'win32' ? 'Start EASI Store.cmd' : process.platform === 'darwin' ? 'Start EASI Store.command' : 'Start EASI Store.sh');
  await access(entry);
  let output = '';
  const launch = async () => {
    const environment = { ...process.env, PATH: emptyPath, EASI_STORE_DATA_DIR: dataDir, EASI_STORE_PORT: String(port), EASI_STORE_DIMSE: 'off', EASI_STORE_CREDENTIALS_FILE: credentialsFile };
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
  const capabilities = await checkedJson(await fetch(`${base}/api/v1/capabilities`, { headers: { Cookie: cookie } }));
  if (capabilities.version !== manifest.version || capabilities.name !== 'EASI Store' || !capabilities.dicomweb?.frames || !capabilities.dicomweb?.bulkdata || !capabilities.dicomweb?.metadata?.includes('series') || !capabilities.connections?.transferJobs || !capabilities.thumbnails?.managementApi || !capabilities.datasets?.savedSelections || !capabilities.datasets?.immutableVersions || !capabilities.datasets?.sha256Membership) throw new Error('Portable artifact does not advertise the implemented imaging/dataset capabilities and matching version.');
  response = await mutation('demo', {}, cookie);
  if (!response.ok) throw new Error(`Portable synthetic import failed: ${response.status}`);
  response = await fetch(`${base}/api/v1/summary`, { headers: { Cookie: cookie } });
  const demo = await response.json();
  if (!response.ok || demo.instances !== 12) throw new Error('Portable archive did not retain the 12 synthetic instances.');
  // Reuse only this inventory-verified artifact's independent synthetic encoder.
  const { createDicom, uid, element } = await import(pathToFileURL(path.join(bundle, 'src/synthetic.js')));
  const sample = { studyUid: uid(), seriesUid: uid(), sopUid: uid(), rows: 4, columns: 4, frames: 2, frameBytes: 32, nestedBytes: Buffer.from([9,8,7,6]) };
  const original = createDicom(sample);
  sample.pixels = original.subarray(original.length - sample.frameBytes * sample.frames);
  const item = bytes => { const header = Buffer.alloc(8); header.writeUInt16LE(0xFFFE,0); header.writeUInt16LE(0xE000,2); header.writeUInt32LE(bytes.length,4); return Buffer.concat([header,bytes]); };
  const sequence = (tag, items) => element(tag, 'SQ', Buffer.concat(items.map(item)));
  const nested = Buffer.concat([
    sequence('52009229', [sequence('00289110', [element('00280030', 'DS', '0.7\\0.8')])]),
    sequence('52009230', [0,2.5].map(z => sequence('00209113', [element('00200032', 'DS', `0\\0\\${z}`)]))),
    sequence('77771010', [element('77771011', 'OB', sample.nestedBytes)]),
  ]);
  const pixelStart = original.length - sample.pixels.length - 12;
  const enhanced = Buffer.concat([original.subarray(0,pixelStart), nested, original.subarray(pixelStart)]);
  response = await fetch(`${base}/api/v1/instances`, { method: 'POST', headers: { 'Content-Type': 'application/dicom', 'X-EASI-Store': '1', Cookie: cookie }, body: enhanced });
  await checkedJson(response, 201);
  await phase2Dicomweb(base, cookie, sample);
  const datasetSnapshot = await datasetSmoke(base,cookie,sample,enhanced,bundle);
  const mint = async (label, role) => checkedJson(await mutation('auth/tokens', {label,role,expiresInDays:1}, cookie), 201);
  const readerCredential = await mint('Portable reader', 'reader');
  const contributorCredential = await mint('Portable contributor', 'contributor');
  const readerHeaders = {Authorization:`Bearer ${readerCredential.token}`};
  const contributorHeaders = {Authorization:`Bearer ${contributorCredential.token}`};
  const readerSession = await checkedJson(await fetch(`${base}/api/v1/session`, {headers:readerHeaders}));
  if (readerSession.identity?.role !== 'reader' || readerSession.identity?.source !== 'token' || !readerSession.permissions.includes('archive.read') || readerSession.permissions.includes('archive.import')) throw new Error('Portable reader credential has incorrect effective permissions.');
  const readerOriginal = await fetch(`${base}${datasetSnapshot.memberPath}`, {headers:readerHeaders});
  if (readerOriginal.status !== 200 || !Buffer.from(await readerOriginal.arrayBuffer()).equals(enhanced)) throw new Error('Portable reader cannot retrieve its exact frozen original.');
  for (const headers of [readerHeaders,contributorHeaders]) {
    for (const suffix of ['auth/tokens','connections','access-policy','activity']) {
      const denied = await fetch(`${base}/api/v1/${suffix}`, {headers});await denied.body?.cancel();
      if (denied.status !== 403) throw new Error('Portable scoped credential reached privileged management.');
    }
  }
  const readerImport = await fetch(`${base}/api/v1/instances`, {method:'POST',headers:{...readerHeaders,'Content-Type':'application/dicom'},body:enhanced});
  await readerImport.body?.cancel();if (readerImport.status !== 403) throw new Error('Portable reader imported an instance.');
  const contributed = await checkedJson(await fetch(`${base}/api/v1/instances`, {method:'POST',headers:{...contributorHeaders,'Content-Type':'application/dicom'},body:enhanced}));
  if (contributed.status !== 'duplicate') throw new Error('Portable contributor did not retain duplicate-safe import behavior.');
  const before = await checkedJson(await fetch(`${base}/api/v1/summary`, { headers: { Cookie: cookie } }));
  if (before.instances !== 13) throw new Error('Portable Phase 2 synthetic fixture was not indexed.');
  await publicHealth(base, true, manifest.version);
  for (const headers of [undefined,readerHeaders,contributorHeaders]) {
    const health = await fetch(`${base}/api/v1/health`, {headers});await health.body?.cancel();
    if (health.status !== (headers ? 403 : 401)) throw new Error('Portable privileged health details reached an unauthorized client.');
  }
  const initialHealth = await checkedJson(await fetch(`${base}/api/v1/health`, {headers:{Cookie:cookie}}));
  const putHealth = value => fetch(`${base}/api/v1/health/settings`, {method:'PUT',headers:{Cookie:cookie,'X-EASI-Store':'1','Content-Type':'application/json'},body:JSON.stringify(value)});
  const changedSettings = await checkedJson(await putHealth({...initialHealth.settings,maxConcurrentImports:7}));
  if (changedSettings.revision === initialHealth.settings.revision || changedSettings.maxConcurrentImports !== 7) throw new Error('Portable storage settings did not advance the review revision.');
  await checkedJson(await putHealth(initialHealth.settings), 409);
  const startedAudit = await checkedJson(await mutation('health/audits',{verifyHashes:true},cookie),202);
  const verifiedAudit = await completedHealthAudit(base,cookie,startedAudit.id,before.instances,before.bytes);
  await stop();
  // Issue a test-only credential offline, then restart so both authentication
  // and the named peer credential are loaded normally. Never print this token.
  const token = await run(runtime, ['src/cli.js', 'token', '--data-dir', dataDir, '--label', 'Portable smoke self transfer'], { cwd: bundle, sensitiveOutput: true });
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(`Portable offline token issuance returned an invalid credential shape (${token.length} characters, ${token.split('\n').length} lines).`);
  await writeFile(credentialsFile, JSON.stringify({ portableSelf: { bearerToken: token } }), { mode: 0o600 });
  await launch();
  response = await mutation('login', credentials);
  if (!response.ok) throw new Error(`Portable restart login failed: ${response.status}`);
  cookie = response.headers.get('set-cookie')?.split(';')[0];
  response = await fetch(`${base}/api/v1/summary`, { headers: { Cookie: cookie } });
  const after = await response.json();
  if (!response.ok || after.instances !== before.instances || after.bytes !== before.bytes) throw new Error('Portable restart lost catalog state.');
  const persistedReader = await checkedJson(await fetch(`${base}/api/v1/session`, {headers:readerHeaders}));
  if (persistedReader.identity?.role !== 'reader') throw new Error('Portable restart lost credential scope.');
  const persistedHealth = await checkedJson(await fetch(`${base}/api/v1/health`, {headers:{Cookie:cookie}}));
  if (JSON.stringify(persistedHealth.settings) !== JSON.stringify(changedSettings) || JSON.stringify(persistedHealth.latestAudit) !== JSON.stringify(verifiedAudit)) throw new Error('Portable restart lost revisioned storage settings or its durable full-hash report.');
  await completedHealthAudit(base,cookie,verifiedAudit.id,before.instances,before.bytes);
  // Simulate exhausted reserve without consuming disk or modifying any original.
  const reserveBytes = 1024 ** 5;
  if (persistedHealth.storage.availableBytes >= reserveBytes) throw new Error('Portable smoke cannot simulate a low reserve on this filesystem.');
  const lowSettings = await checkedJson(await putHealth({...persistedHealth.settings,reserveBytes,warningBytes:reserveBytes}));
  await publicHealth(base,false,manifest.version);
  const refused = await fetch(`${base}/api/v1/instances`, {method:'POST',headers:{Cookie:cookie,'X-EASI-Store':'1','Content-Type':'application/dicom'},body:createDicom({studyUid:uid(),seriesUid:uid(),sopUid:uid(),rows:4,columns:4})});
  const refusal = await checkedJson(refused,507);
  if (refusal.error?.code !== 'insufficient-storage') throw new Error('Portable capacity refusal did not explain the storage reserve.');
  const whilePaused = await fetch(`${base}${datasetSnapshot.memberPath}`, {headers:readerHeaders});
  if (whilePaused.status !== 200 || !Buffer.from(await whilePaused.arrayBuffer()).equals(enhanced)) throw new Error('Portable low-capacity admission blocked an existing original read.');
  const pausedSummary = await checkedJson(await fetch(`${base}/api/v1/summary`, {headers:{Cookie:cookie}}));
  if (pausedSummary.instances !== before.instances || pausedSummary.bytes !== before.bytes) throw new Error('Portable rejected low-capacity import changed the archive.');
  const restoredSettings = await checkedJson(await putHealth({...initialHealth.settings,revision:lowSettings.revision}));
  if (restoredSettings.reserveBytes !== initialHealth.settings.reserveBytes || restoredSettings.warningBytes !== initialHealth.settings.warningBytes || restoredSettings.maxConcurrentImports !== initialHealth.settings.maxConcurrentImports) throw new Error('Portable storage thresholds were not restored.');
  await publicHealth(base,true,manifest.version);
  await phase2Dicomweb(base, cookie, sample);
  const peer = await checkedJson(await mutation('connections', { name: 'Portable self archive', type: 'dicomweb', baseUrl: `${base}/dicomweb`, credentialId: 'portableSelf', timeoutMs: 5000 }, cookie), 201);
  const connectionTest = await checkedJson(await mutation(`connections/${peer.id}/test`, {}, cookie));
  if (!connectionTest.ok || connectionTest.protocol !== 'QIDO-RS') throw new Error('Portable named credential could not authenticate its configured peer.');
  const jobs = [];
  for (const direction of ['send','retrieve']) {
    const job = await checkedJson(await mutation('jobs', { connectionId: peer.id, direction, selection: { studyUid: sample.studyUid, seriesUid: sample.seriesUid, sopUid: sample.sopUid } }, cookie), 202);
    jobs.push(await completedJob(base, cookie, job.id));
  }
  const renamed = await checkedJson(await fetch(`${base}/api/v1/connections/${peer.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-EASI-Store': '1', Cookie: cookie }, body: JSON.stringify({ name: 'Portable persisted archive', type: 'dicomweb', baseUrl: `${base}/dicomweb`, credentialId: 'portableSelf', timeoutMs: 5000 }) }));
  if (renamed.revision !== peer.revision + 1) throw new Error('Portable peer edit did not update its revision.');
  await stop(); await launch();
  response = await mutation('login', credentials);
  if (!response.ok) throw new Error(`Portable final restart login failed: ${response.status}`);
  cookie = response.headers.get('set-cookie')?.split(';')[0];
  const connections = await checkedJson(await fetch(`${base}/api/v1/connections`, { headers: { Cookie: cookie } }));
  if (!connections.items.some(item => item.id === peer.id && item.name === 'Portable persisted archive' && item.revision === renamed.revision)) throw new Error('Portable restart lost its configured peer.');
  for (const job of jobs) await completedJob(base, cookie, job.id);
  const finalSummary = await checkedJson(await fetch(`${base}/api/v1/summary`, { headers: { Cookie: cookie } }));
  if (finalSummary.instances !== before.instances || finalSummary.bytes !== before.bytes) throw new Error('Portable duplicate-safe self transfers changed original archive counts.');
  await checkedJson(await fetch(`${base}/api/v1/connections/${peer.id}`, { method: 'DELETE', headers: { 'X-EASI-Store': '1', Cookie: cookie } }));
  const removed = await checkedJson(await fetch(`${base}/api/v1/connections`, { headers: { Cookie: cookie } }));
  if (removed.items.some(item => item.id === peer.id)) throw new Error('Portable peer deletion did not remove the selected connection.');
  const initialPolicy = await checkedJson(await fetch(`${base}/api/v1/access-policy`, {headers:{Cookie:cookie}}));
  const setProfile = async profile => checkedJson(await fetch(`${base}/api/v1/access-policy`, {method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json','X-EASI-Store':'1'},body:JSON.stringify({...initialPolicy,profile})}));
  await setProfile('local-research');
  const researchReaderWrite = await fetch(`${base}/dicomweb/studies`, {method:'POST',headers:readerHeaders,body:''});await researchReaderWrite.body?.cancel();
  if (researchReaderWrite.status !== 403) throw new Error('Portable research mode escalated a reader credential.');
  if ((await fetch(`${base}/dicomweb/studies`)).status !== 200 || (await fetch(`${base}/api/v1/summary`)).status !== 401) throw new Error('Research mode did not separate client and administration access.');
  await stop(); await launch();
  const accessDescription = await checkedJson(await fetch(`${base}/api/v1/access`));
  if (accessDescription.profile !== 'local-research' || accessDescription.dicomwebAuthenticationRequired !== false || (await fetch(`${base}/dicomweb/studies`)).status !== 200) throw new Error('Portable research mode did not persist without a browser session.');
  response = await mutation('login',credentials); if (!response.ok) throw new Error('Portable administrator could not reauthenticate.');cookie=response.headers.get('set-cookie')?.split(';')[0];
  await setProfile('authenticated');
  if ((await fetch(`${base}/dicomweb/studies`)).status !== 401) throw new Error('Returning to authenticated mode did not protect subsequent client requests.');
  const studyPath = `${base}/api/v1/studies/${sample.studyUid}`;
  const exported = await fetch(studyPath + '/export', {headers:{Cookie:cookie}});
  if (exported.status !== 200 || exported.headers.get('content-type') !== 'application/zip') throw new Error('Portable original study ZIP export failed.');
  const zip = readZip(Buffer.from(await exported.arrayBuffer())), inventory = JSON.parse(zip.entries.get('manifest.json').data);
  if (inventory.instanceCount !== 1 || inventory.anonymized !== false || inventory.productVersion !== manifest.version) throw new Error('Portable export manifest has incorrect scope/version.');
  const exportedEntry = inventory.instances[0];
  if (exportedEntry.sopUid !== sample.sopUid || exportedEntry.bytes !== enhanced.length || exportedEntry.sha256 !== createHash('sha256').update(enhanced).digest('hex') || !zip.entries.get(exportedEntry.path).data.equals(enhanced)) throw new Error('Portable export changed original bytes or hashes.');
  for (const suffix of ['/export','/deletion-preview']) if ((await fetch(studyPath + suffix)).status !== 401) throw new Error('Portable study management allowed an unauthenticated request.');
  const preview = await checkedJson(await fetch(studyPath + '/deletion-preview',{headers:{Cookie:cookie}}));
  if (preview.instanceCount !== 1 || preview.seriesCount !== 1 || preview.bytes !== enhanced.length) throw new Error('Portable removal preview is incorrect.');
  const removeStudy = confirmation => fetch(studyPath,{method:'DELETE',headers:{Cookie:cookie,'X-EASI-Store':'1','Content-Type':'application/json'},body:JSON.stringify({confirmation,revision:preview.revision})});
  if ((await removeStudy('delete')).status !== 400) throw new Error('Portable removal accepted an invalid confirmation.');
  const removal = await checkedJson(await removeStudy('DELETE'));
  if (!removal.deleted || removal.reclamationPending || removal.reclaimedBytes !== enhanced.length) throw new Error('Portable removal did not reclaim the selected original.');
  await datasetAfterRemoval(base,cookie,datasetSnapshot);
  await stop(); await launch();
  response = await mutation('login',credentials); if (!response.ok) throw new Error('Portable post-removal login failed.');cookie=response.headers.get('set-cookie')?.split(';')[0];
  const cleaned = await checkedJson(await fetch(`${base}/api/v1/summary`,{headers:{Cookie:cookie}}));
  if (cleaned.instances !== demo.instances || cleaned.bytes !== demo.bytes) throw new Error('Portable removal changed unselected studies or did not persist.');
  await datasetAfterRemoval(base,cookie,datasetSnapshot);
  const records = await checkedJson(await fetch(`${base}/api/v1/activity`,{headers:{Cookie:cookie}}));
  if (!records.items.some(item=>item.outcome==='study-deleted')) throw new Error('Portable removal did not leave a persisted activity record.');
  const shards = await readdir(path.join(dataDir,'objects'),{withFileTypes:true});let originalsOnDisk=0;
  for (const shard of shards.filter(item=>item.isDirectory())) originalsOnDisk+=(await readdir(path.join(dataDir,'objects',shard.name))).filter(name=>name.endsWith('.dcm')).length;
  if (originalsOnDisk !== demo.instances) throw new Error('Portable removal left the selected original on disk.');
  await checkedJson(await fetch(`${base}/api/v1/auth/tokens/${readerCredential.credential.id}`, {method:'DELETE',headers:{Cookie:cookie,'X-EASI-Store':'1'}}));
  const revoked = await fetch(`${base}/api/v1/summary`, {headers:readerHeaders});await revoked.body?.cancel();
  if (revoked.status !== 401) throw new Error('Portable revoked reader remained authorized.');
  await checkedJson(await fetch(`${base}/api/v1/datasets/${datasetSnapshot.datasetId}`, {headers:contributorHeaders}));
  const accessActivity = await checkedJson(await fetch(`${base}/api/v1/auth/activity`, {headers:{Cookie:cookie}}));
  if (!accessActivity.items.some(item=>item.actor?.source==='token' && item.actor.displayName==='Portable contributor')) throw new Error('Portable access activity lost individual credential attribution.');
  await stop();
  const schema = await run(runtime, ['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(db.prepare('PRAGMA user_version').get().user_version);db.close();",path.join(dataDir,'catalog.sqlite')]);
  if (schema !== '3') throw new Error('Portable archive lacks the security downgrade fence.');
  const verificationPath = path.join(scratch,'offline-integrity-report.json');
  const offlineAudit = JSON.parse(await run(runtime,['src/cli.js','verify','--data-dir',dataDir,'--output',verificationPath],{cwd:bundle}));
  if (offlineAudit.status !== 'completed' || offlineAudit.verifyHashes !== true || offlineAudit.progress.indexed !== cleaned.instances || offlineAudit.progress.bytes !== cleaned.bytes || Object.values(offlineAudit.counts).some(value => value !== 0) || offlineAudit.findings.length || offlineAudit.findingsTruncated || JSON.stringify(JSON.parse(await readFile(verificationPath,'utf8'))) !== JSON.stringify(offlineAudit) || JSON.stringify(JSON.parse(await readFile(path.join(dataDir,'health-audit.json'),'utf8'))) !== JSON.stringify(offlineAudit)) throw new Error('Portable offline verification did not hash all remaining originals and persist the exact report.');
  console.log(JSON.stringify({ artifact: archivePath, sha256: await digest(archivePath), target, runtime: runtimeVersion, version: manifest.version, inventoryFilesVerified: manifest.files.length, systemNodeAvailableToLauncher: false, setup: 'passed', syntheticDemoInstances: demo.instances, syntheticInstances: finalSummary.instances, retainedAfterRemoval:cleaned.instances, originalStudyZipAndManifest:'passed', confirmedRemovalAndDiskReclamation:'passed', removalRestartPersistence:'passed', restartPersistence: 'passed', dicomweb: { query: 'passed', nestedMetadata: 'passed', pixelAndNestedBulk: 'passed', exactNativeFrames: 'passed', protectedRoutes: 'passed', trustedPublicPrefix: 'passed' }, datasets:{explicitSelectionAndReadiness:'passed',immutableManifestAndSha256:'passed',exactFrozenOriginal:'passed',hashAvailability:'passed',protectedManagementAndDownloads:'passed',bundledPythonConsumerDownload:'passed',removedOriginalReportedMissing:'passed',noOriginalRetentionPinning:'passed',unchangedManifestAndRestartPersistence:'passed'}, identity:{scopedTokenRoles:'passed',readerOriginalAccess:'passed',contributorDuplicateImport:'passed',protectedManagement:'passed',credentialScopeRestart:'passed',researchNonEscalation:'passed',immediateRevocation:'passed',principalAttribution:'passed',securitySchemaFence:'passed'}, health:{livenessReadinessSeparation:'passed',protectedAdministration:'passed',revisionedSettings:'passed',settingsRestartPersistence:'passed',fullHashAudit:'passed',persistedAuditReport:'passed',lowSpaceIntakeRefusal:'passed',originalReadsWhilePaused:'passed',thresholdRestore:'passed',offlineVerification:'passed'}, supplyChain:{completeInventory:'passed',cycloneDxReleaseAndDependencies:'passed',securityGuidance:'passed',packageManagersOmitted:'passed'}, thumbnails: 'passed', configuredPeerCrudAndPersistence: 'passed', duplicateSafeStowSend: 'passed', duplicateSafeWadoRetrieve: 'passed', transferCheckpointPersistence: 'passed', explicitResearchAccessAndPersistence: 'passed', protectedAdministration: 'passed', authenticatedModeRestored: 'passed' }, null, 2));
} finally {
  await stop();
  await rm(scratch, { recursive: true, force: true });
}
