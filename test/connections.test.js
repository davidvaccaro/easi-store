import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { Archive } from '../src/archive/Archive.js';
import { ConnectionService } from '../src/connections/ConnectionService.js';
import { createDicom, uid } from './fixtures/synthetic.js';

async function context(t,options={}) {
 const dataDir=await mkdtemp(join(tmpdir(),'easi-store-peers-')), archive=await Archive.open({dataDir}),service=await ConnectionService.open({archive,autoStartJobs:false,...options});
 t.after(async()=>{await service.close();await archive.close();await rm(dataDir,{recursive:true,force:true});});return {archive,service};
}
async function listener(t,handler) {const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;}

test('configured peers persist, validate URLs/credentials, and never disclose secret values',async t=>{
 const {archive,service}=await context(t,{credentials:{orthanc:{bearerToken:'private-token-never-returned'}}});
 assert.throws(()=>service.create({name:'Bad',type:'dicomweb',baseUrl:'https://user:pass@localhost/dicomweb'}),/without embedded credentials/);
 assert.throws(()=>service.create({name:'Bad',type:'dicomweb',baseUrl:'file:///etc/passwd'}),/HTTP/);
 assert.throws(()=>service.create({name:'Bad',type:'dicomweb',baseUrl:'http://10.0.0.2/dicomweb',credentialId:'orthanc'}),/HTTPS/);
 assert.throws(()=>service.create({name:'Bad',type:'dicomweb',baseUrl:'https://localhost/dicomweb',headers:{Authorization:'x'}}),/Unexpected/);
 const peer=service.create({name:'Test archive',type:'dicomweb',baseUrl:'https://localhost/dicomweb/',credentialId:'orthanc'});
 assert.equal(peer.baseUrl,'https://localhost/dicomweb');assert.ok(!JSON.stringify(service.list()).includes('private-token'));
 const again=new ConnectionService({archive,credentials:service.credentials,autoStartJobs:false});again.initialize();assert.equal(again.get(peer.id).credentialId,'orthanc');
 const dimse=service.create({name:'Local receiver',type:'dimse',host:'127.0.0.1',port:4248,calledAeTitle:'DESTINATION'});
 assert.equal(service.resolveMoveDestination('DESTINATION').id,dimse.id);assert.equal(service.resolveMoveDestination('UNKNOWN'),null);
 service.create({name:'Ambiguous receiver',type:'dimse',host:'127.0.0.1',port:4249,calledAeTitle:'DESTINATION'});assert.equal(service.resolveMoveDestination('DESTINATION'),null);
 const revised=service.update(peer.id,{name:'Edited archive',type:'dicomweb',baseUrl:'https://localhost/dicomweb'});assert.equal(revised.revision,2);
 service.remove(peer.id);assert.throws(()=>service.get(peer.id),/not found/);
});

test('DICOMweb test and bounded patient search use fixed peer URL and reject redirects',async t=>{
 let received;const studyUid=uid();
 const base=await listener(t,(req,res)=>{received={url:req.url,auth:req.headers.authorization};res.setHeader('Content-Type','application/dicom+json');res.end(JSON.stringify([{'0020000D':{vr:'UI',Value:[studyUid]},'00100010':{vr:'PN',Value:[{Alphabetic:'Synthetic^Patient'}]},'00100020':{vr:'LO',Value:['DEMO']}}]));});
 const {service}=await context(t,{credentials:{local:{bearerToken:'private'}}});const peer=service.create({name:'Local',type:'dicomweb',baseUrl:`${base}/dicomweb`,credentialId:'local'});
 assert.equal((await service.test(peer.id)).ok,true);assert.equal(received.auth,'Bearer private');
 const result=await service.search(peer.id,{criteria:{PatientID:'DEMO'},limit:20});assert.equal(result.items[0].studyUid,studyUid);assert.match(received.url,/PatientID=DEMO/);
 assert.throws(()=>service.validate({name:'Bad',type:'dimse',host:'localhost/path',port:4242,calledAeTitle:'A'}),/hostname/);
 await assert.rejects(service.search(peer.id,{criteria:{ArbitraryKey:'x'}}),/criteria/);
 const redirect=await listener(t,(_req,res)=>{res.writeHead(302,{Location:`${base}/unconfigured`});res.end();});
 const redirectPeer=service.create({name:'Redirect',type:'dicomweb',baseUrl:redirect});await assert.rejects(service.test(redirectPeer.id),/could not be reached/);
});

test('transfer selections are checked and snapshots contain no original filesystem paths',async t=>{
 const {archive,service}=await context(t),studyUid=uid(),seriesUid=uid(),sopUid=uid();
 await archive.ingest(Readable.from([createDicom({studyUid,seriesUid,sopUid})]));const peer=service.create({name:'Receiver',type:'dicomweb',baseUrl:'http://127.0.0.1:1/dicomweb'});
 const job=await service.createJob({connectionId:peer.id,direction:'send',selection:{studyUid}});assert.equal(job.total,1);
 assert.ok(!JSON.stringify(archive.db.prepare('SELECT * FROM transfer_items').all()).includes(archive.dataDir));
 assert.throws(()=>service.update(peer.id,{name:'Changed',type:'dicomweb',baseUrl:'http://127.0.0.1:2'}),/active transfers/);
 assert.throws(()=>service.remove(peer.id),/Cancel active/);
 await assert.rejects(service.createJob({connectionId:peer.id,direction:'send',selection:{studyUid,path:'/etc/passwd'}}),/Unexpected selection/);
 await assert.rejects(service.createJob({connectionId:peer.id,direction:'send',selection:{studyUid:uid()}}),/not archived/);
 service.jobs.cancel(job.id);service.remove(peer.id);
});
