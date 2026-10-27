import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { get } from 'node:http';
import { createHash } from 'node:crypto';
import { createStoreServer } from '../src/server.js';
import { Archive } from '../src/archive/Archive.js';
import { createDicom, uid } from './fixtures/synthetic.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function setup(t) {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'easi-store-dataset-http-'));
    const app = await createStoreServer({ dataDir, port: 0, accessProfile: 'local-research' });
    const {port} = await app.listen(), base = `http://127.0.0.1:${port}`;
    t.after(async () => { await app.close(); await rm(dataDir, {recursive:true,force:true}); });
    const response = await fetch(base+'/api/v1/setup', {method:'POST',headers:{'X-EASI-Store':'1','Content-Type':'application/json'},body:JSON.stringify({username:'synthetic',password:'synthetic-dataset-http'})});
    assert.equal(response.status,200);
    const headers = {Cookie:response.headers.get('set-cookie').split(';')[0]};
    const request = (p, method='GET', body, extra={}) => fetch(base+'/api/v1'+p,{method,headers:{...headers,...(method==='GET'?{}:{'X-EASI-Store':'1','Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {app,dataDir,base,headers,request};
}
async function freeze(c, bytes=createDicom()) {
    const {instance}=await c.app.archive.ingest(Readable.from([bytes]));
    const created=await c.request('/datasets','POST',{name:'Generated research dataset',labels:['review'],reviewNotes:'Local organizational notes',selection:[{studyUid:instance.studyUid,seriesUid:instance.seriesUid}]});
    assert.equal(created.status,201);const dataset=await created.json();
    const response=await c.request(`/datasets/${dataset.id}/versions`,'POST',{revision:dataset.revision});assert.equal(response.status,201);const snapshot=await response.json();
    const resource=`/datasets/${dataset.id}/versions/${snapshot.version}`;
    const manifestResponse=await c.request(resource+'/manifest');assert.equal(manifestResponse.status,200);const text=await manifestResponse.text(),manifest=JSON.parse(text);
    return {instance,bytes,dataset,snapshot,resource,manifest,text};
}

test('dataset management is protected, freezes exact authenticated originals and purges only dataset metadata',async t=>{
    const c=await setup(t), f=await freeze(c,createDicom({patientName:'Private^Synthetic',patientId:'PRIVATE-MRN',studyDescription:'Private descriptive text'}));
    for(const resource of ['/datasets',`/datasets/${f.dataset.id}`,f.resource+'/manifest','/dataset-tools/download_dataset.py']) assert.equal((await fetch(c.base+'/api/v1'+resource)).status,401);
    assert.equal((await c.request('/datasets','POST',{name:'Blocked'}, {Origin:'https://untrusted.invalid'})).status,403);
    assert.equal((await c.request(`/datasets/${f.dataset.id}`,'PUT',{revision:f.dataset.revision+1,name:'Stale'})).status,409);
    assert.ok(!f.text.includes('Private^Synthetic')&&!f.text.includes('PRIVATE-MRN')&&!f.text.includes('Private descriptive text')&&!f.text.includes('Local organizational notes'));
    const response=await c.request(f.resource+'/manifest');assert.equal(response.headers.get('x-easi-manifest-sha256'),hash(Buffer.from(f.text)));assert.equal(hash(Buffer.from(await response.text())),f.snapshot.manifestSha256);
    const member=f.manifest.members[0],original=await fetch(c.base+member.originalPath,{headers:c.headers});assert.equal(original.status,200);assert.equal(original.headers.get('etag'),`"sha256-${member.sha256}"`);assert.deepEqual(Buffer.from(await original.arrayBuffer()),f.bytes);
    const availability=await c.request(f.resource+'/availability','POST',{verifyHashes:true});assert.equal(availability.status,200);const checked=await availability.json();assert.equal(checked.summary.available,1);assert.equal(checked.summary.changed,0);
    assert.equal((await c.request(f.resource+'/availability','POST',{verifyHashes:'yes'})).status,400);
    const python=await c.request('/dataset-tools/download_dataset.py');assert.equal(python.status,200);assert.match(python.headers.get('content-disposition'),/attachment/);assert.match(await python.text(),/hashlib/);
    assert.equal((await c.request(`/datasets/${f.dataset.id}`,'DELETE',{revision:f.dataset.revision,confirmation:'DELETE'})).status,400);
    const removed=await c.request(`/datasets/${f.dataset.id}`,'DELETE',{revision:f.dataset.revision,confirmation:'DELETE DATASET'});assert.equal(removed.status,200);assert.equal((await removed.json()).originalsRemoved,false);
    assert.equal((await c.request(f.resource+'/manifest')).status,404);assert.equal(c.app.archive.stats().instances,1);
    assert.deepEqual(await readFile(c.app.archive.getInstance(f.instance.studyUid,f.instance.seriesUid,f.instance.sopUid).path),f.bytes);
});

test('frozen HTTP membership never expands or substitutes a deleted/reimported UID',async t=>{
    const c=await setup(t),studyUid=uid(),seriesUid=uid(),sopUid=uid();const f=await freeze(c,createDicom({studyUid,seriesUid,sopUid}));
    await c.app.archive.ingest(Readable.from([createDicom({studyUid,seriesUid})]));
    assert.equal(await(await c.request(f.resource+'/manifest')).text(),f.text);
    const preview=c.app.archive.previewStudyDeletion(studyUid);await c.app.archive.deleteStudy(studyUid,{confirmation:'DELETE',revision:preview.revision});
    assert.equal((await fetch(c.base+f.manifest.members[0].originalPath,{headers:c.headers})).status,410);
    const check=await(await c.request(f.resource+'/availability','POST',{})).json();assert.equal(check.summary.missing,1);
    await c.app.archive.ingest(Readable.from([createDicom({studyUid,seriesUid,sopUid,instanceNumber:99})]));
    assert.equal((await fetch(c.base+f.manifest.members[0].originalPath,{headers:c.headers})).status,409);
    assert.equal(await(await c.request(f.resource+'/manifest')).text(),f.text);
});

test('a paused snapshot original protects study removal and cannot retain its lease across shutdown',{timeout:15000},async t=>{
    const c=await setup(t),f=await freeze(c,createDicom({rows:512,columns:512,frames:32}));
    let request,response; t.after(()=>{response?.destroy();request?.destroy();});
    response=await new Promise((resolve,reject)=>{request=get(c.base+f.manifest.members[0].originalPath,{headers:c.headers},incoming=>{incoming.on('error',()=>{});incoming.pause();resolve(incoming);});request.on('error',reject);});
    assert.equal(response.statusCode,200);await new Promise(resolve=>setTimeout(resolve,50));assert.equal(c.app.archive.readLeases.size,1);
    const preview=c.app.archive.previewStudyDeletion(f.instance.studyUid);await assert.rejects(c.app.archive.deleteStudy(f.instance.studyUid,{confirmation:'DELETE',revision:preview.revision}),{statusCode:409});
    let timer;try{await Promise.race([c.app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Dataset response retained a shutdown lease.')),3000);})]);}finally{clearTimeout(timer);}
    assert.equal(c.app.archive.readLeases.size,0);const reopened=await Archive.open({dataDir:c.dataDir});try{assert.equal(reopened.stats().instances,1);}finally{await reopened.close();}
});

test('generated research cohort uses ordinary durable originals and provides six subjects for explicit splits',async t=>{
    const c=await setup(t);assert.equal((await fetch(c.base+'/api/v1/datasets/demo',{method:'POST',headers:{'X-EASI-Store':'1','Content-Type':'application/json'},body:'{}'})).status,401);
    const response=await c.request('/datasets/demo','POST',{});assert.equal(response.status,201);const dataset=await response.json();
    const review=await(await c.request(`/datasets/${dataset.id}/readiness`)).json();assert.equal(review.summary.subjects,6);assert.equal(review.summary.studies,12);assert.equal(review.summary.series,12);assert.equal(review.summary.instances,36);
    assert.equal(c.app.archive.stats().instances,36);assert.ok(dataset.labels.includes('synthetic'));
    const frozen=await c.request(`/datasets/${dataset.id}/versions`,'POST',{revision:dataset.revision,split:{seed:'generated-research',ratios:{train:.6,validation:.2,test:.2}}});assert.equal(frozen.status,201);const version=await frozen.json();
    assert.equal(version.summary.subjects,6);assert.equal(Object.values(version.split.counts).reduce((a,b)=>a+b),6);
});
