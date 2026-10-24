// Independent, bounded DICOM Upper Layer helpers. Commands always use Implicit VR LE.
import net from 'node:net';
import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

export const IMPLICIT = '1.2.840.10008.1.2';
export const EXPLICIT = '1.2.840.10008.1.2.1';
export const VERIFICATION = '1.2.840.10008.1.1';
export const APPLICATION = '1.2.840.10008.3.1.1.1';
export const IMPLEMENTATION = '2.25.90504590600459060045906004590600459';
export const QUERY_MODELS = new Map([
  ['1.2.840.10008.5.1.4.1.2.1.1', { operation: 0x20, model: 'patient-root' }],
  ['1.2.840.10008.5.1.4.1.2.1.2', { operation: 0x21, model: 'patient-root' }],
  ['1.2.840.10008.5.1.4.1.2.1.3', { operation: 0x10, model: 'patient-root' }],
  ['1.2.840.10008.5.1.4.1.2.2.1', { operation: 0x20, model: 'study-root' }],
  ['1.2.840.10008.5.1.4.1.2.2.2', { operation: 0x21, model: 'study-root' }],
  ['1.2.840.10008.5.1.4.1.2.2.3', { operation: 0x10, model: 'study-root' }],
]);
export const TRANSFER_SYNTAXES = new Set([IMPLICIT, EXPLICIT, '1.2.840.10008.1.2.2',
  '1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51', '1.2.840.10008.1.2.4.57',
  '1.2.840.10008.1.2.4.70', '1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81',
  '1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91', '1.2.840.10008.1.2.5']);
export const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
export const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
export const text = (value, pad = 0) => { const b = Buffer.from(value ?? '', 'utf8'); return b.length % 2 ? Buffer.concat([b, Buffer.from([pad])]) : b; };
export const uidValid = value => typeof value === 'string' && value.length <= 64 && /^[0-9]+(?:\.[0-9]+)+$/.test(value);
export function commandBytes(elements) {
  const encode = (tag, value) => { const b = Buffer.alloc(8); b.writeUInt16LE(tag, 2); b.writeUInt32LE(value.length, 4); return Buffer.concat([b, value]); };
  const body = Buffer.concat(elements.map(([tag, value]) => encode(tag, value)));
  return Buffer.concat([encode(0, u32(body.length)), body]);
}
export function decodeCommand(bytes) {
  const elements = new Map(); let i = 0;
  while (i + 8 <= bytes.length) {
    const tag = bytes.readUInt16LE(i + 2), length = bytes.readUInt32LE(i + 4), end = i + 8 + length;
    if (bytes.readUInt16LE(i) !== 0 || end > bytes.length || elements.has(tag)) throw new Error('Invalid DIMSE command.');
    elements.set(tag, bytes.subarray(i + 8, end)); i = end;
  }
  if (i !== bytes.length) throw new Error('Truncated DIMSE command.');
  const us = tag => { const value = elements.get(tag); if (value === undefined) return undefined; if (value.length !== 2) throw new Error('Invalid command US.'); return value.readUInt16LE(); };
  const str = tag => elements.get(tag)?.toString('ascii').replace(/[\0 ]+$/, '');
  return { field: us(0x0100), messageId: us(0x0110), respondedTo: us(0x0120), datasetType: us(0x0800), status: us(0x0900),
    priority: us(0x0700), sopClassUid: str(0x0002), sopUid: str(0x1000), moveDestination: str(0x0600), elements };
}
export function item(type, body) { const h = Buffer.alloc(4); h[0] = type; h.writeUInt16BE(body.length, 2); return Buffer.concat([h, body]); }
export function items(bytes, start = 0) {
  const result = []; let i = start;
  while (i < bytes.length) {
    if (i + 4 > bytes.length) throw new Error('Invalid association item.');
    const length = bytes.readUInt16BE(i + 2); if (i + 4 + length > bytes.length) throw new Error('Invalid association item length.');
    result.push({ type: bytes[i], body: bytes.subarray(i + 4, i + 4 + length) }); i += 4 + length;
  }
  return result;
}
export function pdu(type, body) { const h = Buffer.alloc(6); h[0] = type; h.writeUInt32BE(body.length, 2); return Buffer.concat([h, body]); }
export async function send(socket, bytes) {
  if (socket.destroyed) throw new Error('DIMSE association closed.');
  if (!socket.write(bytes)) await new Promise((resolve, reject) => {
    const cleanup = () => { socket.off('drain', drained); socket.off('close', closed); socket.off('error', errored); };
    const drained = () => { cleanup(); resolve(); }, closed = () => { cleanup(); reject(new Error('DIMSE association closed.')); }, errored = error => { cleanup(); reject(error); };
    socket.once('drain', drained); socket.once('close', closed); socket.once('error', errored);
    if (socket.destroyed) closed();
  });
}
export async function sendMessage(socket, id, bytes, isCommand, maxPdu = 16384) {
  const chunkSize = Math.max(1, Math.min(maxPdu || 16384, 1024 * 1024) - 6);
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize), h = Buffer.alloc(6);
    h.writeUInt32BE(chunk.length + 2); h[4] = id; h[5] = (isCommand ? 1 : 0) | (offset + chunk.length === bytes.length ? 2 : 0);
    await send(socket, pdu(4, Buffer.concat([h, chunk])));
  }
}
export async function dataSetOffset(path) {
  const handle = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(132); if ((await handle.read(prefix, 0, 132, 0)).bytesRead !== 132 || prefix.toString('ascii', 128) !== 'DICM') throw new Error('Stored DICOM Part 10 header is invalid.');
    let offset = 132;
    for (;;) {
      const h = Buffer.alloc(12), { bytesRead } = await handle.read(h, 0, 12, offset);
      if (bytesRead < 8 || offset > 1024 * 1024) throw new Error('Stored File Meta Information is invalid.');
      if (h.readUInt16LE(0) !== 2) return offset;
      const vr = h.toString('ascii', 4, 6), long = ['OB','OD','OF','OL','OV','OW','SQ','UC','UN','UR','UT','SV','UV'].includes(vr);
      const length = long ? h.readUInt32LE(8) : h.readUInt16LE(6);
      if (length > 1024 * 1024 || length % 2) throw new Error('Stored File Meta Information exceeds the limit.');
      offset += (long ? 12 : 8) + length;
    }
  } finally { await handle.close(); }
}
export async function sendStoredData(socket, id, path, maxPdu = 16384) {
  const start = await dataSetOffset(path), chunkSize = Math.max(1, Math.min(maxPdu || 16384, 1024 * 1024) - 6);
  let previous;
  const stream = createReadStream(path, { start, highWaterMark: chunkSize });
  const closed = () => stream.destroy(new Error('DIMSE association closed.'));
  socket.once('close', closed);
  try {
    for await (const chunk of stream) {
      if (previous) { const h = Buffer.alloc(6); h.writeUInt32BE(previous.length + 2); h[4] = id; await send(socket, pdu(4, Buffer.concat([h, previous]))); }
      previous = chunk;
    }
    if (!previous?.length) throw new Error('Stored DICOM dataset is empty.');
    const h = Buffer.alloc(6); h.writeUInt32BE(previous.length + 2); h[4] = id; h[5] = 2;
    await send(socket, pdu(4, Buffer.concat([h, previous])));
  } finally { socket.off('close', closed); stream.destroy(); }
}

// One bounded, sequential outgoing association. Original dataset bytes are streamed from disk.
export async function sendStoredInstance(association, record, { signal, moveOriginatorAeTitle, moveOriginatorMessageId, priority = 0 } = {}) {
  if (![0,1,2].includes(priority)) throw new Error('Invalid DIMSE priority.');
  if (!record?.path || !uidValid(record.sopClassUid) || !uidValid(record.sopUid) || !TRANSFER_SYNTAXES.has(record.transferSyntaxUid)) throw new Error('Invalid stored instance.');
  const { host, port, calledAeTitle, callingAeTitle = 'EASISTORE', timeoutMs = 30000 } = association;
  for (const ae of [calledAeTitle, callingAeTitle]) if (typeof ae !== 'string' || !/^[\x20-\x7e]{1,16}$/.test(ae) || ae.includes('\\')) throw new Error('Invalid DIMSE AE title.');
  if (signal?.aborted) throw Object.assign(new Error('Transfer cancelled.'), { name: 'AbortError' });
  const socket = net.createConnection({ host, port });
  let buffer = Buffer.alloc(0), failure, waiting; const queue = [];
  const fail = error => { failure = error; if (waiting) { const waiter = waiting; waiting = null; waiter.reject(error); } };
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 6) {
      const length = buffer.readUInt32BE(2); if (length > 1024 * 1024) { socket.destroy(new Error('Peer PDU exceeds receive limit.')); return; }
      if (buffer.length < length + 6) return;
      const value = { type: buffer[0], body: buffer.subarray(6, length + 6) }; buffer = buffer.subarray(length + 6);
      if (waiting) { const waiter = waiting; waiting = null; waiter.resolve(value); } else if (queue.length < 128) queue.push(value); else socket.destroy(new Error('Too many unsolicited DIMSE PDUs.'));
    }
  });
  socket.on('error', fail); socket.on('close', () => fail(new Error('DIMSE peer closed the association.')));
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('DIMSE operation timed out.')));
  const abort = () => socket.destroy(Object.assign(new Error('Transfer cancelled.'), { name: 'AbortError' })); signal?.addEventListener('abort', abort, { once: true });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : failure ? Promise.reject(failure) : new Promise((resolve, reject) => { waiting = { resolve, reject }; });
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    if (signal?.aborted) abort();
    const fixed = Buffer.alloc(68); fixed.writeUInt16BE(1); fixed.fill(32, 4, 36); fixed.write(calledAeTitle, 4, 'ascii'); fixed.write(callingAeTitle, 20, 'ascii');
    const max = Buffer.alloc(4); max.writeUInt32BE(16384);
    await send(socket, pdu(1, Buffer.concat([fixed, item(0x10, Buffer.from(APPLICATION)), item(0x20, Buffer.concat([Buffer.from([1,0,0,0]), item(0x30, Buffer.from(record.sopClassUid)), item(0x40, Buffer.from(record.transferSyntaxUid))])), item(0x50, Buffer.concat([item(0x51, max), item(0x52, Buffer.from(IMPLEMENTATION))]))])));
    const response = await next(); if (response.type !== 2 || response.body.length < 68) throw new Error('DIMSE destination rejected the association.');
    const accepted = items(response.body, 68), pc = accepted.find(value => value.type === 0x21 && value.body[0] === 1);
    const chosenSyntax = pc && items(pc.body, 4).find(value => value.type === 0x40)?.body.toString('ascii');
    if (!pc || pc.body[2] !== 0 || chosenSyntax !== record.transferSyntaxUid) throw new Error('DIMSE destination rejected the original transfer syntax.');
    const peerUser = accepted.find(value => value.type === 0x50), peerMaxItem = peerUser && items(peerUser.body).find(value => value.type === 0x51);
    const peerMax = peerMaxItem?.body.length === 4 ? peerMaxItem.body.readUInt32BE() || 16384 : 16384;
    const fields = [[2,text(record.sopClassUid)],[0x100,u16(1)],[0x110,u16(1)],[0x700,u16(priority)],[0x800,u16(0)],[0x1000,text(record.sopUid)]];
    if (moveOriginatorAeTitle) fields.push([0x1030,text(moveOriginatorAeTitle,32)], [0x1031,u16(moveOriginatorMessageId)]);
    await sendMessage(socket, 1, commandBytes(fields), true, peerMax); await sendStoredData(socket, 1, record.path, peerMax);
    const chunks = []; let size = 0, result;
    while (!result) {
      const received = await next(); if (received.type !== 4) throw new Error('Unexpected response during C-STORE.');
      for (let i = 0; i < received.body.length;) {
        if (i + 6 > received.body.length) throw new Error('Truncated C-STORE response PDV.');
        const length = received.body.readUInt32BE(i), end = i + 4 + length, flags = received.body[i + 5];
        if (length < 2 || end > received.body.length || received.body[i + 4] !== 1 || !(flags & 1) || flags > 3) throw new Error('Invalid C-STORE response PDV.');
        chunks.push(received.body.subarray(i + 6,end)); size += length - 2; if (size > 65536) throw new Error('C-STORE response exceeds limit.');
        if (flags & 2) { result = decodeCommand(Buffer.concat(chunks)); if (result.field !== 0x8001 || result.respondedTo !== 1 || result.sopClassUid !== record.sopClassUid || result.sopUid !== record.sopUid || result.datasetType !== 0x101 || result.status === undefined) throw new Error('Mismatched C-STORE response.'); }
        i = end;
      }
    }
    await send(socket,pdu(5,Buffer.alloc(4))); if ((await next()).type !== 6) throw new Error('DIMSE release was not acknowledged.');
    return { status: result.status, ok: result.status === 0 || (result.status & 0xf000) === 0xb000 };
  } finally { signal?.removeEventListener('abort', abort); socket.destroy(); }
}
