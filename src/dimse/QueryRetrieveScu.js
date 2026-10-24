// Durable C-GET SCU. Unlike a memory-envelope transport, each C-STORE response
// follows the receiving archive's file flush and committed catalog transaction.
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { part10Header } from '../synthetic.js';
import { APPLICATION,IMPLEMENTATION,IMPLICIT,EXPLICIT,QUERY_MODELS,TRANSFER_SYNTAXES,u16,text,uidValid,item,items,pdu,commandBytes,decodeCommand,send,sendMessage } from './wire.js';
import { encodeIdentifier,parseIdentifier } from './query.js';
const defaultClasses = ['1','1.1','1.2','2','2.1','4','4.1','6.1','7','12.1','12.2','128','130','88.22'].map(suffix => `1.2.840.10008.5.1.4.1.1.${suffix}`);
const defaultSyntaxes = [EXPLICIT,IMPLICIT,'1.2.840.10008.1.2.2','1.2.840.10008.1.2.4.50','1.2.840.10008.1.2.4.57','1.2.840.10008.1.2.4.70','1.2.840.10008.1.2.4.80','1.2.840.10008.1.2.4.90','1.2.840.10008.1.2.5'];
const abortError = () => Object.assign(new Error('DIMSE retrieval cancelled.'),{name:'AbortError'});
async function* readPdus(socket) {
  let buffer = Buffer.alloc(0);
  for await (const bytes of socket) {
    buffer = Buffer.concat([buffer,bytes]);
    while (buffer.length >= 6) {
      const size = buffer.readUInt32BE(2); if (size > 1024 * 1024) throw new Error('DIMSE peer PDU exceeds limit.');
      if (buffer.length < size + 6) break;
      const result = {type:buffer[0],body:buffer.subarray(6,size + 6)}; buffer = buffer.subarray(size + 6); yield result;
    }
  }
  throw new Error('DIMSE peer closed the association.');
}
function storeResponse(request,status) {
  return commandBytes([[2,text(request.sopClassUid)],[0x100,u16(0x8001)],[0x120,u16(request.messageId)],[0x800,u16(0x101)],[0x900,u16(status)],[0x1000,text(request.sopUid)]]);
}
export async function retrieveToArchive(association,selection,archive,{signal,onProgress,source = `dimse:${association.calledAeTitle}`,maxInstances = 10000,maxTotalBytes = 10 * 1024 ** 3} = {}) {
  if (signal?.aborted) throw abortError();
  const {host,port,calledAeTitle,callingAeTitle = 'EASISTORE',timeoutMs = 120000} = association;
  for (const ae of [calledAeTitle,callingAeTitle]) if (typeof ae !== 'string' || !/^[\x20-\x7e]{1,16}$/.test(ae) || ae.includes('\\')) throw new Error('Invalid DIMSE AE title.');
  for (const key of ['studyUid','seriesUid','sopUid']) if (selection[key] !== undefined && !uidValid(selection[key])) throw new Error('Invalid retrieve UID.');
  if (!selection.studyUid) throw new Error('A study UID is required for a configured archive retrieval.');
  if (selection.sopUid && !selection.seriesUid) throw new Error('An instance retrieval also requires its series UID.');
  const model = selection.queryRetrieveModel ?? 'study-root';
  if (!['study-root','patient-root'].includes(model)) throw new Error('Invalid query/retrieve model.');
  const getUid = [...QUERY_MODELS].find(([,value]) => value.model === model && value.operation === 0x10)[0];
  const classes = [...new Set(selection.storageSopClassUids ?? defaultClasses)],syntaxes = [...new Set(selection.storageTransferSyntaxUids ?? defaultSyntaxes)];
  if (!classes.length || !syntaxes.length || classes.length * syntaxes.length > 127 || !classes.every(uidValid) || !syntaxes.every(syntax => TRANSFER_SYNTAXES.has(syntax))) throw new Error('Invalid C-GET storage presentation context profile.');
  const proposals = [{id:1,abstract:getUid,syntaxes:[EXPLICIT,IMPLICIT]}];
  for (const abstract of classes) for (const syntax of syntaxes) proposals.push({id:proposals.length * 2 + 1,abstract,syntaxes:[syntax]});
  const socket = net.createConnection({host,port}), iterator = readPdus(socket)[Symbol.asyncIterator]();
  socket.on('error',() => {}); socket.setTimeout(timeoutMs,() => socket.destroy(new Error('DIMSE retrieval timed out.')));
  let peerMax = 16384,accepted = new Map(),associated = false,currentStore,commandChunks = [],commandSize = 0,commandId,totalBytes = 0,received = 0,cancelTimer,failedIdentifier = [],expectFailedIdentifier = false;
  const counts = {completed:0,failed:0,warning:0,stored:0,duplicates:0,remaining:0};
  const progress = () => onProgress?.({...counts});
  const cancel = () => {
    if (!associated) { socket.destroy(abortError()); return; }
    sendMessage(socket,1,commandBytes([[0x100,u16(0xfff)],[0x120,u16(1)],[0x800,u16(0x101)]]),true,peerMax).catch(() => socket.destroy());
    cancelTimer = setTimeout(() => socket.destroy(abortError()),5000); cancelTimer.unref();
  };
  signal?.addEventListener('abort',cancel,{once:true});
  const next = async () => (await iterator.next()).value;
  try {
    await new Promise((resolve,reject) => { socket.once('connect',resolve); socket.once('error',reject); });
    if (signal?.aborted) throw abortError();
    const fixed = Buffer.alloc(68); fixed.writeUInt16BE(1); fixed.fill(32,4,36); fixed.write(calledAeTitle,4,'ascii'); fixed.write(callingAeTitle,20,'ascii');
    const maximum = Buffer.alloc(4); maximum.writeUInt32BE(16384);
    const roles = classes.map(abstract => { const bytes = Buffer.from(abstract),raw = Buffer.alloc(bytes.length + 4); raw.writeUInt16BE(bytes.length); bytes.copy(raw,2); raw[raw.length - 1] = 1; return item(0x54,raw); });
    await send(socket,pdu(1,Buffer.concat([fixed,item(0x10,Buffer.from(APPLICATION)),...proposals.map(pc => item(0x20,Buffer.concat([Buffer.from([pc.id,0,0,0]),item(0x30,Buffer.from(pc.abstract)),...pc.syntaxes.map(syntax => item(0x40,Buffer.from(syntax)))]))),item(0x50,Buffer.concat([item(0x51,maximum),item(0x52,Buffer.from(IMPLEMENTATION)),...roles]))])));
    const ac = await next(); if (ac.type !== 2 || ac.body.length < 68) throw new Error('DIMSE peer rejected C-GET association.');
    const acItems = items(ac.body,68),acUser = acItems.find(value => value.type === 0x50),roleMap = new Map();
    for (const sub of acUser ? items(acUser.body) : []) {
      if (sub.type === 0x51) { if (sub.body.length !== 4) throw new Error('Invalid peer PDU limit.'); peerMax = sub.body.readUInt32BE() || 16384; if (peerMax < 8) throw new Error('Invalid peer PDU limit.'); }
      if (sub.type === 0x54) {
        const length = sub.body.length >= 2 ? sub.body.readUInt16BE() : 0;
        if (!length || sub.body.length !== length + 4 || sub.body[2 + length] !== 0 || sub.body[3 + length] > 1) throw new Error('Invalid C-GET role negotiation.');
        const uid = sub.body.toString('ascii',2,2 + length),scpRole = sub.body[3 + length] === 1;
        // DCMTK/Orthanc can repeat the same accepted role for multiple transfer
        // syntax contexts of one SOP class. Identical repetition grants nothing
        // new; contradictory or unrequested roles remain a protocol error.
        if (!classes.includes(uid) || roleMap.has(uid) && roleMap.get(uid) !== scpRole) throw new Error('Unrequested or conflicting role negotiation.');
        roleMap.set(uid,scpRole);
      }
    }
    for (const pc of acItems.filter(value => value.type === 0x21)) {
      if (pc.body.length < 4) throw new Error('Invalid accepted presentation context.');
      const proposed = proposals.find(value => value.id === pc.body[0]); if (!proposed || accepted.has(pc.body[0])) throw new Error('Unrequested or duplicate presentation context.');
      const syntax = items(pc.body,4).find(value => value.type === 0x40)?.body.toString('ascii');
      if (pc.body[2] === 0) { if (!proposed.syntaxes.includes(syntax)) throw new Error('Unrequested transfer syntax.'); accepted.set(proposed.id,{...proposed,syntax,scpRole:roleMap.get(proposed.abstract) === true}); }
    }
    const queryContext = accepted.get(1); if (!queryContext || ![...accepted.values()].some(pc => pc.id !== 1 && pc.scpRole)) throw new Error('Peer did not negotiate C-GET and Storage SCP roles.');
    const identifier = {'00080052':selection.sopUid ? 'IMAGE' : selection.seriesUid ? 'SERIES' : 'STUDY','0020000D':selection.studyUid,...selection.seriesUid && {'0020000E':selection.seriesUid},...selection.sopUid && {'00080018':selection.sopUid}};
    await sendMessage(socket,1,commandBytes([[2,text(getUid)],[0x100,u16(0x10)],[0x110,u16(1)],[0x700,u16(0)],[0x800,u16(0)]]),true,peerMax);
    await sendMessage(socket,1,encodeIdentifier(identifier,queryContext.syntax),false,peerMax); associated = true;
    if (signal?.aborted) cancel();
    let final;
    while (!final || expectFailedIdentifier) {
      const message = await next(); if (message.type !== 4) throw new Error('Unexpected association message during C-GET.');
      for (let i = 0; i < message.body.length;) {
        if (i + 6 > message.body.length) throw new Error('Truncated DIMSE PDV.');
        const length = message.body.readUInt32BE(i),id = message.body[i + 4],flags = message.body[i + 5],end = i + 4 + length,pc = accepted.get(id);
        if (!pc || length < 2 || end > message.body.length || flags > 3) throw new Error('Invalid DIMSE PDV.');
        const bytes = message.body.subarray(i + 6,end);
        if (flags & 1) {
          if (commandId !== undefined && commandId !== id) throw new Error('DIMSE command context changed.'); commandId = id;
          commandSize += bytes.length; if (commandSize > 65536) throw new Error('DIMSE command exceeds limit.'); commandChunks.push(bytes);
          if (flags & 2) {
            const command = decodeCommand(Buffer.concat(commandChunks)); commandChunks = []; commandSize = 0; commandId = undefined;
            if (command.field === 1) {
              if (currentStore || !pc.scpRole || command.sopClassUid !== pc.abstract || !uidValid(command.sopUid) || selection.sopUid && command.sopUid !== selection.sopUid || !command.messageId || command.datasetType === 0x101) throw new Error('Invalid C-STORE sub-operation.');
              received++; if (received > maxInstances) throw new Error('C-GET exceeds the configured instance limit.');
              const stream = new PassThrough({highWaterMark:65536}); stream.on('error',() => {}); const state = {id,command,stream,discarded:false}; currentStore = state;
              state.outcome = archive.ingest(stream,{source,expectedStudyUid:selection.studyUid,expectedSeriesUid:selection.seriesUid,expectedSopUid:command.sopUid,expectedSopClassUid:command.sopClassUid}).then(result => ({result}),error => { state.discarded = true; stream.destroy(); return {error}; });
              stream.write(part10Header({sopUid:command.sopUid,sopClassUid:command.sopClassUid,transferSyntaxUid:pc.syntax}));
            } else if (command.field === 0x8010 && id === 1 && command.respondedTo === 1 && command.sopClassUid === getUid && command.status !== undefined) {
              const readCount = tag => { const value = command.elements.get(tag); if (value && value.length !== 2) throw new Error('Invalid retrieve count.'); return value?.readUInt16LE(); };
              const remaining = readCount(0x1020); if (remaining !== undefined) counts.remaining = remaining;
              if ([0xff00,0xff01].includes(command.status)) { if (command.datasetType !== 0x101) throw new Error('Pending C-GET unexpectedly contains a dataset.'); }
              else {
                if (currentStore || commandSize) throw new Error('C-GET completed before its storage sub-operation.');
                final = {status:command.status,completed:readCount(0x1021) ?? 0,failed:readCount(0x1022) ?? 0,warning:readCount(0x1023) ?? 0};
                expectFailedIdentifier = command.datasetType !== 0x101;
                if (command.status === 0 && expectFailedIdentifier) throw new Error('Successful C-GET unexpectedly contains an identifier.');
              }
            } else throw new Error('Unexpected command during C-GET.');
          }
        } else if (expectFailedIdentifier && id === 1) {
          failedIdentifier.push(bytes); if (failedIdentifier.reduce((sum,part) => sum + part.length,0) > 1024 * 1024) throw new Error('Failed UID list exceeds limit.');
          if (flags & 2) { final.failedSopInstanceUids = parseIdentifier(Buffer.concat(failedIdentifier),queryContext.syntax).get('00080058')?.split('\\') ?? []; expectFailedIdentifier = false; }
        } else {
          const state = currentStore; if (!state || state.id !== id) throw new Error('Unexpected C-STORE dataset.');
          totalBytes += bytes.length; if (totalBytes > maxTotalBytes) throw new Error('C-GET exceeds the configured aggregate byte limit.');
          if (!state.discarded && !state.stream.write(bytes)) await Promise.race([once(state.stream,'drain'),state.outcome]);
          if (flags & 2) {
            state.stream.end(); const outcome = await state.outcome; let status = 0;
            if (outcome.error) { counts.failed++; status = outcome.error.statusCode === 409 ? 0x111 : 0xa700; }
            else { counts.completed++; if (outcome.result.status === 'duplicate') counts.duplicates++; else counts.stored++; }
            await sendMessage(socket,id,storeResponse(state.command,status),true,peerMax); state.stream.destroy(); currentStore = null; progress();
          }
        }
        i = end;
      }
    }
    if (signal?.aborted || final.status === 0xfe00) throw abortError();
    if (final.completed + final.warning !== counts.completed || final.failed !== counts.failed && final.status === 0) throw new Error('C-GET final counts do not match persisted sub-operations.');
    if (final.status !== 0 && (final.status & 0xf000) !== 0xb000) throw Object.assign(new Error(`C-GET failed with status 0x${final.status.toString(16)}.`),{dimseStatus:final.status});
    if (final.status === 0 && (final.failed || final.warning)) throw new Error('Successful C-GET reports failed sub-operations.');
    await send(socket,pdu(5,Buffer.alloc(4))); if ((await next()).type !== 6) throw new Error('C-GET release was not acknowledged.');
    counts.remaining = 0; progress(); return {...counts,...final};
  } finally {
    clearTimeout(cancelTimer); signal?.removeEventListener('abort',cancel); currentStore?.stream.destroy(new Error('C-GET association closed.')); socket.destroy();
    if (currentStore) await currentStore.outcome;
  }
}
