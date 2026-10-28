import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {RelatedReader,parseRelatedType} from '../src/dicomweb/multipart.js';
const uuid='126ac881-862d-4d35-a39a-76159c2b8e79';
const qualified=`${uuid}-${uuid}`;
const media=boundary=>`multipart/related; type="application/dicom"; boundary="${boundary}"`;

test('multipart accepts standard70-byte boundaries and only the fixed repeated-UUID73-byte compatibility pattern beyond that bound',()=>{
  for(const boundary of ['standard-boundary','a'.repeat(70),qualified,qualified.toUpperCase()])assert.equal(parseRelatedType(media(boundary)),boundary);
  for(const boundary of ['a'.repeat(71),'a'.repeat(72),'a'.repeat(73),'a'.repeat(74),qualified+'x',qualified.slice(1),`${uuid}-126ac881-862d-4d35-a39a-76159c2b8e70`,`${uuid}-${uuid.toUpperCase()}`])
    assert.throws(()=>parseRelatedType(media(boundary)),{statusCode:415,code:'unsupported-media-type'});
  for(const boundary of [qualified+'\r\nInjected: yes',qualified+' ',qualified.replace('-','/'),qualified.replace('1','x')])assert.throws(()=>parseRelatedType(media(boundary)),{statusCode:415});
  assert.throws(()=>parseRelatedType(`multipart/related;type="application/json";boundary="${qualified}"`),{statusCode:415});
});

test('the qualified Orthanc delimiter streams across every byte split without changing binary payloads or accepting a false closing prefix',async()=>{
  const original=Buffer.concat([Buffer.from([0,255,1]),Buffer.from(`\r\n--${qualified}XY is binary data`),Buffer.from([128,0,42])]);
  const encoded=Buffer.concat([Buffer.from(`--${qualified}\r\nContent-Type: application/dicom\r\n\r\n`),original,Buffer.from(`\r\n--${qualified}--\r\n`)]);
  const reader=new RelatedReader(Readable.from(Array.from(encoded,value=>Buffer.from([value]))),parseRelatedType(media(qualified)));
  let parts=0;for await(const part of reader.parts()){parts++;assert.equal(part.headers['content-type'],'application/dicom');const chunks=[];for await(const bytes of part.body)chunks.push(bytes);assert.deepEqual(Buffer.concat(chunks),original);}
  assert.equal(parts,1);
});

test('the boundary compatibility exception preserves body, header and truncation limits',async()=>{
  const start=Buffer.from(`--${qualified}\r\nContent-Type: application/dicom\r\n\r\n`);
  async function consume(reader){for await(const part of reader.parts())for await(const bytes of part.body)void bytes;}
  await assert.rejects(consume(new RelatedReader(Readable.from([start,Buffer.alloc(1000)]),qualified,{maxBytes:100})),{statusCode:413,code:'request-too-large'});
  await assert.rejects(consume(new RelatedReader(Readable.from([Buffer.from(`--${qualified}\r\n`+'X'.repeat(17000))]),qualified)),{statusCode:400});
  await assert.rejects(consume(new RelatedReader(Readable.from([start,Buffer.from('truncated')]),qualified)),{statusCode:400});
});
