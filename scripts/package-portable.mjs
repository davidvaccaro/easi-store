#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);

export function parseOptions(args) {
  const options = { target: `${process.platform}-${process.arch}`, bundleRuntime: false, nodeVersion: '24.22.1', output: path.join(projectRoot, 'artifacts') };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--bundle-runtime') options.bundleRuntime = true;
    else if (key === '--target' || key === '--node-version' || key === '--output') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
      if (key === '--target') options.target = value;
      else if (key === '--node-version') options.nodeVersion = value.replace(/^v/, '');
      else options.output = path.resolve(value);
    } else if (key === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!targets.has(options.target)) throw new Error(`Unsupported target ${options.target}; choose ${[...targets].join(', ')}.`);
  if (!/^24\.\d+\.\d+$/.test(options.nodeVersion)) throw new Error('Portable runtime version must be an exact Node.js 24 release, for example 24.6.0.');
  return options;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal || code}).`)));
  });
}

async function exists(location) { try { await access(location); return true; } catch { return false; } }

async function sha256(location) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(location)) hash.update(chunk);
  return hash.digest('hex');
}

async function createSbom(directory, manifest) {
  const arguments_ = ['sbom', '--package-lock-only', '--omit=dev', '--sbom-format=cyclonedx'];
  const npmScript = process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : null;
  const command = npmScript ? process.execPath : process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = npmScript ? [npmScript, ...arguments_] : process.platform === 'win32' ? ['/d', '/s', '/c', 'npm sbom --package-lock-only --omit=dev --sbom-format=cyclonedx'] : arguments_;
  const output = await new Promise((resolve, reject) => {
    let content = '', failed = false;
    const child = spawn(command, args, { cwd: directory, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    child.stdout.on('data', bytes => {
      content += bytes.toString('utf8');
      if (content.length > 16 * 1024 * 1024 && !failed) { failed = true; child.kill(); reject(new Error('Runtime dependency inventory exceeded its limit.')); }
    });
    child.once('error', reject);
    child.once('close', code => { if (!failed) code === 0 ? resolve(content) : reject(new Error('Runtime dependency inventory generation failed.')); });
  });
  const document = JSON.parse(output);
  if (document.bomFormat !== 'CycloneDX' || document.metadata?.component?.['bom-ref'] !== `${manifest.name}@${manifest.version}` || document.metadata?.component?.version !== manifest.version) throw new Error('Runtime dependency inventory does not identify this release.');
  // npm uses the physical directory name for the root component. Identify the
  // packaged application instead while preserving its package ref/dependency graph.
  document.metadata.component.name = manifest.name.split('/').at(-1);
  if (manifest.name.startsWith('@')) document.metadata.component.group = manifest.name.split('/')[0];
  document.metadata.component.type = 'application';
  await writeFile(path.join(directory, 'SBOM.cdx.json'), JSON.stringify(document, null, 2) + '\n');
}

export function checksumFor(manifest, filename) {
  const line = manifest.split(/\r?\n/).find(item => item.trim().split(/\s+/).at(-1)?.replace(/^\*/, '') === filename);
  const checksum = line?.split(/\s+/)[0];
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`Official Node.js checksum not found for ${filename}.`);
  return checksum;
}

async function download(url, destination, maxBytes) {
  // Only exact HTTPS files from the Node.js release host are accepted.
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'nodejs.org') throw new Error('Runtime downloads must use https://nodejs.org.');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Node.js download failed: ${response.status} ${url}`);
  let received = 0;
  const bounded = async function* (source) {
    for await (const chunk of source) {
      received += chunk.length;
      if (received > maxBytes) throw new Error(`Runtime download exceeded ${maxBytes} bytes.`);
      yield chunk;
    }
  };
  await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
}

async function installRuntime(options, bundle, scratch) {
  const [platform, architecture] = options.target.split('-');
  const nodePlatform = platform === 'win32' ? 'win' : platform;
  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  const directory = `node-v${options.nodeVersion}-${nodePlatform}-${architecture}`;
  const filename = `${directory}.${extension}`;
  const releaseBase = `https://nodejs.org/dist/v${options.nodeVersion}`;
  const manifestPath = path.join(scratch, 'SHASUMS256.txt');
  const downloadPath = path.join(scratch, filename);
  await download(`${releaseBase}/SHASUMS256.txt`, manifestPath, 128 * 1024);
  const expected = checksumFor(await readFile(manifestPath, 'utf8'), filename);
  await download(`${releaseBase}/${filename}`, downloadPath, 200 * 1024 * 1024);
  const actual = await sha256(downloadPath);
  if (actual !== expected) throw new Error(`Node.js runtime SHA-256 mismatch for ${filename}; refusing to package it.`);
  if (platform === 'win32' && process.platform !== 'win32') await run('unzip', ['-q', downloadPath, '-d', scratch], scratch);
  else await run('tar', ['-xf', downloadPath, '-C', scratch], scratch);
  const runtime = path.join(bundle, 'runtime');
  await mkdir(runtime);
  // Retain the verified runtime and its licenses; unused package-manager tools
  // are not needed by the complete application bundle and add patch surface.
  await cp(path.join(scratch, directory), runtime, { recursive: true, verbatimSymlinks: true });
  for (const relative of ['lib/node_modules/npm', 'lib/node_modules/corepack', 'node_modules/npm', 'node_modules/corepack',
    'bin/npm', 'bin/npx', 'bin/corepack', 'npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1', 'corepack', 'corepack.cmd', 'corepack.ps1']) {
    await rm(path.join(runtime, relative), { recursive: true, force: true });
  }
  await cp(manifestPath, path.join(runtime, 'SHASUMS256.txt'));
  return { version: options.nodeVersion, target: options.target, source: `${releaseBase}/${filename}`, sha256: actual,
    packageManagersIncluded: false, verification: 'Official distribution SHA-256 verified before omitting unused npm/npx/corepack tools; final files inventoried; release signature not verified' };
}

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(location, relative));
    else if (entry.isFile()) files.push({ path: relative, bytes: (await stat(location)).size, sha256: await sha256(location) });
    // npm's command shims and the Node distribution's own symlinks remain intact.
  }
  return files;
}

async function createArchive(bundle, archivePath, target) {
  const parent = path.dirname(bundle);
  const name = path.basename(bundle);
  if (!target.startsWith('win32-')) return run('tar', ['-czf', archivePath, '-C', parent, name], parent);
  if (process.platform !== 'win32') return run('zip', ['-qr', archivePath, name], parent);
  // EncodedCommand prevents command interpretation of paths containing spaces.
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(parent)}, ${quote(archivePath)}, [System.IO.Compression.CompressionLevel]::Optimal, $false)`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], parent);
}

export async function packagePortable(options) {
  await access(path.join(projectRoot, 'dist', 'public', 'index.html')).catch(() => { throw new Error('Run npm ci and npm run build before packaging.'); });
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('Package version is not safe for artifact naming.');
  await mkdir(options.output, { recursive: true });
  const scratch = await mkdtemp(path.join(tmpdir(), 'easi-store-package-'));
  try {
    const packageName = `easi-store-${manifest.version}-${options.target}${options.bundleRuntime ? '' : '-requires-node24'}`;
    const staging = path.join(scratch, 'staging');
    const bundle = path.join(staging, packageName);
    await mkdir(bundle, { recursive: true });
    for (const filename of ['src', 'dist', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'SECURITY.md', 'licenses', 'README.md', 'CHANGELOG.md', 'docs', 'examples']) {
      const source = path.join(projectRoot, filename);
      if (!await exists(source)) throw new Error(`Required release input is missing: ${filename}`);
      await cp(source, path.join(bundle, filename), { recursive: true,
        filter: file => !file.split(path.sep).some(part => part === '__pycache__' || part.startsWith('.venv')) && !/\.py[cod]$/.test(file) });
    }
    await mkdir(path.join(bundle, 'scripts'));
    for (const filename of ['launch-macos.command', 'launch-linux.sh', 'launch-windows.cmd']) {
      await cp(path.join(projectRoot, 'scripts', filename), path.join(bundle, 'scripts', filename));
      if (!filename.endsWith('.cmd')) await chmod(path.join(bundle, 'scripts', filename), 0o755);
    }
    const npmArguments = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
    // Install from the locked package graph in a clean directory; never copy the
    // developer's node_modules or any archive directory into a release.
    if (process.env.npm_execpath?.endsWith('npm-cli.js')) await run(process.execPath, [process.env.npm_execpath, ...npmArguments], bundle);
    else if (process.platform === 'win32') await run('cmd.exe', ['/d', '/s', '/c', 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund'], bundle);
    else await run('npm', npmArguments, bundle);
    await createSbom(bundle, manifest);
    const dependencies = await inventory(path.join(bundle, 'node_modules'));
    if (options.target !== `${process.platform}-${process.arch}` && dependencies.some(item => item.path.endsWith('.node'))) {
      throw new Error('Native npm dependencies require packaging on the target platform; cross-target artifact refused.');
    }
    const runtime = options.bundleRuntime ? await installRuntime(options, bundle, scratch) : null;
    const launcher = options.target.startsWith('darwin-') ? 'launch-macos.command' : options.target.startsWith('win32-') ? 'launch-windows.cmd' : 'launch-linux.sh';
    // Keep the launcher in scripts (its relative paths are fixed), and add a
    // small root entry point so the first action is obvious after extraction.
    if (launcher.endsWith('.cmd')) await writeFile(path.join(bundle, 'Start EASI Store.cmd'), '@echo off\r\nsetlocal DisableDelayedExpansion\r\ncall "%~dp0scripts\\launch-windows.cmd"\r\n');
    else {
      const entry = options.target.startsWith('darwin-') ? 'Start EASI Store.command' : 'Start EASI Store.sh';
      await writeFile(path.join(bundle, entry), `#!/bin/sh\nexec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/scripts/${launcher}" "$@"\n`, { mode: 0o755 });
    }
    const files = await inventory(bundle);
    await writeFile(path.join(bundle, 'ARTIFACT.json'), `${JSON.stringify({ name: manifest.name, version: manifest.version, target: options.target, runtime, createdAt: new Date().toISOString(), files }, null, 2)}\n`);
    const extension = options.target.startsWith('win32-') ? 'zip' : 'tar.gz';
    const archivePath = path.join(options.output, `${packageName}.${extension}`);
    if (await exists(archivePath)) throw new Error(`Artifact already exists: ${archivePath}. Choose a new output directory to avoid replacing release evidence.`);
    await createArchive(bundle, archivePath, options.target);
    const checksum = await sha256(archivePath);
    await writeFile(`${archivePath}.sha256`, `${checksum}  ${path.basename(archivePath)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ artifact: archivePath, sha256: checksum, bundledRuntime: Boolean(runtime), target: options.target }, null, 2));
    return archivePath;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log('Usage: npm run artifact:pack -- [--bundle-runtime] [--target darwin-arm64|darwin-x64|linux-arm64|linux-x64|win32-arm64|win32-x64] [--node-version 24.x.y] [--output DIRECTORY]');
    else await packagePortable(options);
  } catch (error) { console.error(`Packaging failed: ${error.message}`); process.exitCode = 1; }
}
