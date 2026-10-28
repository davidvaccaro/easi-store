#!/usr/bin/env node
// Run only against a trusted EASI Store image. All data and credentials below
// are independently generated, disposable fixtures; no user archive is opened.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDicom } from '../src/synthetic.js';

const args = process.argv.slice(2), image = args.shift();
let platform, reportPath, diskFull = false;
while (args.length) {
  const flag = args.shift();
  if (flag === '--platform') platform = args.shift();
  else if (flag === '--report') reportPath = args.shift();
  else if (flag === '--disk-full') diskFull = true;
  else throw new Error('Usage: node scripts/qualify-container.mjs IMAGE [--platform linux/amd64|linux/arm64] [--report PATH] [--disk-full]');
}
if (!image || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(image) || platform && !['linux/amd64','linux/arm64'].includes(platform)
  || reportPath !== undefined && !reportPath) throw new Error('Choose a trusted image, optional Linux platform and report path.');
const unique = randomBytes(8).toString('hex'), container = `easi-store-qualification-${unique}`, volume = `${container}-data`;
const constrained = `${container}-capacity`, ownedContainers = new Set(), ownedVolumes = new Set();
const report = { passed:false,syntheticOnly:true,userArchiveAccessed:false,externalProvidersUsed:false,checks:[],cleanup:{containersRemoved:false,volumesRemoved:false} };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let stage = 'prepare', failure;
function run(command,args,{timeout=120000,sensitive=false}={}) {
  return new Promise((resolve,reject) => {
    const child = spawn(command,args,{stdio:['ignore','pipe','pipe']});
    let output = '', errors = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); },timeout);
    child.stdout.on('data',bytes => { output += bytes; if (output.length > 2*1024*1024) { killed = true; child.kill('SIGKILL'); } });
    child.stderr.on('data',bytes => { errors += bytes; if (errors.length > 2*1024*1024) { killed = true; child.kill('SIGKILL'); } });
    child.once('error',error => { clearTimeout(timer); reject(error); });
    child.once('close',code => { clearTimeout(timer); if (code === 0 && !killed) resolve(output.trim()); else reject(new Error(`${command} operation failed${sensitive ? '' : ` (${code ?? 'stopped'})`}.`)); });
  });
}
const docker = (args,options) => run('docker',args,options);
const js = (name,code) => docker(['exec',name,'node','--input-type=module','-e',code],{sensitive:true});
const checked = (condition,message) => { if (!condition) throw Object.assign(new Error(message),{qualificationReason:message}); };
function pass(name,facts={}) { report.checks.push({name,passed:true,...facts}); }
async function inspect(name) { return JSON.parse(await docker(['inspect',name]))[0]; }
async function endpoint(name) {
  const metadata = await inspect(name), bindings = metadata.NetworkSettings.Ports['8048/tcp'];
  checked(bindings?.length === 1 && bindings[0].HostIp === '127.0.0.1','Qualification port was not confined to loopback.');
  return `http://127.0.0.1:${bindings[0].HostPort}`;
}
async function waitForServer(base) {
  for (let attempt=0;attempt<200;attempt++) {
    try { const response = await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)}); await response.body?.cancel(); if (response.status === 200) return; } catch {}
    await delay(100);
  }
  throw new Error('The disposable Store did not start.');
}
function client(base) {
  let cookie;
  const api = async (route,{method='GET',body,bytes,token,authenticated=true}={}) => fetch(base+route,{
    method,signal:AbortSignal.timeout(30000),redirect:'error',
    headers:{ Connection:'close',...(authenticated && (token || cookie) ? token ? {Authorization:`Bearer ${token}`} : {Cookie:cookie} : {}),
      ...(method === 'GET' ? {} : {'X-EASI-Store':'1','Content-Type':bytes ? 'application/dicom' : 'application/json'}) },
    ...(method === 'GET' ? {} : {body:bytes ?? JSON.stringify(body ?? {})})
  });
  const json = async (route,options={},expected=200) => {
    const response = await api(route,options);
    if (response.status !== expected) { await response.body?.cancel(); throw Object.assign(new Error('Unexpected qualification HTTP status.'),{qualificationReason:`Expected HTTP ${expected}, received ${response.status} at ${route.split('/').slice(0,5).join('/')}.`}); }
    return response.json();
  };
  const status = async (route,options,expected) => {
    const response = await api(route,options); await response.body?.cancel(); checked(response.status === expected,`Qualification expected HTTP ${expected}, received ${response.status} at a protected route.`);
  };
  const signIn = async (route,credentials) => {
    const response = await api(route,{method:'POST',authenticated:false,body:credentials});
    checked(response.status === 200,'Synthetic sign-in failed.');
    cookie = response.headers.get('set-cookie')?.split(';')[0]; await response.body?.cancel(); checked(Boolean(cookie),'Synthetic sign-in did not return a session.');
  };
  return {api,json,status,signIn};
}
async function setup(name,api) {
  const bootstrapToken = await js(name,"import{readFile}from'node:fs/promises';process.stdout.write((await readFile('/data/bootstrap-token','utf8')).trim())");
  const credentials = {username:'generated-qualification-admin',password:randomBytes(32).toString('base64url')};
  await api.signIn('/api/v1/setup',{...credentials,bootstrapToken}); return credentials;
}
async function audit(api) {
  let result = await api.json('/api/v1/health/audits',{method:'POST',body:{verifyHashes:true}},202);
  for (let attempt=0;result.status === 'running' && attempt<600;attempt++) { await delay(50); result = await api.json('/api/v1/health/audits/'+result.id); }
  checked(result.status === 'completed','The read-only integrity review did not complete.');
  checked(Object.values(result.counts).every(count => count === 0),'Synthetic originals failed integrity review.'); return result;
}
async function original(api,instance,bytes,token) {
  const response = await api.api(`/api/v1/download/${instance.studyUid}/${instance.seriesUid}/${instance.sopUid}`,{token});
  checked(response.status === 200,'An acknowledged original could not be read.');
  checked(sha(Buffer.from(await response.arrayBuffer())) === sha(bytes),'An acknowledged original changed encoded bytes.');
}
async function createContainer(name,{tmpfs=false}={}) {
  ownedContainers.add(name);
  const mounts = tmpfs ? ['--tmpfs','/data:rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700'] : ['--mount',`type=volume,src=${volume},dst=/data`];
  if (!tmpfs) { ownedVolumes.add(volume); await docker(['volume','create',volume]); }
  await docker(['run','--detach','--name',name,...(platform ? ['--platform',platform] : []),'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
    '--tmpfs','/tmp:rw,noexec,nosuid,size=16m',...mounts,'--publish','127.0.0.1::8048','--env','EASI_STORE_DIMSE=off',
    ...(tmpfs ? ['--entrypoint','node'] : []),image,...(tmpfs ? ['-e','setInterval(()=>{},1000)'] : [])]);
  const metadata = await inspect(name);
  checked(metadata.HostConfig.ReadonlyRootfs === true && metadata.Config.User === 'easi:easi','Container privilege defaults changed.');
  assert.deepEqual(metadata.HostConfig.CapDrop,['ALL']); assert.deepEqual(Object.keys(metadata.HostConfig.PortBindings),['8048/tcp']);
  checked(metadata.HostConfig.SecurityOpt.includes('no-new-privileges:true'),'Container privilege escalation was allowed.');
  const environment = JSON.parse(await js(name,"import{spawnSync}from'node:child_process';console.log(JSON.stringify({uid:process.getuid(),python:spawnSync('python3',['--version']).error?.code??'present',packageManagers:Object.fromEntries(['npm','npx','yarn','corepack'].map(name=>[name,spawnSync(name,['--version']).error?.code??'present'])),runtime:process.version}))"));
  checked(environment.uid === 10001 && environment.python === 'ENOENT' && Object.values(environment.packageManagers).every(value=>value==='ENOENT'),'Runtime was not nonroot and Node-only without package managers.'); return environment;
}
async function startStoreProcess(name) {
  return Number(await js(name,"import{openSync,closeSync,writeFileSync}from'node:fs';import{spawn}from'node:child_process';const log=openSync('/tmp/qualification-store.log','a',0o600);const child=spawn(process.execPath,['src/cli.js','start','--host','0.0.0.0','--port','8048','--data-dir','/data','--no-dimse'],{stdio:['ignore',log,log],detached:true});closeSync(log);writeFileSync('/tmp/qualification-store.pid',String(child.pid),{mode:0o600});child.unref();console.log(child.pid)"));
}
async function stopStoreProcess(name,pid) {
  await js(name,`process.kill(${pid},'SIGTERM')`);
  for (let attempt=0;attempt<200;attempt++) {
    const alive = await js(name,`import{readFile}from'node:fs/promises';let alive=false;try{const value=await readFile('/proc/${pid}/stat','utf8');alive=value.slice(value.lastIndexOf(')')+2).split(' ')[0]!=='Z'}catch{}console.log(alive)`);
    if (alive === 'false') return; await delay(50);
  }
  throw new Error('The disposable Store process did not close.');
}
async function runtimeInventory(name) {
  return JSON.parse(await js(name,"import{readFile,readdir,stat}from'node:fs/promises';import{createHash}from'node:crypto';const roots=['src','examples','dist','licenses','package.json','package-lock.json','LICENSE','NOTICE','SECURITY.md'];async function walk(prefix){const file='/app/'+prefix,info=await stat(file);if(info.isFile())return[{path:prefix,bytes:info.size,sha256:createHash('sha256').update(await readFile(file)).digest('hex')}];const result=[];for(const item of await readdir(file,{withFileTypes:true})){if(!item.isFile()&&!item.isDirectory())throw Error('unexpected runtime link');result.push(...await walk(prefix+'/'+item.name));}return result;}console.log(JSON.stringify((await Promise.all(roots.map(walk))).flat().sort((a,b)=>a.path.localeCompare(b.path))))"));
}
try {
  stage = 'production-container'; const runtime = await createContainer(container), base = await endpoint(container); await waitForServer(base);
  const api = client(base), credentials = await setup(container,api);
  const version = (await api.json('/api/health',{authenticated:false})).version;
  const imageInfo = JSON.parse(await docker(['image','inspect',image]))[0], inventory = await runtimeInventory(container);
  report.image = {id:imageInfo.Id,architecture:imageInfo.Architecture,os:imageInfo.Os,runtime:runtime.runtime,version};
  report.payload = {files:inventory.length,sha256:sha(JSON.stringify(inventory))};
  pass('nonroot-readonly-node-only-private-volume',{uid:runtime.uid,publishedPorts:['HTTP loopback only']});
  await api.status('/api/v1/health',{authenticated:false},401);
  const reader = await api.json('/api/v1/auth/tokens',{method:'POST',body:{label:'Generated reader',role:'reader',expiresInDays:1}},201);
  const retainedReader = await api.json('/api/v1/auth/tokens',{method:'POST',body:{label:'Generated retained reader',role:'reader',expiresInDays:1}},201);
  await api.status('/api/v1/health',{token:reader.token},403); await api.status('/api/v1/health/settings',{token:reader.token,method:'PUT',body:{}},403);
  await api.status('/api/v1/health/audits',{token:reader.token,method:'POST',body:{}},403);
  pass('administrator-only-health-and-reader-boundary');
  const bytes = createDicom({rows:32,columns:48,frames:2}), imported = await api.json('/api/v1/instances',{method:'POST',bytes},201);
  await original(api,imported.instance,bytes,reader.token);
  pass('durable-import-and-exact-original',{bytes:bytes.length,sha256:sha(bytes)});
  stage = 'capacity-policy'; const before = await api.json('/api/v1/health');
  checked(before.ready && before.sqlite.status === 'ok' && Number.isSafeInteger(before.storage.availableBytes),'Initial archive readiness was not valid.');
  const low = Math.min(1024**5,before.storage.availableBytes+1024**3);
  const lowered = await api.json('/api/v1/health/settings',{method:'PUT',body:{...before.settings,reserveBytes:low,warningBytes:low}},200);
  checked((await api.json('/api/ready',{authenticated:false},503)).ready === false,'Low capacity did not affect readiness.');
  await api.status('/api/health',{authenticated:false},200);
  await api.status('/api/v1/instances',{method:'POST',bytes:createDicom()},507);
  await original(api,imported.instance,bytes,reader.token);
  const configured = await api.json('/api/v1/health/settings',{method:'PUT',body:{...lowered,reserveBytes:64*1024**2,warningBytes:128*1024**2,maxConcurrentImports:3}},200);
  checked((await api.json('/api/ready',{authenticated:false})).ready === true,'Restored capacity did not restore readiness.');
  pass('reserve-refuses-import-with-507-liveness-and-originals-retained');
  stage = 'read-only-integrity'; const review = await audit(api);
  checked(review.progress.indexed === 1 && review.progress.bytes === bytes.length,'Integrity review did not hash the exact indexed original.');
  pass('bounded-read-only-original-integrity-review',{indexed:review.progress.indexed,bytes:review.progress.bytes});
  await api.json('/api/v1/auth/tokens/'+reader.credential.id,{method:'DELETE'});
  await api.status('/api/v1/summary',{token:reader.token},401);
  stage = 'durable-restart'; await docker(['restart',container]); await waitForServer(await endpoint(container));
  const restarted = client(await endpoint(container)); await restarted.signIn('/api/v1/login',credentials);
  const after = await restarted.json('/api/v1/health'); assert.deepEqual(after.settings,configured);
  checked(after.latestAudit?.id === review.id && after.latestAudit.status === 'completed','Restart lost the completed integrity review.');
  await restarted.status('/api/v1/summary',{token:reader.token},401);
  checked((await restarted.json('/api/v1/session',{token:retainedReader.token})).identity?.role === 'reader','Restart changed a retained credential role.');
  await restarted.status('/api/v1/health',{token:retainedReader.token},403); await original(restarted,imported.instance,bytes,retainedReader.token);
  pass('restart-preserves-settings-review-originals-token-scope-and-revocation');
  if (diskFull) {
    stage = 'constrained-filesystem'; await createContainer(constrained,{tmpfs:true}); let pid = await startStoreProcess(constrained);
    stage = 'constrained-startup'; const tinyBase = await endpoint(constrained); await waitForServer(tinyBase); const tiny = client(tinyBase), tinyCredentials = await setup(constrained,tiny);
    const initial = await tiny.json('/api/v1/health');
    await tiny.json('/api/v1/health/settings',{method:'PUT',body:{...initial.settings,reserveBytes:0,warningBytes:0,maxConcurrentImports:1}});
    stage = 'constrained-intake'; const retained = [], studyUid = imported.instance.studyUid;
    let refused = false;
    for (let index=0;index<96;index++) {
      const originalBytes = createDicom({studyUid,rows:512,columns:512,frames:2,instanceNumber:index+1});
      const response = await tiny.api('/api/v1/instances',{method:'POST',bytes:originalBytes});
      if (response.status === 507) { await response.body?.cancel(); refused = true; break; }
      checked(response.status === 201,'Constrained intake did not store durably or refuse with507.');
      const item = await response.json(); retained.push({instance:item.instance,bytes:originalBytes});
    }
    checked(refused && retained.length > 0,'Constrained live capacity admission did not reach its reserve.');
    await original(tiny,retained[0].instance,retained[0].bytes);
    stage = 'constrained-os-full'; const full = JSON.parse(await js(constrained,"import{open}from'node:fs/promises';const handle=await open('/data/qualification-filler','wx',0o600);let written=0,code;try{const bytes=Buffer.alloc(256*1024);while(written<80*1024*1024){await handle.writeFile(bytes);written+=bytes.length}}catch(error){code=error.code}finally{await handle.close()}console.log(JSON.stringify({code,written}))"));
    checked(full.code === 'ENOSPC','Bounded tmpfs filler did not hit actual filesystem ENOSPC.');
    stage = 'constrained-full-readiness';
    checked((await tiny.json('/api/ready',{authenticated:false},503)).ready === false,'Actual full filesystem did not stop readiness.');
    stage = 'constrained-full-liveness'; await tiny.status('/api/health',{authenticated:false},200);
    stage = 'constrained-full-import';
    const denied = await tiny.api('/api/v1/instances',{method:'POST',bytes:createDicom()}); await denied.body?.cancel();
    checked([503,507].includes(denied.status),`An actual-full-filesystem import returned HTTP ${denied.status}; expected a controlled503/507.`);
    const fault = {type:'external-enospc',filesystem:'tmpfs',readinessStatus:503,livenessStatus:200,refusalStatus:denied.status};
    await js(constrained,"import{rm}from'node:fs/promises';await rm('/data/qualification-filler')");
    const beforeRestart = await tiny.json('/api/v1/summary'); checked(beforeRestart.instances === retained.length,'A refused instance appeared in the catalog.');
    await original(tiny,retained[0].instance,retained[0].bytes);
    stage = 'constrained-process-restart'; await stopStoreProcess(constrained,pid); pid = await startStoreProcess(constrained); await waitForServer(tinyBase);
    const resumed = client(tinyBase); await resumed.signIn('/api/v1/login',tinyCredentials);
    checked((await resumed.json('/api/v1/summary')).instances === retained.length,'Process restart changed acknowledged constrained originals.');
    checked((await resumed.json('/api/v1/health')).settings.reserveBytes === 0,'Process restart lost explicit zero reserve.');
    for (const item of retained) await original(resumed,item.instance,item.bytes);
    const checkedReview = await audit(resumed); checked(checkedReview.progress.indexed === retained.length,'Restart integrity review missed acknowledged originals.');
    pass('actual-size-capped-filesystem-reserve-and-enospc',{filesystem:'64MiB volatile tmpfs',hostFilesystemFilled:false,acknowledged:retained.length,refusalStatus:507,osError:full.code,
      exactOriginalsAfterStoreProcessRestart:retained.length,containerRestartUsed:false,fault});
  }
  report.passed = true;
} catch (error) { failure = new Error(`Container qualification failed during ${stage}.`); report.failedStage = stage; report.failureReason = error.qualificationReason ?? (['ECONNREFUSED','UND_ERR_SOCKET','ETIMEDOUT','ECONNRESET'].includes(error.cause?.code) ? error.cause.code : 'qualification-operation-failed');
 }
finally {
  let containersRemoved = true, volumesRemoved = true;
  for (const name of ownedContainers) {
    try { await docker(['rm','--force',name]); } catch { containersRemoved = false; }
  }
  for (const name of ownedVolumes) {
    try { await docker(['volume','rm',name]); } catch { volumesRemoved = false; }
  }
  report.cleanup = {containersRemoved,volumesRemoved};
  if (!containersRemoved || !volumesRemoved) { report.passed = false; failure ??= new Error('Disposable container cleanup failed.'); }
  if (reportPath) { const target = resolve(reportPath); await mkdir(dirname(target),{recursive:true}); await writeFile(target,JSON.stringify(report,null,2)+'\n',{mode:0o600}); }
  console.log(JSON.stringify(report,null,2));
}
if (failure) { console.error(failure.message); process.exitCode = 1; }
