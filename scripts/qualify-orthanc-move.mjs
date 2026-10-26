// Optional independent interoperability check. Uses only generated fixtures and
// an isolated Orthanc instance; never connects to an existing user archive.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Archive } from '../src/archive/Archive.js';
import { ConnectionService } from '../src/connections/ConnectionService.js';
import { StorageScp } from '../src/dimse/StorageScp.js';
import { MoveCoordinator } from '../src/dimse/MoveCoordinator.js';
import { dataSetOffset } from '../src/dimse/wire.js';
import { createDicom, uid } from '../src/synthetic.js';
import { VERSION } from '../src/version.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const server=net.createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const {port}=server.address(); await new Promise(resolve=>server.close(resolve)); return port; }
export async function qualifyOrthancMove(executable) {
  if (!path.isAbsolute(executable)) throw new Error('Provide an absolute path to the Orthanc executable.');
  const root=await mkdtemp(path.join(tmpdir(),'easi-store-orthanc-move-'));
  const httpPort=await freePort(),dicomPort=await freePort(),receiverPort=await freePort();
  const receiveAe='EASI_MOVE_TEST',controlAe='EASI_CONTROL',remoteAe='ORTHANCTEST';
  const config={Name:'EASI isolated generated interoperability check',StorageDirectory:path.join(root,'orthanc-storage'),IndexDirectory:path.join(root,'orthanc-storage'),
    HttpPort:httpPort,DicomPort:dicomPort,DicomAet:remoteAe,RemoteAccessAllowed:false,AuthenticationEnabled:false,
    DicomCheckModalityHost:true,DicomAlwaysAllowEcho:false,DicomAlwaysAllowStore:false,DicomAlwaysAllowFind:false,DicomAlwaysAllowGet:false,DicomAlwaysAllowMove:false,
    DicomModalities:{easi:{AET:receiveAe,Host:'127.0.0.1',Port:receiverPort},control:{AET:controlAe,Host:'127.0.0.1',Port:receiverPort}},Plugins:[]};
  const configuration=path.join(root,'orthanc.json'); await writeFile(configuration,JSON.stringify(config),{mode:0o600});
  const child=spawn(executable,[configuration],{cwd:root,stdio:['ignore','pipe','pipe']});
  let output='',launchError; child.stdout.on('data',x=>{output=(output+x).slice(-65536);}); child.stderr.on('data',x=>{output=(output+x).slice(-65536);}); child.on('error',error=>{launchError=error;});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  let archive,service,scp,coordinator;
  const report={storeVersion:VERSION,syntheticOnly:true,isolatedOrthanc:true,checks:[]};
  const rest=async(resource,body)=>{const response=await fetch(`http://127.0.0.1:${httpPort}${resource}`,{...(body!==undefined?{method:'POST',body:Buffer.isBuffer(body)?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});assert.ok(response.ok,`Orthanc HTTP ${response.status}`);return response.json();};
  const dataset=bytes=>{assert.equal(bytes.toString('ascii',128,132),'DICM');return bytes.subarray(144+bytes.readUInt32LE(140));};
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  try {
    for(let attempt=0;;attempt++) {if(launchError)throw launchError;if(child.exitCode!==null)throw new Error(`Isolated Orthanc exited: ${output}`);try{report.orthancVersion=(await rest('/system')).Version;break;}catch(error){if(attempt===100)throw error;await delay(100);}}
    archive=await Archive.open({dataDir:path.join(root,'store')});coordinator=new MoveCoordinator({archive});
    service=await ConnectionService.open({archive,moveCoordinator:coordinator,autoStartJobs:false});
    scp=new StorageScp({archive,auth:{record:{}},aeTitle:receiveAe,port:receiverPort,moveCoordinator:coordinator,
      associationPolicy:peer=>peer.callingAeTitle===remoteAe&&['127.0.0.1','::ffff:127.0.0.1'].includes(peer.remoteAddress)});
    await scp.listen();
    const peer=service.create({name:'Isolated Orthanc C-MOVE',type:'dimse',host:'127.0.0.1',port:dicomPort,calledAeTitle:remoteAe,callingAeTitle:controlAe,retrievalMethod:'c-move',timeoutMs:10000});
    assert.equal((await service.test(peer.id)).ok,true);
    const originals=new Map(),sets=[];
    for(const scope of ['study','series','instance']) {
      const studyUid=uid(),seriesUids=[uid(),uid()],records=[];
      for(let i=0;i<4;i++){const seriesUid=seriesUids[i%2],sopUid=uid(),bytes=createDicom({studyUid,seriesUid,sopUid,instanceNumber:i+1,rows:32,columns:32,patientId:'GENERATED-MOVE-TEST',studyDescription:'Generated C-MOVE check'});originals.set(sopUid,bytes);records.push({studyUid,seriesUid,sopUid});await rest('/instances',bytes);}
      const selection={studyUid,...(scope==='study'?{}:{seriesUid:seriesUids[0]}),...(scope==='instance'?{sopUid:records[0].sopUid}:{})};
      const expected=records.filter(item=>scope==='study'||scope==='series'&&item.seriesUid===seriesUids[0]||scope==='instance'&&item.sopUid===records[0].sopUid);
      sets.push({scope,selection,expected});
      const job=await service.createJob({connectionId:peer.id,direction:'retrieve',selection});service.jobs.autoStart=true;service.jobs.start();await service.jobs.running;service.jobs.autoStart=false;
      const final=service.jobs.get(job.id);assert.equal(final.state,'completed',final.message);assert.equal(final.completed,expected.length);assert.equal(final.failed,0);
      const received=archive.originalRecords('studyUid=?',[studyUid]);assert.deepEqual(received.map(x=>x.sopUid).sort(),expected.map(x=>x.sopUid).sort());
      for(const record of received){const stored=archive.getInstance(record.studyUid,record.seriesUid,record.sopUid),bytes=await readFile(stored.path);assert.equal(hash(bytes.subarray(await dataSetOffset(stored.path))),hash(dataset(originals.get(record.sopUid))));}
      report.checks.push({scope,acknowledged:final.completed,onlySelectedInstances:true,encodedDatasetsPreserved:true,controlAeDiffersFromReceiverAe:true});
    }
    // A completed operation must be followed by a new actual callback, even
    // when the exact instance is already present; duplicate ACKs stay durable.
    const {selection}=sets[2],duplicate=await service.createJob({connectionId:peer.id,direction:'retrieve',selection});service.jobs.autoStart=true;service.jobs.start();await service.jobs.running;service.jobs.autoStart=false;
    assert.equal(service.jobs.get(duplicate.id).state,'completed');assert.equal(archive.stats().instances,7);
    report.checks.push({test:'durable duplicate retrieval',passed:true});
    // Remove only the isolated test destination mapping, never user settings.
    const response=await fetch(`http://127.0.0.1:${httpPort}/modalities/easi`,{method:'DELETE'});assert.ok(response.ok);
    const failed=await service.createJob({connectionId:peer.id,direction:'retrieve',selection});service.jobs.autoStart=true;service.jobs.start();await service.jobs.running;service.jobs.autoStart=false;
    const final=service.jobs.get(failed.id);assert.equal(final.state,'failed');assert.equal(final.completed,0);assert.match(final.message,/C-MOVE/);assert.ok(final.message.length<400);
    report.checks.push({test:'missing destination stays failed despite preexisting object',passed:true});
    report.ok=true;return report;
  } catch(error) { error.message+=`\nIsolated check directory: ${root}\nOrthanc log tail: ${output.slice(-5000)}`;throw error; }
  finally {await coordinator?.close();await scp?.close();await service?.close();await archive?.close();if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==3)throw new Error('Usage: node scripts/qualify-orthanc-move.mjs /absolute/path/to/Orthanc');
  console.log(JSON.stringify(await qualifyOrthancMove(process.argv[2]),null,2));
}
