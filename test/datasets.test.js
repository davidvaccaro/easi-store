import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,readFile,writeFile,rm,symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { Archive } from '../src/archive/Archive.js';
import { DatasetService } from '../src/datasets/DatasetService.js';
import { createDicom,uid } from './fixtures/synthetic.js';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(),'easi-store-datasets-test-'));
  let archive = await Archive.open({dataDir}), service = new DatasetService({archive});
  t.after(async () => { await archive.close(); await rm(dataDir,{recursive:true,force:true}); });
  return {dataDir,get archive(){return archive;},get service(){return service;},
    async reopen(){await archive.close();archive=await Archive.open({dataDir});service=new DatasetService({archive});},
    async add(options={},source='upload') {
      return (await archive.ingest(Readable.from([createDicom({rows:4,columns:4,...options})]),{source})).instance;
    }};
}
const selected = (...records) => [...new Map(records.map(row => [row.seriesUid,{studyUid:row.studyUid,seriesUid:row.seriesUid}])).values()];
const split = {seed:'reproducible-research-1',ratios:{train:0.6,validation:0.2,test:0.2}};
const hash = value => createHash('sha256').update(value).digest('hex');

test('named drafts persist, enforce revisions, and require explicit nonempty membership to freeze',async t => {
  const f=await fixture(t), draft=await f.service.create({name:'  Research cohort  ',labels:['research','research'],reviewNotes:'First pass\nSecond pass'});
  assert.equal(draft.name,'Research cohort');assert.deepEqual(draft.labels,['research']);assert.deepEqual(draft.selection,[]);
  assert.equal(f.service.readiness(draft.id).summary.instances,0);
  await assert.rejects(f.service.createSnapshot(draft.id,{revision:1}),{code:'dataset-selection-empty'});
  const instance=await f.add();
  const updated=await f.service.update(draft.id,{revision:1,selection:selected(instance),description:'Selected explicitly'});
  assert.equal(updated.revision,2);
  await assert.rejects(f.service.update(draft.id,{revision:1,name:'Stale'}),{code:'stale-dataset'});
  await assert.rejects(f.service.createSnapshot(draft.id,{revision:1}),{code:'stale-dataset'});
  await f.reopen();
  assert.deepEqual(f.service.get(draft.id),updated);
  assert.equal(f.service.list().total,1);
});

test('immutable versions preserve exact membership, bytes, provenance and portable credential-free routes after later imports/edits/restart',async t => {
  const f=await fixture(t), first=await f.add({patientName:'Private^Person',patientId:'PRIVATE-MRN',seriesDescription:'PRIVATE-DESCRIPTION'},'https://user:password@example.test/private?token=secret');
  const dataset=await f.service.create({name:'PRIVATE-DATASET-TITLE',reviewNotes:'PRIVATE-REVIEW',labels:['PRIVATE-LABEL'],selection:selected(first)});
  const version=await f.service.createSnapshot(dataset.id,{revision:dataset.revision});
  const originalText=f.service.getManifestText(dataset.id,version.version),manifest=JSON.parse(originalText);
  assert.equal(version.manifestSha256,hash(originalText));assert.equal(manifest.schemaVersion,1);assert.equal(manifest.kind,'easi-store-dataset');
  assert.equal(manifest.members.length,1);assert.equal(manifest.split,null);assert.equal(manifest.members[0].partition,null);
  const member=manifest.members[0];
  assert.equal(member.sopUid,first.sopUid);assert.equal(member.sha256,first.sha256);assert.equal(member.bytes,first.bytes);assert.equal(member.sourceKind,'other');
  assert.match(member.sourceRef,/^[a-f0-9]{64}$/);assert.equal(member.role,'image');
  assert.equal(member.originalPath,`/api/v1/datasets/${dataset.id}/versions/1/members/${member.memberId}/original`);
  for (const secret of ['Private^Person','PRIVATE-MRN','PRIVATE-DESCRIPTION','PRIVATE-DATASET-TITLE','PRIVATE-REVIEW','PRIVATE-LABEL','password','example.test','token=secret',f.dataDir,first.patientKey,first.id]) assert.equal(originalText.includes(secret),false,secret);
  const next=await f.add({studyUid:first.studyUid,seriesUid:first.seriesUid,instanceNumber:2,patientId:'PRIVATE-MRN',patientName:'Private^Person'});
  assert.equal(f.service.readiness(dataset.id).summary.instances,2);
  const version2=await f.service.createSnapshot(dataset.id,{revision:1});
  assert.equal(version2.version,2);assert.equal(version2.summary.instances,2);
  assert.equal(f.service.getManifestText(dataset.id,1),originalText);
  await f.service.update(dataset.id,{revision:1,name:'Revised draft',selection:selected(next)});
  await f.reopen();
  assert.equal(f.service.getManifestText(dataset.id,1),originalText);
  assert.equal(f.service.get(dataset.id).versions.length,2);
  const stored=f.service.getMember(dataset.id,1,member.memberId);
  assert.equal(hash(await readFile(stored.path)),member.sha256);
});

test('seeded splits group all studies of a known subject and preserve assignments across immutable versions',async t => {
  const f=await fixture(t), instances=[];
  for(let i=0;i<24;i++) {
    instances.push(await f.add({patientId:`subject-${i}`,issuer:'Issuer-A'},'source-a'));
    instances.push(await f.add({patientId:`subject-${i}`,issuer:'Issuer-A'},'source-b'));
  }
  const dataset=await f.service.create({name:'Grouped cohort',selection:selected(...instances)});
  const a=await f.service.createSnapshot(dataset.id,{revision:1,split}), b=await f.service.createSnapshot(dataset.id,{revision:1,split});
  const ma=f.service.getManifest(dataset.id,a.version), mb=f.service.getManifest(dataset.id,b.version);
  assert.equal(ma.summary.subjects,24);assert.equal(ma.summary.studies,48);
  const bySubject=new Map();
  for(const member of ma.members) {
    if(bySubject.has(member.subjectId))assert.equal(member.partition,bySubject.get(member.subjectId));
    bySubject.set(member.subjectId,member.partition);
    const other=mb.members.find(row=>row.sopUid===member.sopUid);
    assert.equal(other.subjectId,member.subjectId);assert.equal(other.partition,member.partition);
  }
  assert.equal(Object.values(a.split.counts).reduce((sum,value)=>sum+value,0),24);
  assert.equal(a.split.counts.train,[...bySubject.values()].filter(value=>value==='train').length);
  await f.service.createSnapshot(dataset.id,{revision:1,split:{...split,seed:'another-seed'}});
  const mc=f.service.getManifest(dataset.id,3);
  assert.ok(mc.members.some(member=>member.partition!==ma.members.find(row=>row.sopUid===member.sopUid).partition));
  const extra=await f.add({patientId:'new-subject'});
  await f.service.update(dataset.id,{revision:1,selection:selected(...instances,extra)});
  await f.service.createSnapshot(dataset.id,{revision:2,split});
  for(const member of f.service.getManifest(dataset.id,4).members.filter(row=>row.sopUid!==extra.sopUid)) assert.equal(member.partition,bySubject.get(member.subjectId));
});

test('issuer/source identity remains scoped and missing identity/small splits have explicit limitations',async t => {
  const f=await fixture(t), records=[];
  records.push(await f.add({patientId:'42',issuer:'A'},'a'));
  records.push(await f.add({patientId:'42',issuer:'B'},'a'));
  records.push(await f.add({patientId:'42',issuer:''},'a'));
  records.push(await f.add({patientId:'42',issuer:''},'b'));
  records.push(await f.add({patientId:'',issuer:''},'a'));
  records.push(await f.add({patientId:'',issuer:''},'a'));
  const dataset=await f.service.create({name:'Scope',selection:selected(...records)});
  const readiness=f.service.readiness(dataset.id);
  assert.equal(readiness.summary.subjects,6);
  assert.equal(readiness.warnings.find(row=>row.code==='source-scoped-subjects').count,2);
  assert.equal(readiness.warnings.find(row=>row.code==='unknown-subject-identity').count,2);
  assert.ok(readiness.limitations.some(value=>value.includes('does not establish clinical identity')));
  const one=await f.service.create({name:'Small',selection:selected(records[0])});
  await f.service.createSnapshot(one.id,{revision:1,split});
  assert.ok(f.service.getManifest(one.id,1).warnings.some(row=>row.code==='empty-split-partitions'));
});

test('technical readiness exposes metadata heterogeneity without interpreting selected SEG/SR objects or inventing labels',async t => {
  const f=await fixture(t), a=await f.add({rows:4,columns:4,instanceNumber:1,seriesDescription:'Readable series'});
  await f.add({studyUid:a.studyUid,seriesUid:a.seriesUid,rows:8,columns:4,instanceNumber:1,modality:'MR',seriesDescription:'Readable series'});
  const seg=await f.add({sopClassUid:'1.2.840.10008.5.1.4.1.1.66.4',modality:'SEG'});
  const sr=await f.add({sopClassUid:'1.2.840.10008.5.1.4.1.1.88.33',modality:'SR'});
  const unknown=await f.add({sopClassUid:'2.25.999999',modality:'OT'});
  const dataset=await f.service.create({name:'Inventory',selection:selected(a,seg,sr,unknown),labels:['not-ground-truth']});
  const readiness=f.service.readiness(dataset.id), image=readiness.series.find(row=>row.seriesUid===a.seriesUid);
  assert.deepEqual(image.rows,[4,8]);assert.equal(image.instances,2);assert.equal(image.seriesDescription,'Readable series');
  for(const code of ['mixed-image-dimensions','mixed-modalities','repeated-instance-numbers'])assert.ok(image.warnings.some(row=>row.code===code));
  await f.service.createSnapshot(dataset.id,{revision:1});
  const manifest=f.service.getManifest(dataset.id,1);
  assert.deepEqual(new Set(manifest.members.map(row=>row.role)),new Set(['image','segmentation','structured-report','other']));
  assert.ok(manifest.warnings.some(row=>row.code==='mixed-image-dimensions' && row.count===1));
  assert.equal(JSON.stringify(manifest).includes('not-ground-truth'),false);
  assert.ok(manifest.limitations.some(value=>value.includes('without interpreting annotations')));
});

test('availability distinguishes verified originals, missing files and same-size corruption without changing a frozen manifest',async t => {
  const f=await fixture(t), a=await f.add(),b=await f.add(),c=await f.add();
  const dataset=await f.service.create({name:'Availability',selection:selected(a,b,c)});
  await f.service.createSnapshot(dataset.id,{revision:1});
  const before=f.service.getManifestText(dataset.id,1),manifest=JSON.parse(before),members=manifest.members;
  let result=await f.service.checkAvailability(dataset.id,1);
  assert.equal(result.verified,false);assert.equal(result.summary.available,3);assert.ok(result.items.every(row=>row.verified===false));
  result=await f.service.checkAvailability(dataset.id,1,{verifyHashes:true});
  assert.equal(result.verified,true);assert.equal(result.summary.available,3);
  const pathFor=sop=>f.service.getMember(dataset.id,1,members.find(row=>row.sopUid===sop).memberId).path;
  await rm(pathFor(a.sopUid));
  const altered=await readFile(pathFor(b.sopUid));altered[altered.length-1]^=1;await writeFile(pathFor(b.sopUid),altered);
  const quick=await f.service.checkAvailability(dataset.id,1);assert.equal(quick.summary.available,2);assert.equal(quick.summary.missing,1);
  result=await f.service.checkAvailability(dataset.id,1,{verifyHashes:true});
  assert.deepEqual(result.summary,{total:3,available:1,missing:1,changed:1,unreadable:0});assert.equal(result.verified,false);
  assert.equal(f.service.getManifestText(dataset.id,1),before);
  assert.equal(f.archive.readLeases.size,0);
});

test('snapshots survive study removal and reject catalog replacement, including byte-identical reingestion under a new archive record',async t => {
  const f=await fixture(t), options={rows:4,columns:4,sopUid:uid(),seriesUid:uid(),studyUid:uid()}, original=await f.add(options);
  const dataset=await f.service.create({name:'Retention',selection:selected(original)});
  await f.service.createSnapshot(dataset.id,{revision:1});
  const manifest=f.service.getManifest(dataset.id,1),member=manifest.members[0];
  const preview=f.archive.deletion.preview(original.studyUid);
  await f.archive.deletion.remove(original.studyUid,{confirmation:'DELETE',revision:preview.revision});
  assert.equal((await f.service.checkAvailability(dataset.id,1)).summary.missing,1);
  assert.throws(()=>f.service.getMember(dataset.id,1,member.memberId),{code:'dataset-member-missing',statusCode:410});
  const reingested=await f.add(options);assert.equal(reingested.sha256,original.sha256);assert.notEqual(reingested.id,original.id);
  assert.equal((await f.service.checkAvailability(dataset.id,1)).summary.changed,1);
  assert.throws(()=>f.service.getMember(dataset.id,1,member.memberId),{code:'dataset-member-changed',statusCode:409});
  assert.deepEqual(f.service.getManifest(dataset.id,1),manifest);
});

test('hash verification refuses symlink originals and reports no filesystem paths',async t => {
  const f=await fixture(t), a=await f.add(),dataset=await f.service.create({name:'Protected originals',selection:selected(a)});
  await f.service.createSnapshot(dataset.id,{revision:1});
  const member=f.service.getManifest(dataset.id,1).members[0],path=f.service.getMember(dataset.id,1,member.memberId).path;
  const backup=join(f.dataDir,'private-backup');await writeFile(backup,await readFile(path));await rm(path);await symlink(backup,path);
  const result=await f.service.checkAvailability(dataset.id,1,{verifyHashes:true});
  assert.equal(result.summary.unreadable,1);assert.equal(JSON.stringify(result).includes(f.dataDir),false);
});

test('verification reserves a read lease, prevents deletion, and releases on cancellation',async t => {
  const f=await fixture(t), a=await f.add(),dataset=await f.service.create({name:'Cancellation',selection:selected(a)});
  await f.service.createSnapshot(dataset.id,{revision:1});
  let started,release;const entered=new Promise(resolve=>{started=resolve;}),pause=new Promise(resolve=>{release=resolve;});
  const inspect=f.service.inspectObject.bind(f.service);
  f.service.inspectObject=async(...args)=>{started();await pause;return inspect(...args);};
  const controller=new AbortController(),operation=f.service.checkAvailability(dataset.id,1,{verifyHashes:true,signal:controller.signal});
  await entered;assert.equal(f.archive.readLeases.size,1);
  const preview=f.archive.deletion.preview(a.studyUid);
  await assert.rejects(f.archive.deletion.remove(a.studyUid,{confirmation:'DELETE',revision:preview.revision}),{code:'archive-read-active'});
  controller.abort();release();await assert.rejects(operation,{name:'AbortError'});assert.equal(f.archive.readLeases.size,0);
  assert.equal(f.service.getManifest(dataset.id,1).members.length,1);
});

test('failed membership transaction rolls back its version and subject IDs, and a later snapshot succeeds',async t => {
  const f=await fixture(t), a=await f.add(),dataset=await f.service.create({name:'Atomicity',selection:selected(a)});
  f.archive.db.exec("CREATE TRIGGER dataset_test_failure BEFORE INSERT ON dataset_members BEGIN SELECT RAISE(ABORT,'simulated disk write failure'); END");
  await assert.rejects(f.service.createSnapshot(dataset.id,{revision:1}),/simulated disk write failure/);
  assert.equal(f.service.get(dataset.id).versions.length,0);
  assert.equal(f.archive.db.prepare('SELECT COUNT(*) AS count FROM dataset_subjects').get().count,0);
  assert.equal(f.archive.readLeases.size,0);
  f.archive.db.exec('DROP TRIGGER dataset_test_failure');
  assert.equal((await f.service.createSnapshot(dataset.id,{revision:1})).version,1);
});

test('strict schemas reject SQL-shaped identifiers, unknown fields, invalid splits and excessive inputs without persisting data',async t => {
  const f=await fixture(t), a=await f.add();
  const bad=[null,[],{name:'A',path:'/tmp/data'},{name:'A',selection:[{studyUid:a.studyUid,seriesUid:"1' OR 1=1"}]},
    {name:'A',selection:[...selected(a),...selected(a)]},{name:'A',selection:Array.from({length:1001},()=>selected(a)[0])},
    {name:'A',labels:Array(33).fill('x')},{name:'A',nameExtra:'hidden'},Object.create({name:'inherited'}),
    {name:'A'.repeat(121)},{name:'A\0B'},{name:'A',selection:[{...selected(a)[0],url:'https://example.test'}]}];
  for(const input of bad) await assert.rejects(f.service.create(input),{statusCode:400});
  let touched=false;const getter={get name(){touched=true;return 'secret';}};
  await assert.rejects(f.service.create(getter),{statusCode:400});assert.equal(touched,false);
  const symbol={name:'A',[Symbol('secret')]:true};await assert.rejects(f.service.create(symbol),{statusCode:400});
  assert.equal(f.service.list().total,0);
  const dataset=await f.service.create({name:'Valid',selection:selected(a)});
  for(const invalid of [{seed:'',ratios:{train:0.7,validation:0.2,test:0.1}},
    {seed:'x',ratios:{train:NaN,validation:0.2,test:0.8}},{seed:'x',ratios:{train:0.7,validation:0.2,test:0.2}},
    {seed:'x',ratios:{train:1,validation:0,test:0}},{seed:'x',ratios:{train:0.7,val:0.2,test:0.1}},
    {seed:'x',ratios:{train:0.7,validation:0.2,test:0.1},endpoint:'https://example.test'}]) await assert.rejects(f.service.createSnapshot(dataset.id,{revision:1,split:invalid}),{statusCode:400});
  for(const version of [0,-1,1.5,'1',101])assert.throws(()=>f.service.getManifest(dataset.id,version),{statusCode:400});
  assert.throws(()=>f.service.get("' OR 1=1"),{statusCode:400});
  assert.equal(f.service.get(dataset.id).versions.length,0);
});

test('queued writes bind caller data before yielding and respect archive mutation/close gates',async t => {
  const f=await fixture(t), a=await f.add(),dataset=await f.service.create({name:'Queue',selection:selected(a)});
  let release;const blocked=new Promise(resolve=>{release=resolve;});f.archive.queue=blocked;
  const input={revision:1,name:'Bound name'},pending=f.service.update(dataset.id,input);input.revision=99;input.name='Changed afterwards';release();
  assert.equal((await pending).name,'Bound name');
  f.archive.recoveryRequired=true;
  await assert.rejects(f.service.create({name:'Blocked'}),{code:'recovery-required'});
  assert.equal(f.archive.readLeases.size,0);f.archive.recoveryRequired=false;
  await f.archive.close();
  assert.throws(()=>f.service.list(),{code:'closing'});
});

test('tampered frozen record paths are rejected before resolving an original',async t => {
  const f=await fixture(t),a=await f.add(),dataset=await f.service.create({name:'Internal integrity',selection:selected(a)});
  await f.service.createSnapshot(dataset.id,{revision:1});const member=f.service.getManifest(dataset.id,1).members[0];
  f.archive.db.prepare('UPDATE dataset_members SET record=? WHERE datasetId=?').run(JSON.stringify({...f.service.memberRecord(dataset.id,1,member.memberId),objectKey:'../../private'}),dataset.id);
  assert.throws(()=>f.service.getMember(dataset.id,1,member.memberId),{code:'dataset-catalog-invalid'});
  await assert.rejects(f.service.checkAvailability(dataset.id,1),{code:'dataset-catalog-invalid'});assert.equal(f.archive.readLeases.size,0);
});

test('explicit revision-checked dataset removal reclaims metadata capacity while preserving all archived originals',async t => {
  const f=await fixture(t),a=await f.add(),dataset=await f.service.create({name:'Remove metadata',selection:selected(a)});
  await f.service.createSnapshot(dataset.id,{revision:1});
  const member=f.service.getManifest(dataset.id,1).members[0],path=f.service.getMember(dataset.id,1,member.memberId).path;
  await assert.rejects(f.service.remove(dataset.id,{revision:1,confirmation:'DELETE'}),{statusCode:400});
  await f.service.update(dataset.id,{revision:1,name:'New revision'});
  await assert.rejects(f.service.remove(dataset.id,{revision:1,confirmation:'DELETE DATASET'}),{code:'stale-dataset'});
  assert.deepEqual(await f.service.remove(dataset.id,{revision:2,confirmation:'DELETE DATASET'}),{removed:true,originalsRemoved:false});
  for(const table of ['datasets','dataset_members','dataset_subjects','dataset_versions']) assert.equal(f.archive.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,0);
  assert.throws(()=>f.service.getManifest(dataset.id,1),{code:'dataset-not-found'});
  assert.throws(()=>f.service.getMember(dataset.id,1,member.memberId),{code:'dataset-not-found'});
  assert.equal(f.archive.getInstance(a.studyUid,a.seriesUid,a.sopUid).sha256,member.sha256);
  assert.equal(hash(await readFile(path)),member.sha256);
});

test('immutable version cap is enforced before persistence and explicit metadata removal recovers capacity',async t => {
  const f=await fixture(t),a=await f.add(),dataset=await f.service.create({name:'Bounded history',selection:selected(a)});
  for(let i=1;i<=100;i++)assert.equal((await f.service.createSnapshot(dataset.id,{revision:1})).version,i);
  await assert.rejects(f.service.createSnapshot(dataset.id,{revision:1}),{statusCode:413,code:'dataset-version-limit'});
  assert.equal(f.service.get(dataset.id).versions.length,100);
  assert.equal(f.archive.db.prepare('SELECT COUNT(*) AS count FROM dataset_members').get().count,100);
  await f.service.remove(dataset.id,{revision:1,confirmation:'DELETE DATASET'});
  const fresh=await f.service.create({name:'New history',selection:selected(a)});
  assert.equal((await f.service.createSnapshot(fresh.id,{revision:1})).version,1);
});

test('source provenance records configured transport kind while excluding connection addresses and credentials',async t => {
  const f=await fixture(t),connectionId='b9152afb-5c7f-424e-b124-f49bbcbaf444';
  f.archive.db.exec('CREATE TABLE connections (id TEXT PRIMARY KEY,config TEXT NOT NULL)');
  f.archive.db.prepare('INSERT INTO connections VALUES (?,?)').run(connectionId,JSON.stringify({type:'dicomweb',baseUrl:'https://private-source.test',credentialId:'private-token-name'}));
  const a=await f.add({},`connection:${connectionId}`),dataset=await f.service.create({name:'Transport provenance',selection:selected(a)});
  await f.service.createSnapshot(dataset.id,{revision:1});
  const text=f.service.getManifestText(dataset.id,1),manifest=JSON.parse(text);
  assert.equal(manifest.members[0].sourceKind,'dicomweb');
  for(const hidden of [connectionId,'private-source.test','private-token-name'])assert.equal(text.includes(hidden),false);
  f.archive.db.prepare('DELETE FROM connections').run();
  assert.equal(f.service.getManifest(dataset.id,1).members[0].sourceKind,'dicomweb');
});

test('manifest retrieval rejects altered stored bytes instead of publishing a new digest for an immutable version',async t => {
  const f=await fixture(t),a=await f.add(),dataset=await f.service.create({name:'Manifest integrity',selection:selected(a)});
  const version=await f.service.createSnapshot(dataset.id,{revision:1});
  const manifest=f.service.getManifest(dataset.id,1);manifest.members[0].sha256='a'.repeat(64);
  f.archive.db.prepare('UPDATE dataset_versions SET manifest=? WHERE datasetId=? AND version=?').run(JSON.stringify(manifest),dataset.id,1);
  assert.equal(f.service.get(dataset.id).versions[0].manifestSha256,version.manifestSha256);
  assert.throws(()=>f.service.getManifestText(dataset.id,1),{statusCode:503,code:'dataset-manifest-integrity'});
  assert.throws(()=>f.service.getManifest(dataset.id,1),{code:'dataset-manifest-integrity'});
});
