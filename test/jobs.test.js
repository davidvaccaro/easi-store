import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Archive } from '../src/archive/Archive.js';
import { ConnectionService } from '../src/connections/ConnectionService.js';
import { createDicom, uid } from './fixtures/synthetic.js';

async function setup(t,transports={}) {
 const dataDir=await mkdtemp(join(tmpdir(),'easi-store-jobs-')),archive=await Archive.open({dataDir});let service=await ConnectionService.open({archive,autoStartJobs:false,transports});
 t.after(async()=>{await service.close();await archive.close();await rm(dataDir,{recursive:true,force:true});});
 const studyUid=uid(),seriesUid=uid();for(let i=1;i<=3;i++)await archive.ingest(Readable.from([createDicom({studyUid,seriesUid,instanceNumber:i,rows:8,columns:8})]));
 const peer=service.create({name:'Remote peer',type:'dicomweb',baseUrl:'http://127.0.0.1:1/dicomweb'});
 return {archive,service,peer,studyUid,replace(value){service=value;}};
}
async function run(service) {service.jobs.autoStart=true;service.jobs.start();await service.jobs.running;service.jobs.autoStart=false;}

test('failed transfers retain completed checkpoints and manual retry sends only unfinished instances',async t=>{
 let calls=[],fail=true;const c=await setup(t,{transfer:async(_peer,_direction,item)=>{calls.push(item.sopUid);if(fail&&calls.length===2)throw Error('do not leak peer error or patient details');return {outcome:'sent'};}});
 const job=await c.service.createJob({connectionId:c.peer.id,direction:'send',selection:{studyUid:c.studyUid}});await run(c.service);
 const failed=c.service.jobs.get(job.id);assert.equal(failed.state,'failed');assert.equal(failed.completed,2);assert.equal(failed.failed,1);assert.ok(!failed.message.includes('patient'));
 fail=false;c.service.jobs.retry(job.id);await run(c.service);const result=c.service.jobs.get(job.id);assert.equal(result.state,'completed');assert.equal(result.completed,3);assert.equal(result.failed,0);assert.equal(calls.length,4);assert.equal(calls[1],calls[3]);
});

test('restart recovers an interrupted item and resumes acknowledged checkpoints without replay',async t=>{
 const sent=[];const c=await setup(t,{transfer:async(_peer,_direction,item)=>{sent.push(item.sopUid);return {outcome:'sent'};}});
 const job=await c.service.createJob({connectionId:c.peer.id,direction:'send',selection:{studyUid:c.studyUid}});
 c.archive.db.prepare("UPDATE transfer_jobs SET state='running',completed=1 WHERE id=?").run(job.id);
 c.archive.db.prepare("UPDATE transfer_items SET state='done' WHERE jobId=? AND position=0").run(job.id);
 c.archive.db.prepare("UPDATE transfer_items SET state='running' WHERE jobId=? AND position=1").run(job.id);
 const next=new ConnectionService({archive:c.archive,autoStartJobs:false,transports:c.service.transports});next.initialize();c.replace(next);
 assert.equal(next.jobs.get(job.id).state,'queued');await run(next);assert.equal(next.jobs.get(job.id).completed,3);assert.equal(sent.length,2);
});

test('cancel interrupts the active operation and retry preserves finished instances',async t=>{
 let entered;const ready=new Promise(resolve=>{entered=resolve;});const c=await setup(t,{transfer:async(_peer,_direction,_item,signal)=>{entered();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
 const job=await c.service.createJob({connectionId:c.peer.id,direction:'send',selection:{studyUid:c.studyUid}});c.service.jobs.autoStart=true;c.service.jobs.start();await ready;c.service.jobs.cancel(job.id);assert.equal(c.service.jobs.get(job.id).state,'canceling');assert.throws(()=>c.service.jobs.retry(job.id),/Only failed or canceled/);assert.throws(()=>c.service.update(c.peer.id,{name:'Changed',type:'dicomweb',baseUrl:'http://127.0.0.1:2'}),/active transfers/);await c.service.jobs.running;
 assert.equal(c.service.jobs.get(job.id).state,'canceled');assert.equal(c.service.jobs.get(job.id).completed,0);
 c.service.transports.transfer=async()=>({outcome:'sent'});c.service.jobs.retry(job.id);await c.service.jobs.running;assert.equal(c.service.jobs.get(job.id).completed,3);
});

test('shutdown pauses work and changed connection targets require a new confirmed transfer',async t=>{
 let entered;const ready=new Promise(resolve=>{entered=resolve;});const c=await setup(t,{transfer:async(_peer,_direction,_item,signal)=>{entered();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
 const job=await c.service.createJob({connectionId:c.peer.id,direction:'send',selection:{studyUid:c.studyUid}});c.service.jobs.autoStart=true;c.service.jobs.start();await ready;await c.service.close();assert.equal(c.service.jobs.get(job.id).state,'queued');
 c.service.jobs.closing=false;c.service.jobs.cancel(job.id);c.service.update(c.peer.id,{name:'Other peer',type:'dicomweb',baseUrl:'http://127.0.0.1:2/dicomweb'});assert.throws(()=>c.service.jobs.retry(job.id),/connection changed/);
});
