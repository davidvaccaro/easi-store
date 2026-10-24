import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import net from 'node:net';
import { once } from 'node:events';
import EASI, { Tag } from '@xinonix/easi-js';
import { NodeDimseQueryRetrieveSourceTransport } from '@xinonix/easi-js/dimse/node';
import { Archive } from '../src/archive/Archive.js';
import { StorageScp, sendStoredInstance } from '../src/dimse/StorageScp.js';
import { createDicom, uid } from './fixtures/synthetic.js';
import { dataSetOffset, commandBytes, u16, text, decodeCommand, items, item, pdu } from '../src/dimse/wire.js';
import { encodeIdentifier } from '../src/dimse/query.js';

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(),'easi-store-qr-')), archive = await Archive.open({dataDir});
  const Scp = options.Scp ?? StorageScp;
  const scp = new Scp({archive,auth:{record:{}},port:0,...options}), address = await scp.listen();
  t.after(async () => { await scp.close(); await archive.close(); await rm(dataDir,{recursive:true,force:true}); });
  return {archive,scp,association:{host:'127.0.0.1',port:address.port,calledAeTitle:options.aeTitle ?? 'EASISTORE',callingAeTitle:'EASITEST',timeoutMs:5000}};
}
const transport = () => new NodeDimseQueryRetrieveSourceTransport();
async function payload(envelope) { if(envelope.source) return Buffer.from(envelope.source); const parts=[]; for (;;) { const {done,value}=await envelope.stream.read(); if(done) break; parts.push(Buffer.from(value)); } return Buffer.concat(parts); }

test('Study/Patient Root FIND and GET interoperate with independent EASI JS SCU and exact dataset bytes', {timeout:15000}, async t => {
  const {archive,association} = await setup(t), studyUid = uid(), seriesUid = uid();
  const sources = [1,2,3].map(instanceNumber => createDicom({studyUid,seriesUid,instanceNumber,patientName:'Synthetic^André'}));
  for (const bytes of sources) await archive.ingest(Readable.from([bytes]));
  await archive.ingest(Readable.from([createDicom({patientId:'OTHER',studyDescription:'Other'})]));
  const found = await transport().read(association,{operation:'c-find',queryRetrieveLevel:'STUDY',keys:{PatientName:'Synthetic*',PatientID:'EASI-SYNTHETIC-001'},returnKeys:['StudyInstanceUID','StudyDescription','NumberOfStudyRelatedInstances']});
  assert.equal(found.metadata.dimse.finalResponse.status,0); assert.equal(found.metadata.count,1);
  const parsed = await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build().process({source:await payload(found)});
  assert.equal(parsed.first().dataSet.value(Tag.StudyInstanceUID),studyUid);
  assert.equal(Number(parsed.first().dataSet.value(Tag.NumberOfStudyRelatedInstances)),3);
  assert.equal(parsed.first().dataSet.value(Tag.PatientName),'Synthetic^André');
  assert.equal(parsed.first().dataSet.find(Tag.SeriesInstanceUID),undefined,'unrequested series UID must not be introduced into study response');
  const patient = await transport().read(association,{operation:'c-find',queryRetrieveModel:'patient-root',queryRetrieveLevel:'PATIENT',patientId:'EASI-SYNTHETIC-001'});
  assert.equal(patient.metadata.count,1);
  const result = await transport().read(association,{operation:'c-get',queryRetrieveLevel:'SERIES',studyInstanceUid:studyUid,seriesInstanceUid:seriesUid,storageTransferSyntaxUids:['1.2.840.10008.1.2.1']});
  assert.equal(result.metadata.dimse.finalResponse.status,0); assert.equal(result.metadata.count,3);
  const output = await payload(result);
  for (let i = 0; i < sources.length; i++) {
    // Part 10 implementation headers differ; the encoded dataset is unchanged.
    const sourceRecord = archive.listInstances(studyUid,seriesUid)[i], stored = archive.getInstance(studyUid,seriesUid,sourceRecord.sopUid);
    const sourceOffset = await dataSetOffset(stored.path);
    assert.ok(output.includes(sources[i].subarray(sourceOffset)));
  }
});

test('MOVE rejects unconfigured destinations and outgoing storage preserves original datasets', {timeout:15000}, async t => {
  const destination = await setup(t,{aeTitle:'DESTINATION'});
  const source = await setup(t,{resolveMoveDestination:ae => ae === 'DESTINATION' ? destination.association : null});
  const studyUid = uid(); await source.archive.ingest(Readable.from([createDicom({studyUid})]));
  await assert.rejects(transport().read(source.association,{operation:'c-move',performFind:false,studyInstanceUid:studyUid,moveDestinationAeTitle:'UNKNOWN'}), error => error.dimse?.status === 0xa801 || /a801|43009|failed/i.test(error.message));
  // The EASI SCU's MOVE listener is deliberately bypassed: destination must be
  // the configured archive, never a host supplied in the DIMSE request.
  const record = source.archive.queryRecords()[0], stored = source.archive.getInstance(record.studyUid,record.seriesUid,record.sopUid);
  assert.equal((await sendStoredInstance(destination.association,stored)).status,0);
  assert.equal(destination.archive.stats().instances,1);
  const received = destination.archive.getInstance(record.studyUid,record.seriesUid,record.sopUid);
  assert.ok((await readFile(received.path)).subarray(await dataSetOffset(received.path)).equals((await readFile(stored.path)).subarray(await dataSetOffset(stored.path))));
});

test('GET reports failed suboperations when no matching storage transfer syntax was negotiated', {timeout:10000}, async t => {
  const {archive,association} = await setup(t), studyUid = uid();
  await archive.ingest(Readable.from([createDicom({studyUid})]));
  const result = await transport().read(association,{operation:'c-get',performFind:false,studyInstanceUid:studyUid,storageTransferSyntaxUids:['1.2.840.10008.1.2']});
  assert.equal(result.metadata.dimse.finalResponse.status,0xb000); assert.equal(result.metadata.dimse.finalResponse.failed,1); assert.equal(result.metadata.count,0);
});

test('durable C-GET SCU acknowledges only after target catalog commits and survives persistence rejection', {timeout:15000}, async t => {
  const {retrieveToArchive} = await import('../src/dimse/StorageScp.js');
  const source = await setup(t),destination = await setup(t),studyUid = uid(),seriesUid = uid(),sopUid = uid();
  await source.archive.ingest(Readable.from([createDicom({studyUid,seriesUid,sopUid})]));
  let entered,release; const began = new Promise(resolve => {entered=resolve;}),gate = new Promise(resolve => {release=resolve;});
  t.after(() => release());
  const progress = [],target = { async ingest(stream,options) { entered(); await gate; return destination.archive.ingest(stream,options); } };
  const retrieving = retrieveToArchive(source.association,{studyUid,seriesUid,sopUid},target,{onProgress:state => progress.push(state)});
  await began; assert.equal(destination.archive.stats().instances,0);
  assert.equal(await Promise.race([retrieving.then(() => 'done'),new Promise(resolve => setTimeout(() => resolve('waiting'),75))]),'waiting');
  release(); const result = await retrieving;
  assert.equal(result.status,0); assert.equal(result.stored,1); assert.equal(destination.archive.stats().instances,1); assert.equal(progress.at(-1).completed,1);
  const failed = await retrieveToArchive(source.association,{studyUid,seriesUid,sopUid},{ async ingest() { throw new Error('synthetic disk failure'); } });
  assert.equal(failed.status,0xb000); assert.equal(failed.failed,1); assert.equal(failed.stored,0); assert.deepEqual(failed.failedSopInstanceUids,[sopUid]);
});

test('durable C-GET cancellation stops further sub-operations and closes cleanly', {timeout:15000}, async t => {
  const {retrieveToArchive} = await import('../src/dimse/StorageScp.js');
  const source = await setup(t),destination = await setup(t),studyUid = uid(),seriesUid = uid();
  for (let instanceNumber=1;instanceNumber<=8;instanceNumber++) await source.archive.ingest(Readable.from([createDicom({studyUid,seriesUid,instanceNumber})]));
  const controller = new AbortController();
  await assert.rejects(retrieveToArchive(source.association,{studyUid},destination.archive,{signal:controller.signal,onProgress:state => {if(state.completed===1) controller.abort();}}),{name:'AbortError'});
  assert.ok(destination.archive.stats().instances>=1); assert.ok(destination.archive.stats().instances<8);
  const check = await transport().read(source.association,{operation:'c-find',studyInstanceUid:studyUid}); assert.equal(check.metadata.count,1);
});


test('C-MOVE transmits to configured destination and reports completed sub-operations to independent SCU', {timeout:15000}, async t => {
  const probe = net.createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening'); const movePort = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const source = await setup(t,{resolveMoveDestination:ae => ae === 'MOVECLIENT' ? {host:'127.0.0.1',port:movePort,calledAeTitle:'MOVECLIENT'} : null});
  const studyUid = uid(),seriesUid=uid();
  for (let instanceNumber=1;instanceNumber<=3;instanceNumber++) await source.archive.ingest(Readable.from([createDicom({studyUid,seriesUid,instanceNumber})]));
  const result = await transport().read(source.association,{operation:'c-move',performFind:false,studyInstanceUid:studyUid,moveDestinationAeTitle:'MOVECLIENT',moveStorePort:movePort,moveStoreCalledAeTitle:'MOVECLIENT',storageTransferSyntaxUids:['1.2.840.10008.1.2.1']});
  assert.equal(result.metadata.dimse.finalResponse.status,0); assert.equal(result.metadata.dimse.finalResponse.completed,3); assert.equal(result.metadata.count,3);
});

test('GET returns failed UID list for an unreadable original without sending an incomplete storage dataset', {timeout:10000}, async t => {
  const {archive,association} = await setup(t),studyUid=uid(),seriesUid=uid(),sopUid=uid();
  await archive.ingest(Readable.from([createDicom({studyUid,seriesUid,sopUid})]));
  await unlink(archive.getInstance(studyUid,seriesUid,sopUid).path);
  const result = await transport().read(association,{operation:'c-get',performFind:false,studyInstanceUid:studyUid,storageTransferSyntaxUids:['1.2.840.10008.1.2.1']});
  assert.equal(result.metadata.dimse.finalResponse.status,0xb000); assert.deepEqual(result.metadata.dimse.finalResponse.failedSopInstanceUids,[sopUid]);
});


test('C-FIND cancellation returns FE00, requested optional-key warning FF01, and leaves association valid', {timeout:15000}, async t => {
  const source = await setup(t);
  for(let i=0;i<3;i++) await source.archive.ingest(Readable.from([createDicom()]));
  let release; const gate = new Promise(resolve => {release=resolve;}); t.after(() => release());
  const originalRespond = source.scp.respond.bind(source.scp); let blocked = false;
  source.scp.respond = async (...args) => { await originalRespond(...args); if (!blocked && args[4] === 0xff01) { blocked=true; await gate; } };
  const scu=transport(),options=scu.resolveQueryOptions(source.association,{operation:'c-find',queryRetrieveLevel:'STUDY',returnKeys:['StudyInstanceUID','00081080']}),model=scu.resolveQueryModel(options),proposal=scu.buildAssociateRq(source.association,model,options);
  const socket=await scu.connectSocket(source.association,options),scope=scu.createPduReader(socket,options); t.after(() => {scope.cleanup();socket.destroy();});
  await scu.writePdu(socket,proposal.pdu); const ac=await scope.queue.shift(),info=scu.parseAssociateAc(ac.payload,proposal.contexts),pc=scu.resolveAcceptedContextByKind(info.contexts,'find');
  await scu.sendDimseRequest(socket,pc.context.id,info.maxPduLength,commandBytes([[2,text(model.findSopClassUid)],[0x100,u16(0x20)],[0x110,u16(1)],[0x700,u16(0)],[0x800,u16(0)]]),encodeIdentifier({'00080052':'STUDY','0020000D':'','00081080':''},pc.transferSyntaxUid));
  const state={fragments:new Map(),events:[]};
  const first=await scu.nextDimseEvent(scope.queue,state); assert.equal(decodeCommand(Buffer.from(first.bytes)).status,0xff01);
  const identifier=await scu.receiveFindIdentifierDataSet(scope.queue,state,pc.context.id); assert.ok(identifier.length>0);
  await scu.sendDimseRequest(socket,pc.context.id,info.maxPduLength,commandBytes([[0x100,u16(0xfff)],[0x120,u16(1)],[0x800,u16(0x101)]]),null);
  // Let the SCP consume the cancel while its first response is held at the gate.
  await new Promise(resolve => setTimeout(resolve,30)); release();
  const final=await scu.nextDimseEvent(scope.queue,state); assert.equal(decodeCommand(Buffer.from(final.bytes)).status,0xfe00);
  await scu.releaseAssociation(socket,scope.queue,state);
});


for (const conflicting of [false,true]) test(`durable SCU ${conflicting?'rejects contradictory':'accepts identical repeated'} storage role selections`, {timeout:10000}, async t => {
  class RoleFixtureScp extends StorageScp {
    async associate(socket,context,body) {
      const originalWrite=socket.write;
      socket.write=function(chunk,...args) {
        if(chunk[0]===2) {
          const payload=chunk.subarray(6),parts=items(payload,68),user=parts.find(value=>value.type===0x50),sub=items(user.body),role=sub.find(value=>value.type===0x54);
          if(role){const duplicate=Buffer.from(role.body);if(conflicting)duplicate[duplicate.length-1]=0;
            chunk=pdu(2,Buffer.concat([payload.subarray(0,68),...parts.map(value=>value===user?item(0x50,Buffer.concat([...sub.map(part=>item(part.type,part.body)),item(0x54,duplicate)])):item(value.type,value.body))]));}
        }
        return originalWrite.call(this,chunk,...args);
      };
      try {await super.associate(socket,context,body);}finally{socket.write=originalWrite;}
    }
  }
  const source=await setup(t,{Scp:RoleFixtureScp}),target=await setup(t),studyUid=uid();
  await source.archive.ingest(Readable.from([createDicom({studyUid})]));
  const {retrieveToArchive}=await import('../src/dimse/StorageScp.js');
  const operation=retrieveToArchive(source.association,{studyUid,storageSopClassUids:['1.2.840.10008.5.1.4.1.1.2']},target.archive);
  if(conflicting){await assert.rejects(operation,/conflicting role/i);assert.equal(target.archive.stats().instances,0);}
  else{assert.equal((await operation).stored,1);assert.equal(target.archive.stats().instances,1);}
});

test('Patient Root retrieval refuses ambiguous identity namespaces and bounded queries fail explicitly', {timeout:10000}, async t => {
  const source=await setup(t,{maxQueryResults:1}),patientId='SAME-PATIENT-ID';
  for(const issuer of ['ISSUER-A','ISSUER-B'])await source.archive.ingest(Readable.from([createDicom({patientId,issuer})]));
  await assert.rejects(transport().read(source.association,{operation:'c-find',queryRetrieveLevel:'STUDY',keys:{PatientID:patientId}}),error=>error.dimse?.status===0xa700||/failed/i.test(error.message));
  await assert.rejects(transport().read(source.association,{operation:'c-get',performFind:false,queryRetrieveModel:'patient-root',queryRetrieveLevel:'PATIENT',patientId}),error=>error.dimse?.status===0xa900||/failed/i.test(error.message));
});

test('GET refuses missing unique parent keys over the socket', {timeout:10000}, async t => {
  const source=await setup(t),studyUid=uid(),seriesUid=uid(),sopUid=uid();
  await source.archive.ingest(Readable.from([createDicom({studyUid,seriesUid,sopUid})]));
  for(const query of [
    {queryRetrieveLevel:'SERIES',seriesInstanceUid:seriesUid},
    {queryRetrieveLevel:'IMAGE',studyInstanceUid:studyUid,sopInstanceUid:sopUid},
    {queryRetrieveLevel:'STUDY',keys:{StudyInstanceUID:'*'}},
  ])await assert.rejects(transport().read(source.association,{operation:'c-get',performFind:false,...query}),error=>error.dimse?.status===0xa900||/failed/i.test(error.message));
  assert.equal(source.archive.stats().instances,1);
});


for (const mismatched of ['study','series','sop']) test(`durable SCU refuses a peer returning the wrong ${mismatched} before catalog admission`, {timeout:10000}, async t => {
  let foreignPath,foreignSop;
  class IncorrectScopeScp extends StorageScp {
    async getSubOperation(socket,context,record,priority) {return super.getSubOperation(socket,context,{...record,path:foreignPath,...(mismatched==='sop'?{sopUid:foreignSop}:{})},priority);}
  }
  const source=await setup(t,{Scp:IncorrectScopeScp}),target=await setup(t),studyUid=uid(),seriesUid=uid(),sopUid=uid();
  await source.archive.ingest(Readable.from([createDicom({studyUid,seriesUid,sopUid})]));
  foreignSop=uid();foreignPath=join(source.archive.dataDir,'synthetic-incorrect-peer.dcm');
  await writeFile(foreignPath,createDicom({studyUid:mismatched==='study'?uid():studyUid,seriesUid:mismatched==='series'?uid():seriesUid,sopUid:mismatched==='sop'?foreignSop:sopUid}));
  const {retrieveToArchive}=await import('../src/dimse/StorageScp.js');
  const operation=retrieveToArchive(source.association,{studyUid,seriesUid,sopUid},target.archive);
  if(mismatched==='sop')await assert.rejects(operation,/Invalid C-STORE sub-operation/);
  else{const result=await operation;assert.equal(result.status,0xb000);assert.equal(result.failed,1);}
  assert.equal(target.archive.stats().instances,0,'wrong-hierarchy objects must not be committed');
});
