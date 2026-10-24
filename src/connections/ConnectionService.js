import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import EASI from '@xinonix/easi-js';
import { NodeDimseQueryRetrieveSourceTransport } from '@xinonix/easi-js/dimse/node';
import { validUid } from '../archive/errors.js';
import { httpError, json, readJson } from '../http/utils.js';
import { RelatedReader, parseRelatedType } from '../dicomweb/multipart.js';
import { TransferQueue } from '../jobs/TransferQueue.js';

const queryKeys = new Set(['PatientName', 'PatientID', 'IssuerOfPatientID', 'PatientBirthDate', 'StudyDate', 'StudyDescription', 'AccessionNumber', 'ModalitiesInStudy', 'StudyInstanceUID']);
const returnKeys = ['StudyInstanceUID','PatientID','PatientName','StudyDate','StudyDescription','ModalitiesInStudy','NumberOfStudyRelatedSeries','NumberOfStudyRelatedInstances'];
const storageSyntaxes=['1.2.840.10008.1.2','1.2.840.10008.1.2.1','1.2.840.10008.1.2.2','1.2.840.10008.1.2.5','1.2.840.10008.1.2.4.50','1.2.840.10008.1.2.4.51','1.2.840.10008.1.2.4.57','1.2.840.10008.1.2.4.70','1.2.840.10008.1.2.4.80','1.2.840.10008.1.2.4.81','1.2.840.10008.1.2.4.90','1.2.840.10008.1.2.4.91'];
const tagKeys = { patientName:'00100010',patientId:'00100020',studyDate:'00080020',studyDescription:'00081030',studyUid:'0020000D',seriesUid:'0020000E',sopUid:'00080018',sopClassUid:'00080016',modalities:'00080061' };
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, max, label) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw httpError(400, `Invalid ${label}.`); return value.trim(); }
function ae(value, label) { value = text(value,16,label); if (/[^\x20-\x7e]|\\/.test(value)) throw httpError(400,`Invalid ${label}.`); return value; }
function isLoopback(host) { return ['localhost','127.0.0.1','[::1]','::1'].includes(host.toLowerCase()); }
function publicStudy(metadata) {
  const result = {};
  for (const [key,tag] of Object.entries(tagKeys)) {
    const values = metadata[tag]?.Value || [];
    result[key] = key === 'modalities' ? values.map(String) : String(typeof values[0] === 'object' ? values[0]?.Alphabetic || '' : values[0] ?? '');
  }
  result.seriesCount = Number(metadata['00201206']?.Value?.[0]) || 0;
  result.instanceCount = Number(metadata['00201208']?.Value?.[0]) || 0;
  return result;
}
function identifierValue(instance,tag) {
  const attribute=instance.dataSet.attributes.find(attribute=>attribute.tag.ID===tag);
  if(!attribute)return '';
  const charset=instance.dataSet.attributes.find(attribute=>attribute.tag.ID==='00080005');
  const declared=charset ? new TextDecoder().decode(charset.access()).trim() : '';
  const encoding={'ISO_IR 100':'windows-1252','ISO_IR 192':'utf-8','ISO_IR 6':'utf-8','':'utf-8'}[declared]||'utf-8';
  return new TextDecoder(encoding).decode(attribute.access()).replace(/\0/g,'').trim();
}
async function limitedJson(response, limit = 4 * 1024 * 1024) {
  const chunks = []; let size = 0;
  if (!response.body) throw httpError(502,'The peer returned an empty response.');
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw httpError(502,'The peer response exceeds the configured metadata limit.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(502,'The peer did not return valid JSON.'); }
}
function checkedSelection(selection) {
  if (!plainObject(selection) || !validUid(selection.studyUid)) throw httpError(400,'Select a valid study UID.');
  if (selection.seriesUid != null && !validUid(selection.seriesUid) || selection.sopUid != null && (!selection.seriesUid || !validUid(selection.sopUid))) throw httpError(400,'Invalid series or instance selection.');
  if (Object.keys(selection).some(key => !['studyUid','seriesUid','sopUid'].includes(key))) throw httpError(400,'Unexpected selection field.');
  return { studyUid:selection.studyUid,...(selection.seriesUid ? {seriesUid:selection.seriesUid}:{}),...(selection.sopUid ? {sopUid:selection.sopUid}:{}) };
}

/** Configured destinations only. Requests cannot supply a URL, header, or socket override. */
export class ConnectionService {
  static async open(options) { const service = new ConnectionService(options); service.initialize(); service.jobs.start(); return service; }
  constructor({ archive, credentials = {}, transports = {}, autoStartJobs = true }) {
    this.archive = archive; this.db = archive.db; this.credentials = credentials; this.transports = transports; this.autoStartJobs = autoStartJobs;
    this.jobs = new TransferQueue({ db:this.db, service:this, autoStart:autoStartJobs });
  }
  initialize() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY,config TEXT NOT NULL,revision INTEGER NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);`);
    this.jobs.initialize();
  }
  validate(input) {
    if (!plainObject(input)) throw httpError(400,'Send a connection object.');
    const allowed = ['name','type','baseUrl','host','port','calledAeTitle','callingAeTitle','credentialId','timeoutMs'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw httpError(400,'Unexpected connection field.');
    const config = {name:text(input.name,80,'connection name'),type:input.type,timeoutMs:input.timeoutMs ?? 30000};
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 300000) throw httpError(400,'Timeout must be between 1 and 300 seconds.');
    if (input.type === 'dicomweb') {
      let url; try { url = new URL(input.baseUrl); } catch { throw httpError(400,'Enter a complete DICOMweb HTTP or HTTPS base URL.'); }
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href.length > 2048) throw httpError(400,'DICOMweb URLs must use HTTP(S), without embedded credentials, query, or fragment.');
      config.baseUrl = url.href.replace(/\/$/,'');
      if (input.credentialId) {
        config.credentialId = text(input.credentialId,80,'credential name');
        if (!Object.hasOwn(this.credentials, config.credentialId)) throw httpError(400,'This credential name is not configured on the server.');
        if (url.protocol !== 'https:' && !isLoopback(url.hostname)) throw httpError(400,'Credentials require HTTPS for non-loopback peers.');
      }
    } else if (input.type === 'dimse') {
      config.host = text(input.host,253,'peer hostname');
      if (!/^[A-Za-z0-9.:[\]_-]+$/.test(config.host)) throw httpError(400,'Invalid peer hostname.');
      config.port = Number(input.port); if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw httpError(400,'Invalid DIMSE port.');
      config.calledAeTitle = ae(input.calledAeTitle,'called AE title'); config.callingAeTitle = ae(input.callingAeTitle || 'EASISTORE','calling AE title');
      if (input.credentialId) throw httpError(400,'HTTP credentials do not apply to DIMSE.');
    } else throw httpError(400,'Choose dicomweb or dimse.');
    return config;
  }
  row(row) { return row ? {...JSON.parse(row.config),id:row.id,revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt} : null; }
  list() { return {items:this.db.prepare('SELECT * FROM connections ORDER BY createdAt,id').all().map(row=>this.row(row))}; }
  get(id) { const peer = this.row(this.db.prepare('SELECT * FROM connections WHERE id=?').get(id)); if (!peer) throw httpError(404,'Connection not found.'); return peer; }
  create(input) { const config=this.validate(input), id=randomUUID(), now=new Date().toISOString(); this.db.prepare('INSERT INTO connections VALUES (?,?,?,?,?)').run(id,JSON.stringify(config),1,now,now); return this.get(id); }
  update(id,input) { this.get(id); if (this.jobs.hasActive(id)) throw httpError(409,'Wait for active transfers to finish or cancel them before editing this connection.'); const config=this.validate(input); this.db.prepare('UPDATE connections SET config=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify(config),new Date().toISOString(),id); return this.get(id); }
  remove(id) { this.get(id); if (this.jobs.hasActive(id)) throw httpError(409,'Cancel active transfers before removing their connection.'); this.db.prepare('DELETE FROM connections WHERE id=?').run(id); return {removed:true}; }
  resolveMoveDestination(aeTitle) { const peers=this.list().items.filter(peer=>peer.type==='dimse' && peer.calledAeTitle===aeTitle); if (peers.length !== 1) return null; return peers[0]; }
  headers(peer) {
    const credential=peer.credentialId ? this.credentials[peer.credentialId] : null;
    if (peer.credentialId && !credential) throw httpError(409,'The server credential for this connection is unavailable.');
    const result={};
    if (credential?.bearerToken) result.Authorization=`Bearer ${credential.bearerToken}`;
    else if (credential?.basicUsername && credential?.basicPassword) result.Authorization=`Basic ${Buffer.from(`${credential.basicUsername}:${credential.basicPassword}`).toString('base64')}`;
    return result;
  }
  async request(peer, resource, {signal,...options}={}) {
    const combined=signal ? AbortSignal.any([signal,AbortSignal.timeout(peer.timeoutMs)]) : AbortSignal.timeout(peer.timeoutMs);
    let response;
    try { response=await fetch(`${peer.baseUrl}${resource}`,{...options,headers:{...this.headers(peer),...options.headers},redirect:'error',signal:combined}); }
    catch (error) { if (signal?.aborted) throw error; throw httpError(502,'The configured DICOMweb peer could not be reached. Check its address, TLS certificate, and credentials.'); }
    if (!response.ok) { await response.body?.cancel(); throw httpError(502,`The configured peer returned HTTP ${response.status}.`); }
    return response;
  }
  association(peer) { return {host:peer.host,port:peer.port,calledAeTitle:peer.calledAeTitle,callingAeTitle:peer.callingAeTitle,associationTimeoutMs:peer.timeoutMs,timeoutMs:peer.timeoutMs}; }
  async test(id,{signal}={}) {
    const peer=this.get(id), started=Date.now();
    if (peer.type==='dicomweb') {
      const response=await this.request(peer,'/studies?limit=1',{signal,headers:{Accept:'application/dicom+json'}});
      const list=response.status===204 ? [] : await limitedJson(response);
      if (!Array.isArray(list)) throw httpError(502,'The peer did not return a DICOM JSON study list.');
      return {ok:true,protocol:'QIDO-RS',durationMs:Date.now()-started};
    }
    try { const result=await new NodeDimseQueryRetrieveSourceTransport().echo(this.association(peer),{signal,operationTimeoutMs:peer.timeoutMs}); return {ok:result.ok,status:result.status,protocol:'C-ECHO',durationMs:Date.now()-started}; }
    catch { throw httpError(502,'The DIMSE peer did not complete C-ECHO. Check AE titles, host, port, and its allowed callers.'); }
  }
  async search(id,input={}, {signal}={}) {
    const peer=this.get(id); if (!plainObject(input) || Object.keys(input).some(key=>!['criteria','limit','offset'].includes(key))) throw httpError(400,'Invalid search request.');
    const criteria=input.criteria ?? {}, limit=input.limit ?? 100, offset=input.offset ?? 0;
    if (!plainObject(criteria) || Object.keys(criteria).some(key=>!queryKeys.has(key)) || Object.values(criteria).some(value=>typeof value!=='string'||value.length>256||/[\x00-\x1f]/.test(value))) throw httpError(400,'Unsupported or invalid patient/study criteria.');
    if (!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(offset)||offset<0||offset>100000) throw httpError(400,'Invalid search pagination.');
    if (peer.type==='dicomweb') {
      const params=new URLSearchParams({...criteria,limit:String(limit),offset:String(offset)});
      const response=await this.request(peer,`/studies?${params}`,{signal,headers:{Accept:'application/dicom+json'}});
      const result=response.status===204 ? [] : await limitedJson(response);
      if (!Array.isArray(result)||result.length>limit||result.some(item=>!plainObject(item))) throw httpError(502,'The peer returned an invalid or excessive study list.');
      return {items:result.map(publicStudy),hasMore:result.length===limit,offset};
    }
    if (offset) throw httpError(400,'DIMSE study searches do not support offset pagination. Refine patient criteria.');
    let result;
    try {
      const pipeline=EASI.pipelineBuilder().fromDimseAssociation(this.association(peer),new NodeDimseQueryRetrieveSourceTransport()).ofDicomData().toInstances().build();
      result=await pipeline.process({sourceOptions:{operation:'c-find',queryRetrieveModel:'study-root',queryRetrieveLevel:'STUDY',keys:criteria,returnKeys,signal,operationTimeoutMs:peer.timeoutMs,maxDataSetBytes:262144,maxTotalDataSetBytes:4*1024*1024}});
    } catch { throw httpError(502,'The DIMSE peer could not complete the bounded study search. Refine criteria or check the remote query configuration.'); }
    const all=result.toArray(); if (all.length>1000) throw httpError(502,'The DIMSE search exceeded 1,000 studies. Refine patient criteria.');
    const get=identifierValue;
    return {items:all.slice(0,limit).map(instance=>({patientName:get(instance,'00100010'),patientId:get(instance,'00100020'),studyUid:get(instance,'0020000D'),studyDate:get(instance,'00080020'),studyDescription:get(instance,'00081030'),modalities:get(instance,'00080061').split('\\').filter(Boolean),seriesCount:Number(get(instance,'00201206'))||0,instanceCount:Number(get(instance,'00201208'))||0})),hasMore:all.length>limit,offset:0};
  }
  async createJob(input) {
    if (!plainObject(input)||Object.keys(input).some(key=>!['connectionId','direction','selection'].includes(key))) throw httpError(400,'Invalid transfer request.');
    if(typeof input.connectionId!=='string'||!/^[a-f0-9-]{36}$/.test(input.connectionId))throw httpError(400,'Choose a configured connection.');
    const peer=this.get(input.connectionId),selection=checkedSelection(input.selection);
    if (!['send','retrieve'].includes(input.direction)) throw httpError(400,'Choose send or retrieve.');
    let records;
    if (input.direction==='send') {
      const keys=['studyUid','seriesUid','sopUid'].filter(key=>selection[key]);
      records=this.archive.originalRecords(keys.map(key=>`${key}=?`).join(' AND '),keys.map(key=>selection[key]));
      if (!records.length) throw httpError(404,'The selected study, series, or instance is not archived.');
      if (records.length>100000) throw httpError(413,'A transfer is limited to 100,000 instances. Select individual series.');
    }
    return this.jobs.create({peer,direction:input.direction,selection,records});
  }
  async enumerate(peer,selection,signal) {
    if (selection.sopUid&&peer.type!=='dimse') return [selection];
    if(peer.type==='dimse') {
      const find=async(queryRetrieveLevel,options,returnKeys)=>{
        const pipeline=EASI.pipelineBuilder().fromDimseAssociation(this.association(peer),new NodeDimseQueryRetrieveSourceTransport()).ofDicomData().toInstances().build();
        try {return (await pipeline.process({sourceOptions:{operation:'c-find',queryRetrieveModel:'study-root',queryRetrieveLevel,studyInstanceUid:selection.studyUid,...options,returnKeys,signal,operationTimeoutMs:peer.timeoutMs,maxDataSetBytes:262144,maxTotalDataSetBytes:64*1024*1024}})).toArray();}
        catch {throw httpError(502,'The DIMSE peer could not enumerate the selected instances. Check its query/retrieve profile.');}
      };
      const series=selection.seriesUid?[selection.seriesUid]:(await find('SERIES',{},['StudyInstanceUID','SeriesInstanceUID'])).map(instance=>{
        const seriesUid=identifierValue(instance,'0020000E');if(!validUid(seriesUid)||identifierValue(instance,'0020000D')!==selection.studyUid)throw httpError(502,'The DIMSE peer returned inconsistent series identifiers.');return seriesUid;
      });
      if(series.length>100000||new Set(series).size!==series.length)throw httpError(502,'The DIMSE peer returned an excessive or repeated series enumeration.');
      const seen=new Set(),records=[];
      for(const selectedSeries of series) {
        const matches=await find('IMAGE',{seriesInstanceUid:selectedSeries,...(selection.sopUid?{sopInstanceUid:selection.sopUid}:{})},['StudyInstanceUID','SeriesInstanceUID','SOPInstanceUID','SOPClassUID']);
        for(const instance of matches) {
          const studyUid=identifierValue(instance,'0020000D'),seriesUid=identifierValue(instance,'0020000E'),sopUid=identifierValue(instance,'00080018'),sopClassUid=identifierValue(instance,'00080016');
          if(studyUid!==selection.studyUid||seriesUid!==selectedSeries||!validUid(sopUid)||!validUid(sopClassUid)||selection.sopUid&&sopUid!==selection.sopUid||seen.has(sopUid))throw httpError(502,'The DIMSE peer returned incomplete or inconsistent instance and SOP class identifiers.');
          seen.add(sopUid);records.push({studyUid,seriesUid,sopUid,sopClassUid});if(records.length>100000)throw httpError(413,'The remote selection exceeds 100,000 instances. Select individual series.');
        }
      }
      return records;
    }
    const pages=async(resource,fields)=>{
      const result=[];
      for(let offset=0;offset<100000;offset+=200) {
        const response=await this.request(peer,`${resource}?limit=200&offset=${offset}&includefield=${fields.join(',')}`,{signal,headers:{Accept:'application/dicom+json'}});
        const page=response.status===204?[]:await limitedJson(response);
        if(!Array.isArray(page)||page.length>200)throw httpError(502,'The peer returned an invalid instance enumeration.');
        result.push(...page);if(page.length<200)return result;
      }
      throw httpError(413,'The remote selection exceeds 100,000 resources. Select individual series.');
    };
    const series=selection.seriesUid?[selection.seriesUid]:(await pages(`/studies/${selection.studyUid}/series`,['StudyInstanceUID','SeriesInstanceUID'])).map(item=>{
      const uid=item?.['0020000E']?.Value?.[0];if(!validUid(uid)||item?.['0020000D']?.Value?.[0]!==selection.studyUid)throw httpError(502,'The peer returned inconsistent series identifiers.');return uid;
    });
    if(new Set(series).size!==series.length)throw httpError(502,'The peer repeated a series during pagination.');
    const records=[],seen=new Set();
    for(const selectedSeries of series) {
      for(const item of await pages(`/studies/${selection.studyUid}/series/${selectedSeries}/instances`,['StudyInstanceUID','SeriesInstanceUID','SOPInstanceUID'])) {
        const studyUid=item?.['0020000D']?.Value?.[0],seriesUid=item?.['0020000E']?.Value?.[0],sopUid=item?.['00080018']?.Value?.[0];
        if(studyUid!==selection.studyUid||seriesUid!==selectedSeries||!validUid(sopUid)||seen.has(sopUid))throw httpError(502,'The peer returned inconsistent identities or repeated pagination.');
        seen.add(sopUid);records.push({studyUid,seriesUid,sopUid});if(records.length>100000)throw httpError(413,'The remote selection exceeds 100,000 instances. Select individual series.');
      }
    }
    return records;
  }
  async transfer(peer,direction,item,signal) {
    if (this.transports.transfer) return this.transports.transfer(peer,direction,item,signal);
    if (direction==='send') {
      const record=this.archive.getInstance(item.studyUid,item.seriesUid,item.sopUid); if (!record) throw httpError(404,'An archived transfer object is no longer available.');
      if (peer.type==='dimse') {
        const {sendStoredInstance}=await import('../dimse/StorageScp.js');
        const result=await sendStoredInstance(this.association(peer),record,{signal});
        if (!result.ok && result.status!==0) throw httpError(502,'The DIMSE peer rejected this storage sub-operation.'); return {outcome:result.status ? 'warning':'sent'};
      }
      const boundary=`easi-${randomUUID()}`;
      async function* body() { yield Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`); for await (const chunk of createReadStream(record.path,{signal})) yield chunk; yield Buffer.from(`\r\n--${boundary}--\r\n`); }
      const response=await this.request(peer,'/studies',{method:'POST',signal,duplex:'half',headers:{'Content-Type':`multipart/related; type="application/dicom"; boundary=${boundary}`,Accept:'application/dicom+json'},body:Readable.from(body())});
      const result=await limitedJson(response);
      const failures=result?.['00081198']?.Value||[];
      const success=result?.['00081199']?.Value||[];
      if (failures.length || !success.some(entry=>entry?.['00081155']?.Value?.[0]===item.sopUid)) throw httpError(502,'The STOW peer did not acknowledge this SOP Instance UID as stored.');
      const acknowledged=success.find(entry=>entry?.['00081155']?.Value?.[0]===item.sopUid);
      return {outcome:acknowledged?.['00081196'] ? 'warning':'sent'};
    }
    if(peer.type==='dimse') {
      const {retrieveToArchive}=await import('../dimse/StorageScp.js');
      const result=await retrieveToArchive(this.association(peer),{...item,storageTransferSyntaxUids:storageSyntaxes,...(item.sopClassUid?{storageSopClassUids:[item.sopClassUid]}:{})},this.archive,{signal,source:`connection:${peer.id}`});
      if(result.failed||!result.stored&&!result.duplicates||result.status!==0&&result.status!==0xb000)throw httpError(502,'The remote DIMSE peer did not complete durable instance retrieval.');
      return {outcome:result.duplicates?'duplicate':result.warning?'warning':'stored'};
    }
    const response=await this.request(peer,`/studies/${item.studyUid}/series/${item.seriesUid}/instances/${item.sopUid}`,{signal,headers:{Accept:'multipart/related; type="application/dicom"; transfer-syntax=*'}});
    let reader;
    try {
      const contentType=response.headers.get('content-type')||'';
      const expected={source:`connection:${peer.id}`,expectedStudyUid:item.studyUid,expectedSeriesUid:item.seriesUid,expectedSopUid:item.sopUid};
      if (/^application\/dicom(?:;|$)/i.test(contentType)) return {outcome:(await this.archive.ingest(response.body,expected)).status};
      const boundary=parseRelatedType(contentType); reader=new RelatedReader(response.body,boundary,{maxParts:2,maxBytes:this.archive.maxInstanceBytes+65536}); let count=0, outcome;
      for await (const part of reader.parts()) {
        if (++count!==1 || !/^application\/dicom(?:;|$)/i.test(part.headers['content-type']||'')) throw httpError(502,'The WADO peer returned an unexpected multipart object.');
        outcome=(await this.archive.ingest(part.body,expected)).status;
      }
      if(count!==1) throw httpError(502,'The WADO peer returned no DICOM instance.');return {outcome};
    } finally {
      // A rejected MIME header/part must release Undici's response stream now,
      // rather than leaving its connection reading until the peer times out.
      if(reader)await reader.close().catch(()=>{});
      else if(response.body&&!response.body.locked)await response.body.cancel().catch(()=>{});
    }
  }
  async close() { await this.jobs.close(); }
}

export async function handleConnectionRoutes(req,res,{service}) {
  const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method;
  if (path==='/api/v1/connections') {
    if(method==='GET') {json(res,200,service.list());return true;}
    if(method==='POST') {json(res,201,service.create(await readJson(req)));return true;}
  }
  const connection=path.match(/^\/api\/v1\/connections\/([a-f0-9-]+)(?:\/(test|search))?$/);
  if(connection) {
    const [,id,action]=connection;
    if(!action&&method==='PUT') {json(res,200,service.update(id,await readJson(req)));return true;}
    if(!action&&method==='DELETE') {json(res,200,service.remove(id));return true;}
    if(action==='test'&&method==='POST') {await readJson(req);json(res,200,await service.test(id));return true;}
    if(action==='search'&&method==='POST') {json(res,200,await service.search(id,await readJson(req)));return true;}
  }
  if(path==='/api/v1/jobs') {
    if(method==='GET') {json(res,200,service.jobs.list());return true;}
    if(method==='POST') {json(res,202,await service.createJob(await readJson(req)));return true;}
  }
  const job=path.match(/^\/api\/v1\/jobs\/([a-f0-9-]+)(?:\/(cancel|retry))?$/);
  if(job) {
    if(!job[2]&&method==='GET') {json(res,200,service.jobs.get(job[1]));return true;}
    if(job[2]&&method==='POST') {await readJson(req);json(res,200,job[2]==='cancel'?service.jobs.cancel(job[1]):service.jobs.retry(job[1]));return true;}
  }
  if(path==='/api/v1/connections'||path.startsWith('/api/v1/connections/')||path==='/api/v1/jobs'||path.startsWith('/api/v1/jobs/')) throw httpError(405,'Method or connection operation not supported.');
  return false;
}
