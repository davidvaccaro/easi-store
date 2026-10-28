import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {execFile as execute} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Archive} from '../src/archive/Archive.js';
import {DatasetService} from '../src/datasets/DatasetService.js';
import {createDicom} from './fixtures/synthetic.js';
const execFile=promisify(execute),cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));

test('verified full backup restores frozen dataset bytes, subject references and exact original access',async t=>{
    const root=await mkdtemp(path.join(tmpdir(),'easi-store-dataset-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));
    const source=path.join(root,'source'),backup=path.join(root,'backup'),restored=path.join(root,'restored');
    let archive=await Archive.open({dataDir:source});const bytes=createDicom(),{instance}=await archive.ingest(Readable.from([bytes]));
    const service=new DatasetService({archive}),dataset=await service.create({name:'Generated research backup',selection:[{studyUid:instance.studyUid,seriesUid:instance.seriesUid}],labels:['synthetic'],reviewNotes:'Preserve this private review note.'});
    const version=await service.createSnapshot(dataset.id,{revision:dataset.revision}),text=service.getManifestText(dataset.id,version.version),member=JSON.parse(text).members[0];
    await archive.close();
    await execFile(process.execPath,[cli,'backup','--data-dir',source,'--output',backup]);
    await execFile(process.execPath,[cli,'restore','--input',backup,'--data-dir',restored]);
    archive=await Archive.open({dataDir:restored});
    try {
        const restoredService=new DatasetService({archive});assert.equal(restoredService.getManifestText(dataset.id,1),text);
        assert.equal(restoredService.get(dataset.id).reviewNotes,dataset.reviewNotes);assert.equal(restoredService.get(dataset.id).versions[0].manifestSha256,version.manifestSha256);
        assert.deepEqual(await readFile(restoredService.getMember(dataset.id,1,member.memberId).path),bytes);
        const available=await restoredService.checkAvailability(dataset.id,1,{verifyHashes:true});assert.equal(available.summary.available,1);assert.equal(available.summary.changed,0);
        const second=await restoredService.createSnapshot(dataset.id,{revision:dataset.revision});assert.equal(second.version,2);assert.equal(restoredService.getManifest(dataset.id,2).members[0].subjectId,member.subjectId);
        assert.equal(restoredService.getManifestText(dataset.id,1),text);assert.equal(archive.db.prepare('PRAGMA user_version').get().user_version,3);
    } finally {await archive.close();}
});
