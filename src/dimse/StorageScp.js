// Independent DICOM Upper Layer / DIMSE server; no PACS implementation is copied.
// Storage success is sent only after Archive.ingest commits originals and catalog.
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { part10Header } from '../synthetic.js';
import { APPLICATION, IMPLEMENTATION, QUERY_MODELS, TRANSFER_SYNTAXES, VERIFICATION, IMPLICIT, EXPLICIT,
  u16, u32, text, uidValid, item, items, pdu, commandBytes, decodeCommand, send, sendMessage, sendStoredData, sendStoredInstance, dataSetOffset } from './wire.js';
import { parseIdentifier, encodeIdentifier, queryPlan, matchingGroups, matchingInstances, responseIdentifier } from './query.js';
import { isLoopbackAddress } from '../http/AccessPolicy.js';
export { sendStoredInstance } from './wire.js';

export class StorageScp {
  constructor({ archive, auth, host = '127.0.0.1', port = 4248, aeTitle = 'EASISTORE', maxConnections = 8,
    maxQueryResults = 10000, maxRetrieveInstances = 10000, resolveMoveDestination = () => null, associationPolicy,
    archiveReady = () => Boolean(auth?.record), moveCoordinator = null }) {
    if (!/^[A-Z0-9_ -]{1,16}$/.test(aeTitle)) throw new Error('DIMSE AE title must contain 1–16 uppercase letters, numbers, spaces, _ or -.');
    if (![maxConnections,maxQueryResults,maxRetrieveInstances].every(value => Number.isInteger(value) && value > 0 && value <= 65535)) throw new Error('Invalid DIMSE operation limits.');
    if (associationPolicy === undefined) {
      if (host !== 'localhost' && !isLoopbackAddress(host)) throw new Error('Network DIMSE listeners require an explicit calling-AE/source-IP association policy.');
      associationPolicy = ({remoteAddress}) => isLoopbackAddress(remoteAddress);
    }
    if (typeof resolveMoveDestination !== 'function' || typeof associationPolicy !== 'function' || typeof archiveReady !== 'function') throw new Error('DIMSE policies must be functions.');
    if (moveCoordinator && moveCoordinator.archive !== archive) throw new Error('C-MOVE must use this receiver’s archive.');
    Object.assign(this,{ archive,auth,host,port,aeTitle,maxConnections,maxQueryResults,maxRetrieveInstances,resolveMoveDestination,associationPolicy,archiveReady,moveCoordinator });
    this.sockets = new Set(); this.server = net.createServer(socket => this.accept(socket));
  }
  async listen() {
    await new Promise((resolve,reject) => { this.server.once('error',reject); this.server.listen(this.port,this.host,() => { this.server.off('error',reject); resolve(); }); });
    try { this.moveCoordinator?.attach(this); }
    catch (error) { await new Promise(resolve => this.server.close(resolve)); throw error; }
    return this.server.address();
  }
  accept(socket) {
    if (this.sockets.size >= this.maxConnections) { socket.destroy(); return; }
    this.sockets.add(socket); socket.setTimeout(120000,() => socket.destroy()); socket.on('error',() => {});
    const context = {contexts:new Map(),associated:false,commandChunks:[],commandBytes:0,store:null,active:null,operation:null,pendingStores:new Map(),peerMax:16384,closed:false,nextMessageId:1};
    // receive() may be awaiting ingestion/backpressure rather than the socket
    // iterator. Tear down its spool immediately when a callback is canceled or
    // disconnected, so that await can unwind and release the import reservation.
    socket.once('close',() => {
      context.closed = true; context.operation?.abort.abort();
      context.store?.destroy(new Error('DIMSE association closed.'));
      for (const pending of context.pendingStores.values()) pending.reject(new Error('DIMSE association closed.'));
      context.pendingStores.clear();
    });
    socket.finishedTask = this.receive(socket,context).catch(() => {
      if (!socket.destroyed) socket.end(pdu(7,Buffer.from([0,0,2,0])));
    }).finally(async () => {
      context.closed = true; context.operation?.abort.abort();
      context.store?.destroy(new Error('DIMSE association closed.'));
      if (context.active?.kind === 'store') {
        const outcome = context.active.outcome ? await context.active.outcome : {error:new Error('DIMSE association closed.')};
        context.active.moveClaim?.finish(outcome); context.active.releaseImport?.();
      }
      for (const pending of context.pendingStores.values()) pending.reject(new Error('DIMSE association closed.'));
      context.pendingStores.clear();
      if (!socket.destroyed) socket.destroy();
      await context.operation?.task; this.sockets.delete(socket);
    });
  }
  async receive(socket,context) {
    let buffer = Buffer.alloc(0);
    for await (const chunk of socket) {
      buffer = Buffer.concat([buffer,chunk]);
      while (buffer.length >= 6) {
        const type = buffer[0],size = buffer.readUInt32BE(2);
        if (size > 1024 * 1024) throw new Error('PDU exceeds receive limit.');
        if (buffer.length < size + 6) break;
        const body = buffer.subarray(6,size + 6); buffer = buffer.subarray(size + 6);
        if (type === 1) await this.associate(socket,context,body);
        else if (type === 4 && context.associated) await this.data(socket,context,body);
        else if (type === 5 && context.associated && !context.active && !context.operation) { await send(socket,pdu(6,Buffer.alloc(4))); socket.end(); return; }
        else if (type === 7) return;
        else throw new Error('Unexpected DIMSE PDU.');
      }
    }
    if (buffer.length) throw new Error('Truncated DIMSE PDU.');
  }
  async associate(socket,context,body) {
    if (context.associated || body.length < 68 || body.readUInt16BE(0) !== 1) throw new Error('Invalid association.');
    const called = body.subarray(4,20).toString('ascii').trim(), calling = body.subarray(20,36).toString('ascii').trim();
    const allowed = called === this.aeTitle && /^[\x20-\x7e]{1,16}$/.test(calling) && !calling.includes('\\')
      && await this.associationPolicy({callingAeTitle:calling,calledAeTitle:called,remoteAddress:socket.remoteAddress});
    if (!allowed) { await send(socket,pdu(3,Buffer.from([0,1,1,7]))); socket.end(); return; }
    const requestItems = items(body,68), app = requestItems.find(value => value.type === 0x10), responses = [], roles = new Map(), acceptedRoles = [];
    if (app?.body.toString('ascii') !== APPLICATION) throw new Error('Unsupported application context.');
    const user = requestItems.find(value => value.type === 0x50);
    for (const value of user ? items(user.body) : []) {
      if (value.type === 0x51) { if (value.body.length !== 4) throw new Error('Invalid peer maximum PDU.'); context.peerMax = value.body.readUInt32BE() || 16384; if (context.peerMax < 8) throw new Error('Invalid peer maximum PDU.'); }
      if (value.type === 0x54) {
        const length = value.body.length >= 2 ? value.body.readUInt16BE() : 0;
        if (!length || value.body.length !== length + 4 || value.body[2 + length] > 1 || value.body[3 + length] > 1) throw new Error('Invalid role selection.');
        const uid = value.body.toString('ascii',2,2 + length); if (roles.has(uid) || !uidValid(uid)) throw new Error('Duplicate or invalid role selection.');
        roles.set(uid,{scu:!!value.body[2 + length],scp:!!value.body[3 + length],raw:value.body});
      }
    }
    context.callingAeTitle = calling;
    const presentationContexts = requestItems.filter(value => value.type === 0x20);
    if (!presentationContexts.length || presentationContexts.length > 128) throw new Error('Invalid presentation context count.');
    for (const pc of presentationContexts) {
      if (pc.body.length < 4) throw new Error('Invalid presentation context.');
      const id = pc.body[0],inner = items(pc.body,4);
      if (id % 2 === 0 || context.contexts.has(id)) throw new Error('Invalid context ID.');
      const abstract = inner.find(value => value.type === 0x30)?.body.toString('ascii'), proposed = inner.filter(value => value.type === 0x40).map(value => value.body.toString('ascii'));
      const query = QUERY_MODELS.get(abstract), storage = abstract?.startsWith('1.2.840.10008.5.1.4.1.1.');
      const supported = proposed.filter(ts => (query || abstract === VERIFICATION) ? [IMPLICIT,EXPLICIT].includes(ts) : TRANSFER_SYNTAXES.has(ts));
      // Explicit LE is a common original encoding and avoids accepting Implicit
      // first merely because a client offered both in one storage context.
      const transferSyntax = supported.includes(EXPLICIT) ? EXPLICIT : supported[0];
      const role = roles.get(abstract) ?? {scu:true,scp:false};
      const accepted = !!(transferSyntax && (abstract === VERIFICATION || storage || query) && (role.scu || storage && role.scp));
      context.contexts.set(id,{abstract,transferSyntax,accepted,requestorScu:role.scu,requestorScp:storage && role.scp,query});
      responses.push(item(0x21,Buffer.concat([Buffer.from([id,0,accepted ? 0 : transferSyntax ? 3 : 4,0]),item(0x40,Buffer.from(transferSyntax || proposed[0] || IMPLICIT))])));
      if (accepted && storage && roles.has(abstract) && !acceptedRoles.some(value => value.uid === abstract)) acceptedRoles.push({uid:abstract,raw:role.raw});
    }
    const maximum = Buffer.alloc(4); maximum.writeUInt32BE(1024 * 1024);
    const userInfo = item(0x50,Buffer.concat([item(0x51,maximum),item(0x52,Buffer.from(IMPLEMENTATION)),item(0x55,Buffer.from('EASI_STORE_020')),...acceptedRoles.map(role => item(0x54,role.raw))]));
    await send(socket,pdu(2,Buffer.concat([body.subarray(0,68),item(0x10,app.body),...responses,userInfo]))); context.associated = true;
  }
  async respond(socket,context,id,request,status,{identifier,counts} = {}) {
    const elements = [[2,text(request.sopClassUid)],[0x100,u16(request.field | 0x8000)],[0x120,u16(request.messageId)],[0x800,u16(identifier ? 0 : 0x101)],[0x900,u16(status)]];
    if (request.sopUid) elements.push([0x1000,text(request.sopUid)]);
    if (counts) {
      if (status === 0xff00 || status === 0xff01 || status === 0xfe00) elements.push([0x1020,u16(counts.remaining)]);
      elements.push([0x1021,u16(counts.completed)],[0x1022,u16(counts.failed)],[0x1023,u16(counts.warning)]);
    }
    await sendMessage(socket,id,commandBytes(elements),true,context.peerMax);
    if (identifier) await sendMessage(socket,id,identifier,false,context.peerMax);
  }
  async data(socket,context,body) {
    for (let i = 0; i < body.length;) {
      if (i + 6 > body.length) throw new Error('Truncated data value.');
      const length = body.readUInt32BE(i),id = body[i + 4],flags = body[i + 5],end = i + 4 + length;
      if (length <= 2 || end > body.length || flags > 3) throw new Error('Invalid data value.');
      const pc = context.contexts.get(id); if (!pc?.accepted) throw new Error('Unaccepted context.');
      const bytes = body.subarray(i + 6,end);
      if (flags & 1) {
        if (context.commandId !== undefined && context.commandId !== id) throw new Error('Command context changed.');
        context.commandId = id; context.commandBytes += bytes.length; if (context.commandBytes > 65536) throw new Error('Command is too large.');
        context.commandChunks.push(bytes);
        if (flags & 2) {
          const command = decodeCommand(Buffer.concat(context.commandChunks)); context.commandChunks = []; context.commandBytes = 0; context.commandId = undefined;
          await this.command(socket,context,id,pc,command);
        }
      } else {
        const active = context.active; if (!active || active.id !== id) throw new Error('Unexpected dataset.');
        if (active.kind === 'query') {
          active.bytes += bytes.length; if (active.bytes > 1024 * 1024) throw new Error('Query identifier exceeds limit.'); active.chunks.push(bytes);
          if (flags & 2) {
            context.active = null;
            const operation = {command:active.command,id,pc,cancelled:false,abort:new AbortController()}; context.operation = operation;
            operation.task = this.query(socket,context,operation,Buffer.concat(active.chunks)).catch(() => { if (!socket.destroyed) socket.destroy(); }).finally(() => { if (context.operation === operation) context.operation = null; });
          }
        } else await this.storeData(socket,context,active,bytes,!!(flags & 2));
      }
      i = end;
    }
  }
  async command(socket,context,id,pc,command) {
    if (command.field === 0x0fff) {
      if (command.datasetType !== 0x101 || !command.respondedTo || context.operation?.id !== id || context.operation.command.messageId !== command.respondedTo) throw new Error('Mismatched C-CANCEL.');
      context.operation.cancelled = true; return;
    }
    if (command.field === 0x8001) {
      const pending = context.pendingStores.get(command.respondedTo);
      if (!pending || pending.id !== id || command.datasetType !== 0x101 || command.sopClassUid !== pending.record.sopClassUid || command.sopUid !== pending.record.sopUid || command.status === undefined) throw new Error('Mismatched C-STORE sub-operation response.');
      context.pendingStores.delete(command.respondedTo); pending.resolve(command.status); return;
    }
    if (context.active || context.operation) throw new Error('Asynchronous operations are not negotiated.');
    if (!command.messageId || command.sopClassUid !== pc.abstract || !pc.requestorScu || command.field !== 0x30 && ![0,1,2].includes(command.priority)) throw new Error('Invalid DIMSE command or role.');
    if (command.field === 0x30 && pc.abstract === VERIFICATION && command.datasetType === 0x101) await this.respond(socket,context,id,command,0);
    else if (command.field === 1 && pc.abstract.startsWith('1.2.840.10008.5.1.4.1.1.') && command.datasetType !== 0x101 && uidValid(command.sopUid)) {
      let releaseImport, reservationError, moveClaim;
      try {
        moveClaim = this.moveCoordinator?.claimStore({command,callingAeTitle:context.callingAeTitle,remoteAddress:socket.remoteAddress,cancel:() => socket.destroy()});
        releaseImport = this.archive.acquireImportReservation();
      }
      catch (error) { reservationError = error; }
      // Reserve accepted C-STORE before its first dataset PDV. A sender may
      // pause here; that pending import must still exclude study removal.
      context.active = {kind:'store',command,id,pc,discarded:false,releaseImport,reservationError,moveClaim};
      if (reservationError) moveClaim?.finish({error:reservationError});
    }
    else if (pc.query && command.field === pc.query.operation && command.datasetType !== 0x101) context.active = {kind:'query',command,id,pc,chunks:[],bytes:0};
    else { await this.respond(socket,context,id,command,0x122); if (command.datasetType !== 0x101) throw new Error('Unsupported service.'); }
  }
  async storeData(socket,context,active,bytes,last) {
    if (!context.store) {
      const stream = new PassThrough({highWaterMark:65536}); stream.on('error',() => {}); context.store = stream;
      if (active.reservationError || !this.archiveReady()) { active.discarded = true; active.outcome = Promise.resolve({error:active.reservationError ?? {statusCode:403}}); }
      else {
        active.outcome = this.archive.ingest(stream,active.moveClaim?.options ?? {source:`dimse:${this.aeTitle}`,expectedSopUid:active.command.sopUid,expectedSopClassUid:active.command.sopClassUid})
          .then(result => ({result}),error => { active.discarded = true; stream.destroy(); return {error}; });
        stream.write(part10Header({sopUid:active.command.sopUid,sopClassUid:active.command.sopClassUid,transferSyntaxUid:active.pc.transferSyntax}));
      }
    }
    if (!active.discarded && !context.store.write(bytes)) await Promise.race([once(context.store,'drain'),active.outcome]);
    if (last) {
      try {
        context.store.end(); const outcome = await active.outcome;
        active.moveClaim?.finish(outcome);
        await this.respond(socket,context,active.id,active.command,outcome.error ? outcome.error.statusCode === 409 && outcome.error.code === 'uid-conflict' ? 0x111 : 0xa700 : 0);
      } finally {
        context.store.destroy(); context.store = null; active.releaseImport?.(); context.active = null;
      }
    }
  }
  async query(socket,context,operation,bytes) {
    const {command,id,pc} = operation; let counts, releaseRead;
    try {
      if (!this.archiveReady()) throw Object.assign(new Error('Archive setup is required.'),{dimseStatus:command.field === 0x20 ? 0xa700 : 0xa701});
      releaseRead = this.archive.acquireReadLease();
      const identifier = parseIdentifier(bytes,pc.transferSyntax), plan = queryPlan(identifier,pc.query.model,command.field !== 0x20);
      if (command.field === 0x20) {
        const groups = matchingGroups(this.archive,plan,this.maxQueryResults);
        for (const {identity} of groups) {
          if (operation.cancelled || context.closed) break;
          await this.respond(socket,context,id,command,plan.optionalKeysUnsupported ? 0xff01 : 0xff00,{identifier:encodeIdentifier(responseIdentifier(this.archive,plan,identity,identifier,this.aeTitle),pc.transferSyntax)});
          await nextTurn();
        }
        if (!context.closed) await this.respond(socket,context,id,command,operation.cancelled ? 0xfe00 : 0);
        return;
      }
      const records = matchingInstances(this.archive,plan,this.maxRetrieveInstances);
      counts = {remaining:records.length,completed:0,failed:0,warning:0};
      let destination;
      if (command.field === 0x21) {
        if (!/^[\x20-\x7e]{1,16}$/.test(command.moveDestination ?? '') || command.moveDestination.includes('\\')) throw Object.assign(new Error('Unknown move destination.'),{dimseStatus:0xa801});
        destination = await this.resolveMoveDestination(command.moveDestination);
        if (!destination) throw Object.assign(new Error('Unknown move destination.'),{dimseStatus:0xa801});
      }
      const failed = [];
      await this.respond(socket,context,id,command,0xff00,{counts});
      for (const record of records) {
        if (operation.cancelled || context.closed) break;
        let status = 0xa700;
        try {
          if (command.field === 0x10) status = await this.getSubOperation(socket,context,record,command.priority);
          else status = (await sendStoredInstance({...destination,calledAeTitle:destination.calledAeTitle ?? command.moveDestination,callingAeTitle:destination.callingAeTitle ?? this.aeTitle},record,
            {signal:operation.abort.signal,moveOriginatorAeTitle:context.callingAeTitle,moveOriginatorMessageId:command.messageId,priority:command.priority})).status;
        } catch { if (context.closed) return; }
        counts.remaining--;
        if (status === 0) counts.completed++;
        else if ((status & 0xf000) === 0xb000) counts.warning++;
        else { counts.failed++; failed.push(record.sopUid); }
        if (!context.closed) await this.respond(socket,context,id,command,0xff00,{counts});
        await nextTurn();
      }
      if (context.closed) return;
      const status = operation.cancelled ? 0xfe00 : counts.failed || counts.warning ? 0xb000 : 0;
      // A failed UID list belongs to unsuccessful sub-operations, not warnings.
      const result = failed.length ? encodeIdentifier({'00080058':failed},pc.transferSyntax) : undefined;
      await this.respond(socket,context,id,command,status,{counts,identifier:result});
    } catch (error) {
      if (!context.closed) await this.respond(socket,context,id,command,error.dimseStatus ?? (command.field === 0x20 ? 0xa700 : counts ? 0xa702 : 0xa701),{counts});
    } finally { releaseRead?.(); }
  }
  async getSubOperation(socket,context,record,priority) {
    const chosen = [...context.contexts].find(([,pc]) => pc.accepted && pc.requestorScp && pc.abstract === record.sopClassUid && pc.transferSyntax === record.transferSyntaxUid);
    if (!chosen) return 0xa700;
    // Validate the stored file before emitting a C-STORE command: an unreadable
    // source is a failed sub-operation, not an incomplete dataset on the wire.
    await dataSetOffset(record.path);
    const [id] = chosen,messageId = context.nextMessageId; context.nextMessageId = messageId % 65535 + 1;
    let pending;
    const acknowledged = new Promise((resolve,reject) => { pending = {id,record,resolve,reject}; });
    // Attach the rejection handler before streaming, so disconnects never create
    // an unhandled promise rejection while the source stream is unwinding.
    acknowledged.catch(() => {}); context.pendingStores.set(messageId,pending);
    const timer = setTimeout(() => { context.pendingStores.delete(messageId); pending.reject(new Error('C-STORE sub-operation timed out.')); socket.destroy(); },120000); timer.unref();
    try {
      await sendMessage(socket,id,commandBytes([[2,text(record.sopClassUid)],[0x100,u16(1)],[0x110,u16(messageId)],[0x700,u16(priority)],[0x800,u16(0)],[0x1000,text(record.sopUid)]]),true,context.peerMax);
      try { await sendStoredData(socket,id,record.path,context.peerMax); }
      catch (error) { context.closed = true; socket.destroy(); throw error; }
      return await acknowledged;
    } finally { clearTimeout(timer); context.pendingStores.delete(messageId); }
  }
  async close() {
    this.closing = true; this.moveCoordinator?.detach(this);
    const sockets = [...this.sockets]; for (const socket of sockets) socket.destroy();
    if (this.server.listening) await new Promise(resolve => this.server.close(resolve));
    await Promise.allSettled(sockets.map(socket => socket.finishedTask));
  }
}
export { retrieveToArchive } from './QueryRetrieveScu.js';
