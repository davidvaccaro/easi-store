#!/usr/bin/env node
// Optional independent interoperability qualification. Start only private,
// generated-data Orthanc/Store instances; never target an existing PACS.
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {createStoreServer} from '../src/server.js';
import {StorageScp} from '../src/dimse/StorageScp.js';
import {createDicom,uid} from '../src/synthetic.js';
import {VERSION} from '../src/version.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const checked = (condition,message) => { if (!condition) throw Object.assign(new Error(message),{qualificationReason:message}); };
async function freePort() {
  const server=net.createServer();
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function dataset(bytes) {
  checked(bytes.length>=144&&bytes.toString('ascii',128,132)==='DICM'&&bytes.readUInt16LE(132)===2&&bytes.readUInt16LE(134)===0,'Unexpected generated Part10 metadata.');
  const offset=144+bytes.readUInt32LE(140); checked(offset<bytes.length,'Unexpected generated Part10 metadata length.'); return bytes.subarray(offset);
}
async function bytesOf(response,limit=8*1024*1024) {
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;checked(size<=limit,'Generated peer response exceeded its qualification bound.');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
export async function qualifyOrthanc({executable,plugin}) {
  if(!path.isAbsolute(executable)||!path.isAbsolute(plugin))throw new Error('Provide absolute trusted Orthanc and DICOMweb plugin paths.');
  const scratch=await mkdtemp(path.join(tmpdir(),'easi-store-orthanc-protocol-'));
  const report={passed:false,storeVersion:VERSION,nodeVersion:process.version,syntheticOnly:true,userArchiveAccessed:false,isolatedOrthanc:true,
    profile:{dicomweb:'Authenticated HTTP loopback',dimse:'Exact calling-AE and loopback-address admission',transferSyntax:'Explicit VR Little Endian',generatedModalities:['CT'],compressedSyntaxesQualified:false,multipartCompatibility:'Standard up to70characters plus the qualified repeated-UUID73-character Orthanc delimiter'},checks:[],cleanup:{}};
  let app,scp,child,exited,launchError,stage='startup',log='';
  let activeJob;
  const pass=(name,facts={})=>report.checks.push({name,passed:true,...facts});
  try {
    app=await createStoreServer({dataDir:path.join(scratch,'store'),host:'127.0.0.1',port:0,accessProfile:'authenticated',autoStartJobs:false});
    const address=await app.listen(),storeBase=`http://127.0.0.1:${address.port}`;
    await app.auth.setup({username:'generated-protocol-admin',password:randomBytes(32).toString('base64url')},'127.0.0.1');
    const token=await app.auth.issueApiToken('Generated isolated protocol client');
    const storeAe='EASI_STORE_QA',orthancAe='ORTHANC_QA';
    scp=new StorageScp({archive:app.archive,auth:app.auth,port:0,aeTitle:storeAe,moveCoordinator:app.moveCoordinator,
      resolveMoveDestination:ae=>app.connections.resolveMoveDestination(ae),associationPolicy:peer=>peer.callingAeTitle===orthancAe&&['127.0.0.1','::ffff:127.0.0.1'].includes(peer.remoteAddress)});
    const receiver=await scp.listen(),httpPort=await freePort(),dicomPort=await freePort(),orthancBase=`http://127.0.0.1:${httpPort}`;
    const config={Name:'EASI generated protocol qualification only',StorageDirectory:path.join(scratch,'orthanc'),IndexDirectory:path.join(scratch,'orthanc'),
      HttpPort:httpPort,DicomPort:dicomPort,DicomAet:orthancAe,RemoteAccessAllowed:false,AuthenticationEnabled:false,DicomCheckModalityHost:true,
      DicomAlwaysAllowEcho:false,DicomAlwaysAllowStore:false,DicomAlwaysAllowFind:false,DicomAlwaysAllowGet:false,DicomAlwaysAllowMove:false,
      DicomScuPreferredTransferSyntax:'1.2.840.10008.1.2.1',AcceptedTransferSyntaxes:['1.2.840.10008.1.2.1'],
      DicomModalities:{store:{AET:storeAe,Host:'127.0.0.1',Port:receiver.port,AllowEcho:true,AllowFind:true,AllowGet:true,AllowMove:true,AllowStore:true}},
      Plugins:[plugin],DicomWeb:{Enable:true,Root:'/dicom-web/',Servers:{store:{Url:storeBase+'/dicomweb/',HttpHeaders:{Authorization:`Bearer ${token}`},ChunkedTransfers:true,HasWadoRsUniversalTransferSyntax:true,Timeout:10}}}};
    const configPath=path.join(scratch,'orthanc.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
    child=spawn(executable,[configPath],{cwd:scratch,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',bytes=>{log=(log+bytes).slice(-65536);});child.stderr.on('data',bytes=>{log=(log+bytes).slice(-65536);});
    child.once('error',error=>{launchError=error;});exited=new Promise(resolve=>child.once('close',resolve));
    const orthanc=async(route,{method='GET',body,raw=false,expected=200}={})=>{
      const response=await fetch(orthancBase+route,{method,headers:{Connection:'close',...(body===undefined?{}:{'Content-Type':Buffer.isBuffer(body)?'application/dicom':'application/json'})},
        ...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000),redirect:'error'});
      if(response.status!==expected){await response.body?.cancel();throw Object.assign(new Error('Independent Orthanc request failed.'),{qualificationReason:`Orthanc operation at ${stage} returned HTTP ${response.status}; expected ${expected}.`});}
      const bytes=await bytesOf(response);return raw?bytes:bytes.length?JSON.parse(bytes):null;
    };
    for(let attempt=0;;attempt++){
      if(launchError)throw launchError;if(child.exitCode!==null)throw new Error('Isolated Orthanc did not start.');
      try{report.orthancVersion=(await orthanc('/system')).Version;break;}catch(error){if(attempt===100)throw error;await delay(100);}
    }
    const pluginInfo=await orthanc('/plugins/dicom-web');report.dicomwebPluginVersion=pluginInfo.Version;
    report.binarySha256=sha(await readFile(executable));report.pluginSha256=sha(await readFile(plugin));
    const store=async(route,{method='GET',body,bytes,expected=200,authenticated=true,raw=false}={})=>{
      const response=await fetch(storeBase+route,{method,headers:{Connection:'close',...(authenticated?{Authorization:`Bearer ${token}`} : {}),...(method==='GET'?{}:{'Content-Type':bytes?'application/dicom':'application/json'})},
        ...(method==='GET'?{}:{body:bytes??JSON.stringify(body??{})}),signal:AbortSignal.timeout(20000),redirect:'error'});
      checked(response.status===expected,`Store operation at ${stage} returned HTTP ${response.status}; expected ${expected}.`);
      const value=await bytesOf(response);return raw?value:value.length?JSON.parse(value):null;
    };
    const ingest=async(options={})=>{const bytes=createDicom({rows:32,columns:48,frames:2,...options});const result=await store('/api/v1/instances',{method:'POST',bytes,expected:201});return{...result.instance,original:bytes};};
    const remoteUpload=async(options={})=>{const bytes=createDicom({rows:32,columns:48,frames:2,...options}),record=await orthanc('/instances',{method:'POST',body:bytes});
      const original=await orthanc('/instances/'+record.ID+'/file',{raw:true});return{bytes:original,id:record.ID,studyId:record.ParentStudy,seriesId:record.ParentSeries};};
    const remoteFind=async(sopUid)=>{const ids=await orthanc('/tools/find',{method:'POST',body:{Level:'Instance',Query:{SOPInstanceUID:sopUid}}});checked(ids.length===1,`Independent peer has ${ids.length} matches for an exact generated SOP; expected1.`);return ids[0];};
    const verifyStoreDataset=async(source,sopUid,studyUid,seriesUid)=>{const record=app.archive.getInstance(studyUid,seriesUid,sopUid);checked(Boolean(record),'A successful DIMSE transfer was not catalogued.');checked(sha(dataset(await readFile(record.path)))===sha(dataset(source)),'DIMSE changed the encoded generated dataset.');};
    const verifyRemoteDataset=async(source,sopUid)=>{const id=await remoteFind(sopUid),received=await orthanc('/instances/'+id+'/file',{raw:true});checked(sha(dataset(received))===sha(dataset(source)),'DIMSE changed the encoded generated dataset.');};
    const peer=app.connections.create({name:'Generated Orthanc DIMSE',type:'dimse',host:'127.0.0.1',port:dicomPort,calledAeTitle:orthancAe,callingAeTitle:storeAe,retrievalMethod:'c-get',timeoutMs:10000});
    const webPeer=app.connections.create({name:'Generated Orthanc DICOMweb',type:'dicomweb',baseUrl:orthancBase+'/dicom-web',timeoutMs:10000});
    const job=async(connectionId,direction,selection)=>{
      activeJob=await app.connections.createJob({connectionId,direction,selection});app.connections.jobs.autoStart=true;app.connections.jobs.start();await app.connections.jobs.running;app.connections.jobs.autoStart=false;
      const final=app.connections.jobs.get(activeJob.id);checked(final.state==='completed'&&final.failed===0,`Queued ${direction} interoperability failed at ${stage}.`);return final;
    };

    stage='C-ECHO';checked((await app.connections.test(peer.id)).ok,'Store C-ECHO SCU failed.');await orthanc('/modalities/store/echo',{method:'POST',body:{Timeout:10}});pass('independent-c-echo-both-directions');
    stage='C-STORE SCP';const inboundIdentity={studyUid:uid(),seriesUid:uid(),sopUid:uid()},inbound=await remoteUpload(inboundIdentity);
    await orthanc('/modalities/store/store',{method:'POST',body:{Resources:[inbound.id],Timeout:10}});await verifyStoreDataset(inbound.bytes,inboundIdentity.sopUid,inboundIdentity.studyUid,inboundIdentity.seriesUid);
    pass('orthanc-scu-to-store-c-store-scp',{instances:1,encodedDatasetPreserved:true});
    stage='C-FIND SCP';const studyUid=uid(),seriesUid=uid(),seriesTwo=uid(),sources=[];
    for(let index=0;index<3;index++)sources.push(await ingest({studyUid,seriesUid:index===2?seriesTwo:seriesUid,instanceNumber:index+1}));
    for(const [level,query,expected]of[['Study',{StudyInstanceUID:studyUid},1],['Series',{StudyInstanceUID:studyUid},2],['Instance',{StudyInstanceUID:studyUid,SeriesInstanceUID:seriesUid},2]]){
      const result=await orthanc('/modalities/store/query',{method:'POST',body:{Level:level,Query:query}}),answers=await orthanc('/queries/'+result.ID+'/answers');checked(answers.length===expected,'Independent C-FIND hierarchical answer count differs.');
    }
    pass('orthanc-scu-to-store-c-find-scp',{levels:['STUDY','SERIES','IMAGE'],exactHierarchyCounts:true});
    stage='C-GET SCP';await orthanc('/modalities/store/get',{method:'POST',body:{Level:'Study',Resources:[{StudyInstanceUID:studyUid}],Timeout:10}});
    for(const source of sources)await verifyRemoteDataset(source.original,source.sopUid);pass('orthanc-scu-to-store-c-get-scp',{instances:3,encodedDatasetsPreserved:true});
    const matchingStudies=await orthanc('/tools/find',{method:'POST',body:{Level:'Study',Query:{StudyInstanceUID:studyUid}}});checked(matchingStudies.length===1,'Generated retrieval study was not unique.');await orthanc('/studies/'+matchingStudies[0],{method:'DELETE'});
    stage='C-MOVE SCP';await orthanc('/modalities/store/move',{method:'POST',body:{Level:'Study',Resources:[{StudyInstanceUID:studyUid}],TargetAet:orthancAe,Timeout:10}});
    for(const source of sources)await verifyRemoteDataset(source.original,source.sopUid);pass('orthanc-scu-to-store-c-move-scp',{instances:3,configuredDestinationOnly:true,encodedDatasetsPreserved:true});
    stage='C-STORE SCU';const outbound=await ingest();await job(peer.id,'send',{studyUid:outbound.studyUid});await verifyRemoteDataset(outbound.original,outbound.sopUid);pass('store-c-store-scu-to-orthanc-scp',{instances:1,encodedDatasetPreserved:true});
    stage='C-FIND and C-GET SCU';const retrieveIdentity={studyUid:uid(),seriesUid:uid(),sopUid:uid()},retrieve=await remoteUpload(retrieveIdentity);
    const found=await app.connections.search(peer.id,{criteria:{StudyInstanceUID:retrieveIdentity.studyUid},limit:10});checked(found.items.length===1&&found.items[0].studyUid===retrieveIdentity.studyUid,'Store C-FIND SCU did not locate the generated study.');
    await job(peer.id,'retrieve',retrieveIdentity);await verifyStoreDataset(retrieve.bytes,retrieveIdentity.sopUid,retrieveIdentity.studyUid,retrieveIdentity.seriesUid);
    pass('store-c-find-and-durable-c-get-scu-to-orthanc-scp',{instances:1,encodedDatasetPreserved:true});
    stage='DIMSE reserve refusal';const rejectedIdentity={studyUid:uid(),seriesUid:uid(),sopUid:uid()},rejected=await remoteUpload(rejectedIdentity),before=app.archive.stats().instances,health=await app.archive.health.getSnapshot();
    const low=Math.min(1024**5,health.storage.availableBytes+1024**3),limited=await app.archive.health.updateSettings({...health.settings,reserveBytes:low,warningBytes:low});
    let refused=false;try{await orthanc('/modalities/store/store',{method:'POST',body:{Resources:[rejected.id],Timeout:10}});}catch{refused=true;}
    checked(refused&&app.archive.stats().instances===before&&!app.archive.getInstance(rejectedIdentity.studyUid,rejectedIdentity.seriesUid,rejectedIdentity.sopUid),'Low storage was falsely acknowledged through C-STORE.');
    await app.archive.health.updateSettings({...limited,reserveBytes:health.settings.reserveBytes,warningBytes:health.settings.warningBytes});
    pass('orthanc-c-store-observes-storage-reserve-failure',{successAcknowledged:false,catalogUnchanged:true});

    stage='QIDO-RS SCP';await store('/dicomweb/studies',{authenticated:false,expected:401});
    const qido=await orthanc('/dicom-web/servers/store/get',{method:'POST',body:{Uri:'/studies',Arguments:{StudyInstanceUID:studyUid},HttpHeaders:{Accept:'application/dicom+json'}}});
    checked(qido.length===1&&qido[0]['0020000D']?.Value?.[0]===studyUid,'Independent authenticated QIDO client did not identify the study.');
    pass('orthanc-dicomweb-client-to-authenticated-store-qido',{studyCount:1});
    stage='STOW-RS SCP';const stowIdentity={studyUid:uid(),seriesUid:uid(),sopUid:uid()},stow=await remoteUpload(stowIdentity);
    await orthanc('/dicom-web/servers/store/stow',{method:'POST',body:{Resources:[stow.id],Synchronous:true}});
    const stowed=app.archive.getInstance(stowIdentity.studyUid,stowIdentity.seriesUid,stowIdentity.sopUid);checked(stowed&&sha(await readFile(stowed.path))===sha(stow.bytes),'STOW did not preserve the complete DICOM file.');
    pass('orthanc-stow-client-to-authenticated-store',{instances:1,completePart10BytesPreserved:true});
    stage='WADO-RS SCP';const wado=await ingest();await orthanc('/dicom-web/servers/store/retrieve',{method:'POST',body:{Resources:[{Study:wado.studyUid,Series:wado.seriesUid,Instance:wado.sopUid}],Synchronous:true}});
    const wadoId=await remoteFind(wado.sopUid);checked(sha(await orthanc('/instances/'+wadoId+'/file',{raw:true}))===sha(wado.original),'WADO did not preserve the complete DICOM file.');
    pass('orthanc-wado-client-from-authenticated-store',{instances:1,completePart10BytesPreserved:true});
    stage='DICOMweb SCU';checked((await app.connections.test(webPeer.id)).ok,'Store QIDO connection test failed.');
    const webOut=await ingest();await job(webPeer.id,'send',{studyUid:webOut.studyUid});checked(sha(await orthanc('/instances/'+await remoteFind(webOut.sopUid)+'/file',{raw:true}))===sha(webOut.original),'Store STOW changed the complete original.');
    const webInIdentity={studyUid:uid(),seriesUid:uid(),sopUid:uid()},webIn=await remoteUpload(webInIdentity);
    const webFound=await app.connections.search(webPeer.id,{criteria:{StudyInstanceUID:webInIdentity.studyUid},limit:10});checked(webFound.items.length===1,'Store QIDO search failed.');
    await job(webPeer.id,'retrieve',webInIdentity);const received=app.archive.getInstance(webInIdentity.studyUid,webInIdentity.seriesUid,webInIdentity.sopUid);checked(received&&sha(await readFile(received.path))===sha(webIn.bytes),'Store WADO changed the complete original.');
    pass('store-qido-stow-wado-clients-to-orthanc-plugin',{sent:1,retrieved:1,completePart10BytesPreserved:true});
    report.archivedInstances=app.archive.stats().instances;report.passed=true;
  }catch(error){report.failedStage=stage;report.failureReason=error.qualificationReason??'independent-protocol-operation-failed';}
  finally{
    await scp?.close();await app?.close();
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);await exited;clearTimeout(timer);}
    await rm(scratch,{recursive:true,force:true});report.cleanup={temporaryArchiveRemoved:true,isolatedOrthancStopped:true,userOrthancTouched:false};
  }
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),executable=args.shift();let plugin,reportPath;
  while(args.length){const flag=args.shift();if(flag==='--plugin')plugin=args.shift();else if(flag==='--report')reportPath=args.shift();else throw new Error('Usage: node scripts/qualify-orthanc.mjs /path/to/Orthanc --plugin /path/to/dicomweb-plugin [--report PATH]');}
  const report=await qualifyOrthanc({executable,plugin});if(reportPath){await mkdir(path.dirname(path.resolve(reportPath)),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
  console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}
