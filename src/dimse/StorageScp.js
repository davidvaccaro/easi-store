// Independent minimal DICOM Upper Layer / DIMSE receiver. No Orthanc source is used.
// Success is returned only after Archive.ingest has committed the original and catalog.
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { part10Header } from '../synthetic.js';
const verification = '1.2.840.10008.1.1';
const transferSyntaxes = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2',
    '1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51', '1.2.840.10008.1.2.4.57',
    '1.2.840.10008.1.2.4.70', '1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81', '1.2.840.10008.1.2.4.90',
    '1.2.840.10008.1.2.4.91', '1.2.840.10008.1.2.5']);
const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const text = value => { const b = Buffer.from(value, 'ascii'); return b.length % 2 ? Buffer.concat([b, Buffer.from([0])]) : b; };
function commandElement(tag, value) {
    const b = Buffer.alloc(8); b.writeUInt16LE(0); b.writeUInt16LE(tag, 2); b.writeUInt32LE(value.length, 4);
    return Buffer.concat([b, value]);
}
function commandBytes(elements) {
    const body = Buffer.concat(elements.map(([tag, value]) => commandElement(tag, value)));
    return Buffer.concat([commandElement(0, u32(body.length)), body]);
}
function decodeCommand(bytes) {
    const result = new Map(); let i = 0;
    while (i + 8 <= bytes.length) {
        if (bytes.readUInt16LE(i) !== 0) throw new Error('Invalid command group.');
        const length = bytes.readUInt32LE(i + 4), end = i + 8 + length;
        if (end > bytes.length || result.has(bytes.readUInt16LE(i + 2))) throw new Error('Invalid command element.');
        result.set(bytes.readUInt16LE(i + 2), bytes.subarray(i + 8, end)); i = end;
    }
    if (i !== bytes.length) throw new Error('Incomplete command.');
    return { field: result.get(0x0100)?.readUInt16LE(), messageId: result.get(0x0110)?.readUInt16LE(),
        datasetType: result.get(0x0800)?.readUInt16LE(), sopClassUid: result.get(0x0002)?.toString('ascii').replace(/[\0 ]+$/, ''),
        sopUid: result.get(0x1000)?.toString('ascii').replace(/[\0 ]+$/, '') };
}
function item(type, body) { const h = Buffer.alloc(4); h[0] = type; h.writeUInt16BE(body.length, 2); return Buffer.concat([h, body]); }
function items(bytes, start = 0) {
    const result = []; let i = start;
    while (i < bytes.length) {
        if (i + 4 > bytes.length) throw new Error('Invalid association item.');
        const length = bytes.readUInt16BE(i + 2); if (i + 4 + length > bytes.length) throw new Error('Invalid association length.');
        result.push({ type: bytes[i], body: bytes.subarray(i + 4, i + 4 + length) }); i += 4 + length;
    }
    return result;
}
function pdu(type, body) { const h = Buffer.alloc(6); h[0] = type; h.writeUInt32BE(body.length, 2); return Buffer.concat([h, body]); }
export class StorageScp {
    constructor({ archive, auth, host = '127.0.0.1', port = 4248, aeTitle = 'EASISTORE', maxConnections = 8 }) {
        if (!/^[A-Z0-9_ -]{1,16}$/.test(aeTitle)) throw new Error('DIMSE AE title must contain 1–16 uppercase letters, numbers, spaces, _ or -.');
        this.archive = archive; this.auth = auth; this.host = host; this.port = port; this.aeTitle = aeTitle;
        this.maxConnections = maxConnections; this.sockets = new Set();
        this.server = net.createServer(socket => this.accept(socket));
    }
    async listen() {
        await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.host, () => { this.server.off('error', reject); resolve(); }); });
        return this.server.address();
    }
    accept(socket) {
        if (this.sockets.size >= this.maxConnections) { socket.destroy(); return; }
        this.sockets.add(socket); socket.setTimeout(120_000, () => socket.destroy());
        const context = { contexts: new Map(), associated: false, commandChunks: [], commandBytes: 0, store: null, active: null };
        const done = this.receive(socket, context).catch(() => {
            if (!socket.destroyed) socket.end(pdu(7, Buffer.from([0, 0, 2, 0])));
        }).finally(() => {
            context.store?.destroy(new Error('DIMSE association closed.'));
            if (!socket.destroyed) socket.destroy();
            this.sockets.delete(socket);
        });
        socket.on('error', () => {}); socket.finishedTask = done;
    }
    async send(socket, bytes) {
        if (socket.destroyed) throw new Error('Association closed.');
        if (!socket.write(bytes)) await new Promise((resolve, reject) => {
            const cleanup = () => { socket.off('drain', drained); socket.off('close', closed); socket.off('error', errored); };
            const drained = () => { cleanup(); resolve(); };
            const closed = () => { cleanup(); reject(new Error('Association closed.')); };
            const errored = error => { cleanup(); reject(error); };
            socket.once('drain', drained); socket.once('close', closed); socket.once('error', errored);
            if (socket.destroyed) closed();
        });
    }
    async receive(socket, context) {
        let buffer = Buffer.alloc(0);
        for await (const chunk of socket) {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 6) {
                const type = buffer[0], size = buffer.readUInt32BE(2);
                if (size > 1024 * 1024) throw new Error('PDU exceeds receive limit.');
                if (buffer.length < size + 6) break;
                const body = buffer.subarray(6, size + 6); buffer = buffer.subarray(size + 6);
                if (type === 1) await this.associate(socket, context, body);
                else if (type === 4 && context.associated) await this.data(socket, context, body);
                else if (type === 5 && context.associated && !context.active) { await this.send(socket, pdu(6, Buffer.alloc(4))); socket.end(); return; }
                else if (type === 7) return;
                else throw new Error('Unexpected DIMSE PDU.');
            }
        }
    }
    async associate(socket, context, body) {
        if (context.associated || body.length < 68 || body.readUInt16BE(0) !== 1) throw new Error('Invalid association.');
        const called = body.subarray(4, 20).toString('ascii').trim();
        const calling = body.subarray(20, 36).toString('ascii').trim();
        if (called !== this.aeTitle || !/^[\x20-\x7e]{1,16}$/.test(calling)) {
            await this.send(socket, pdu(3, Buffer.from([0, 1, 1, 7]))); socket.end(); return;
        }
        const requestItems = items(body, 68), responses = [];
        const app = requestItems.find(i => i.type === 0x10);
        if (app?.body.toString('ascii') !== '1.2.840.10008.3.1.1.1') throw new Error('Unsupported application context.');
        for (const pc of requestItems.filter(i => i.type === 0x20)) {
            if (pc.body.length < 4) throw new Error('Invalid presentation context.');
            const id = pc.body[0], inner = items(pc.body, 4);
            if (id % 2 === 0 || context.contexts.has(id)) throw new Error('Invalid context ID.');
            const abstract = inner.find(i => i.type === 0x30)?.body.toString('ascii');
            const proposed = inner.filter(i => i.type === 0x40).map(i => i.body.toString('ascii'));
            const transferSyntax = proposed.find(ts => transferSyntaxes.has(ts));
            const storage = abstract?.startsWith('1.2.840.10008.5.1.4.1.1.');
            const accepted = Boolean(transferSyntax && (abstract === verification || storage));
            context.contexts.set(id, { abstract, transferSyntax, accepted });
            responses.push(item(0x21, Buffer.concat([Buffer.from([id, 0, accepted ? 0 : transferSyntax ? 3 : 4, 0]), item(0x40, Buffer.from(transferSyntax || proposed[0] || '1.2.840.10008.1.2'))])));
        }
        if (!responses.length) throw new Error('No presentation contexts.');
        const fixed = Buffer.from(body.subarray(0, 68));
        const max = Buffer.alloc(4); max.writeUInt32BE(1024 * 1024);
        const userInfo = item(0x50, Buffer.concat([item(0x51, max), item(0x52, Buffer.from('2.25.90504590600459060045906004590600459')),
            item(0x55, Buffer.from('EASI_STORE_010'))]));
        await this.send(socket, pdu(2, Buffer.concat([fixed, item(0x10, app.body), ...responses, userInfo])));
        context.associated = true;
    }
    async respond(socket, id, request, status) {
        const elements = [[0x0002, text(request.sopClassUid)], [0x0100, u16(request.field | 0x8000)],
            [0x0120, u16(request.messageId)], [0x0800, u16(0x0101)], [0x0900, u16(status)]];
        if (request.sopUid) elements.push([0x1000, text(request.sopUid)]);
        const command = commandBytes(elements), pdv = Buffer.alloc(6); pdv.writeUInt32BE(command.length + 2); pdv[4] = id; pdv[5] = 3;
        await this.send(socket, pdu(4, Buffer.concat([pdv, command])));
    }
    async data(socket, context, body) {
        let i = 0;
        while (i < body.length) {
            if (i + 6 > body.length) throw new Error('Truncated data value.');
            const length = body.readUInt32BE(i), id = body[i + 4], flags = body[i + 5], end = i + 4 + length;
            if (length < 2 || end > body.length || flags > 3) throw new Error('Invalid data value.');
            const pc = context.contexts.get(id);
            if (!pc?.accepted) throw new Error('Unaccepted context.');
            const bytes = body.subarray(i + 6, end);
            if (flags & 1) {
                if (context.active) throw new Error('Asynchronous operations are not negotiated.');
                if (context.commandId !== undefined && context.commandId !== id) throw new Error('Command context changed.');
                context.commandId = id; context.commandBytes += bytes.length;
                if (context.commandBytes > 65536) throw new Error('Command is too large.');
                context.commandChunks.push(bytes);
                if (flags & 2) {
                    const command = decodeCommand(Buffer.concat(context.commandChunks));
                    context.commandChunks = []; context.commandBytes = 0; context.commandId = undefined;
                    if (!command.messageId || command.sopClassUid !== pc.abstract) throw new Error('Invalid DIMSE command.');
                    if (command.field === 0x0030 && pc.abstract === verification && command.datasetType === 0x0101) await this.respond(socket, id, command, 0);
                    else if (command.field === 0x0001 && pc.abstract !== verification && command.datasetType !== 0x0101 && command.sopUid) {
                        if (!/^([0-9]+\.)+[0-9]+$/.test(command.sopUid) || command.sopUid.length > 64) throw new Error('Invalid SOP UID.');
                        context.active = { command, id, pc, discarded: false };
                    } else { await this.respond(socket, id, command, 0x0122); if (command.datasetType !== 0x0101) throw new Error('Unsupported service.'); }
                }
            } else {
                const active = context.active;
                if (!active || active.id !== id) throw new Error('Unexpected dataset.');
                if (!context.store) {
                    const stream = new PassThrough({ highWaterMark: 65536 });
                    stream.on('error', () => {}); context.store = stream;
                    if (!this.auth?.record) {
                        active.discarded = true; active.outcome = Promise.resolve({ error: { statusCode: 403 } });
                    } else {
                        active.outcome = this.archive.ingest(stream, { source: `dimse:${this.aeTitle}`,
                            expectedSopUid: active.command.sopUid, expectedSopClassUid: active.command.sopClassUid })
                            .then(result => ({ result }), error => { active.discarded = true; stream.destroy(); return { error }; });
                        stream.write(part10Header({ sopUid: active.command.sopUid, sopClassUid: active.command.sopClassUid, transferSyntaxUid: pc.transferSyntax }));
                    }
                }
                if (!active.discarded && !context.store.write(bytes)) {
                    await Promise.race([once(context.store, 'drain'), active.outcome]);
                }
                if (flags & 2) {
                    context.store.end();
                    const outcome = await active.outcome;
                    await this.respond(socket, id, active.command, outcome.error ? outcome.error.statusCode === 409 ? 0x0111 : 0xa700 : 0);
                    context.store.destroy(); context.store = null; context.active = null;
                }
            }
            i = end;
        }
    }
    async close() {
        for (const socket of this.sockets) socket.destroy();
        const tasks = [...this.sockets].map(socket => socket.finishedTask);
        if (this.server.listening) await new Promise(resolve => this.server.close(resolve));
        await Promise.allSettled(tasks);
    }
}
