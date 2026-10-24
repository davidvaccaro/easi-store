import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Archive } from '../src/archive/Archive.js';
import { ConnectionService } from '../src/connections/ConnectionService.js';
import { StorageScp } from '../src/dimse/StorageScp.js';
import { handleDicomweb } from '../src/dicomweb/router.js';
import { createDicom, uid } from './fixtures/synthetic.js';

async function openArchive(t) {const dataDir=await mkdtemp(join(tmpdir(),'easi-store-transfer-roundtrip-')),archive=await Archive.open({dataDir});t.after(async()=>{await archive.close();await rm(dataDir,{recursive:true,force:true});});return archive;}
async function run(service,job) {service.jobs.autoStart=true;service.jobs.start();await service.jobs.running;service.jobs.autoStart=false;return service.jobs.get(job.id);}

test('queued DICOMweb retrieve and STOW send perform real streamed protocol roundtrips with original-byte integrity', {timeout:30000},async t=>{
 const remote=await openArchive(t),local=await openArchive(t),studyUid=uid(),seriesUid=uid();
 for(let i=1;i<=2;i++)await remote.ingest(Readable.from([createDicom({studyUid,seriesUid,instanceNumber:i,rows:16,columns:16})]));
 const server=createServer(async(req,res)=>{try{if(await handleDicomweb(req,res,{archive:remote,basePath:'/dicomweb'}))return;res.writeHead(404);res.end();}catch(error){res.writeHead(error.statusCode||500);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const service=await ConnectionService.open({archive:local,autoStartJobs:false});
 t.after(async()=>{await service.close();await new Promise(resolve=>server.close(resolve));});
 const peer=service.create({name:'Synthetic DICOMweb peer',type:'dicomweb',baseUrl:`http://127.0.0.1:${server.address().port}/dicomweb`});
 assert.equal((await service.test(peer.id)).ok,true);assert.equal((await service.search(peer.id,{criteria:{PatientID:'EASI-SYNTHETIC-001'}})).items.length,1);
 const retrieve=await run(service,await service.createJob({connectionId:peer.id,direction:'retrieve',selection:{studyUid}}));
 assert.equal(retrieve.state,'completed',JSON.stringify(retrieve));assert.equal(retrieve.completed,2);assert.equal(local.stats().instances,2);
 assert.deepEqual(local.queryRecords().map(record=>record.sha256).sort(),remote.queryRecords().map(record=>record.sha256).sort());
 const sent=await run(service,await service.createJob({connectionId:peer.id,direction:'send',selection:{studyUid}}));
 assert.equal(sent.state,'completed',JSON.stringify(sent));assert.equal(sent.completed,2);assert.equal(remote.stats().instances,2,'idempotent resend does not multiply objects');
});

test('configured DIMSE C-ECHO, C-FIND, queued durable C-GET and streamed C-STORE work end to end', {timeout:30000},async t=>{
 const remote=await openArchive(t),local=await openArchive(t),studyUid=uid(),seriesUid=uid();
 for(let i=1;i<=2;i++)await remote.ingest(Readable.from([createDicom({studyUid,seriesUid,instanceNumber:i,rows:16,columns:16})]));
 const scp=new StorageScp({archive:remote,auth:{record:{}},port:0}),address=await scp.listen();
 const service=await ConnectionService.open({archive:local,autoStartJobs:false});t.after(async()=>{await service.close();await scp.close();});
 const peer=service.create({name:'Synthetic DIMSE peer',type:'dimse',host:'127.0.0.1',port:address.port,calledAeTitle:'EASISTORE',callingAeTitle:'TRANSFERTEST',timeoutMs:10000});
 assert.equal((await service.test(peer.id)).ok,true);
 const search=await service.search(peer.id,{criteria:{PatientID:'EASI-SYNTHETIC-001'}});assert.equal(search.items.length,1);assert.equal(search.items[0].studyUid,studyUid);assert.equal(search.items[0].patientName,'Synthetic^Research');
 const retrieve=await run(service,await service.createJob({connectionId:peer.id,direction:'retrieve',selection:{studyUid}}));
 assert.equal(retrieve.state,'completed',JSON.stringify(retrieve));assert.equal(retrieve.completed,2);assert.equal(local.stats().instances,2);
 const sent=await run(service,await service.createJob({connectionId:peer.id,direction:'send',selection:{studyUid}}));
 assert.equal(sent.state,'completed',JSON.stringify(sent));assert.equal(sent.completed,2);assert.equal(remote.stats().instances,2);
});

test('a peer STOW response must acknowledge the selected instance before checkpointing success', {timeout:10000},async t=>{
 const archive=await openArchive(t),studyUid=uid();await archive.ingest(Readable.from([createDicom({studyUid,rows:8,columns:8})]));
 const server=createServer(async(req,res)=>{for await(const _chunk of req){}res.setHeader('Content-Type','application/dicom+json');res.end(JSON.stringify({'00081199':{vr:'SQ',Value:[{'00081155':{vr:'UI',Value:[uid()]}}]}}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const service=await ConnectionService.open({archive,autoStartJobs:false});t.after(async()=>{await service.close();await new Promise(resolve=>server.close(resolve));});
 const peer=service.create({name:'Wrong acknowledgement',type:'dicomweb',baseUrl:`http://127.0.0.1:${server.address().port}`});
 const result=await run(service,await service.createJob({connectionId:peer.id,direction:'send',selection:{studyUid}}));assert.equal(result.state,'failed');assert.equal(result.completed,0);assert.equal(result.failed,1);
});

test('direct and multipart WADO cannot commit the requested SOP in a different series', {timeout:10000},async t=>{
 const archive=await openArchive(t),studyUid=uid(),seriesUid=uid(),sopUid=uid(),wrongSeriesUid=uid();
 const bytes=createDicom({studyUid,seriesUid:wrongSeriesUid,sopUid,rows:8,columns:8});let multipart=false;
 const server=createServer((_req,res)=>{
  res.setHeader('Content-Type',multipart?'multipart/related; type="application/dicom"; boundary=scope-test':'application/dicom');
  res.end(multipart?Buffer.concat([Buffer.from('--scope-test\r\nContent-Type: application/dicom\r\n\r\n'),bytes,Buffer.from('\r\n--scope-test--\r\n')]):bytes);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const service=await ConnectionService.open({archive,autoStartJobs:false});t.after(async()=>{await service.close();await new Promise(resolve=>server.close(resolve));});
 const peer=service.create({name:'Wrong-series WADO peer',type:'dicomweb',baseUrl:`http://127.0.0.1:${server.address().port}`});
 for(const mode of [false,true]) {
  multipart=mode;
  const result=await run(service,await service.createJob({connectionId:peer.id,direction:'retrieve',selection:{studyUid,seriesUid,sopUid}}));
  assert.equal(result.state,'failed');assert.equal(result.completed,0);assert.equal(result.failed,1);assert.equal(archive.stats().instances,0,'hierarchy validation precedes archival commit');assert.equal(archive.activity({}).length,0);
 }
});

test('an invalid multipart WADO header promptly cancels its unread response stream', {timeout:10000},async t=>{
 const archive=await openArchive(t);let closed;const responseClosed=new Promise(resolve=>{closed=resolve;});
 const server=createServer((_req,res)=>{
  res.setHeader('Content-Type','multipart/related; type="application/dicom"; boundary=reject-test');
  res.write('--reject-test\r\nContent-Type: text/plain\r\n\r\nnot-dicom');
  const timer=setInterval(()=>res.write(Buffer.alloc(4096)),10);
  res.on('close',()=>{clearInterval(timer);closed();});
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const service=await ConnectionService.open({archive,autoStartJobs:false});t.after(async()=>{await service.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const peer=service.create({name:'Unread-body WADO peer',type:'dicomweb',baseUrl:`http://127.0.0.1:${server.address().port}`,timeoutMs:5000});
 const started=Date.now();
 await assert.rejects(service.transfer(peer,'retrieve',{studyUid:uid(),seriesUid:uid(),sopUid:uid()},new AbortController().signal),/unexpected multipart object/);
 await responseClosed;assert.ok(Date.now()-started<2000,'the body is canceled before the five-second peer deadline');assert.equal(archive.stats().instances,0);
});

test('canceling an active streamed WADO ingest closes the peer and removes uncommitted spool data', {timeout:10000},async t=>{
 const archive=await openArchive(t),studyUid=uid(),seriesUid=uid(),sopUid=uid();
 let entered,closed;const ingestStarted=new Promise(resolve=>{entered=resolve;}),responseClosed=new Promise(resolve=>{closed=resolve;});
 const ingest=archive.ingest.bind(archive);archive.ingest=(body,options)=>{entered();return ingest(body,options);};
 const server=createServer((_req,res)=>{
  res.setHeader('Content-Type','multipart/related; type="application/dicom"; boundary=cancel-test');
  res.write('--cancel-test\r\nContent-Type: application/dicom\r\n\r\n');res.write(createDicom({studyUid,seriesUid,sopUid,rows:8,columns:8}));
  const timer=setInterval(()=>res.write(Buffer.alloc(4096)),10);res.on('close',()=>{clearInterval(timer);closed();});
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const service=await ConnectionService.open({archive,autoStartJobs:false});t.after(async()=>{await service.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const peer=service.create({name:'Cancelable WADO peer',type:'dicomweb',baseUrl:`http://127.0.0.1:${server.address().port}`,timeoutMs:5000}),controller=new AbortController();
 const transfer=service.transfer(peer,'retrieve',{studyUid,seriesUid,sopUid},controller.signal);await ingestStarted;const started=Date.now();controller.abort();
 await assert.rejects(transfer);await responseClosed;
 assert.ok(Date.now()-started<2000);assert.equal(archive.stats().instances,0);assert.deepEqual(await readdir(join(archive.dataDir,'spool')),[]);
});
