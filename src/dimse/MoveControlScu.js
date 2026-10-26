// C-MOVE control association only. Image callbacks are handled by StorageScp's
// existing durable archive receiver, never by a second in-memory receiver.
import net from 'node:net';
import { APPLICATION, IMPLEMENTATION, IMPLICIT, EXPLICIT, QUERY_MODELS, u16, text,
  item, items, pdu, commandBytes, decodeCommand, send, sendMessage } from './wire.js';
import { encodeIdentifier, parseIdentifier } from './query.js';

const messages = {
  'move-receiver-unavailable': 'C-MOVE requires this Store’s active DIMSE receiver.',
  'move-callback-not-trusted': 'The configured DIMSE source is not trusted to send C-MOVE callbacks to this receiver.',
  'move-profile-invalid': 'C-MOVE requires an enumerated instance with study, series, SOP instance and SOP class UIDs.',
  'move-capacity': 'The C-MOVE receiver has reached its active-operation limit.',
  'move-timeout': 'C-MOVE retrieval timed out before a verified final outcome.',
  'move-no-callback': 'No matching C-MOVE callback was received. Check the remote destination AE, receiver address, port and firewall.',
  'move-protocol-error': 'The peer returned an invalid or inconsistent C-MOVE response.',
  'move-peer-failure': 'The peer did not complete C-MOVE retrieval successfully.',
  'move-peer-unavailable': 'The configured DIMSE peer could not complete the C-MOVE connection.',
  'move-destination-unknown': 'The peer does not recognize this Store’s C-MOVE destination AE. Configure its receiver address and port on the peer.',
  'move-receive-failure': 'The C-MOVE instance was not durably accepted by this archive.',
  'move-receiver-closed': 'The local C-MOVE receiver stopped before retrieval completed.',
  'move-state-failure': 'The C-MOVE operation state could not be durably recorded. Check archive storage before retrying.'
};
export function moveError(code, details = {}) {
  return Object.assign(new Error(messages[code] ?? messages['move-protocol-error']), { code, ...details });
}
export function cancellationError(signal) {
  return signal?.reason?.code && Object.hasOwn(messages, signal.reason.code) ? signal.reason
    : Object.assign(new Error('DIMSE retrieval cancelled.'), { name: 'AbortError' });
}
const protocolError = () => moveError('move-protocol-error');

async function* readPdus(socket) {
  let buffer = Buffer.alloc(0);
  for await (const bytes of socket) {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 6) {
      const length = buffer.readUInt32BE(2);
      if (length > 1024 * 1024 || buffer[1] !== 0) throw protocolError();
      if (buffer.length < length + 6) break;
      const result = { type: buffer[0], body: buffer.subarray(6, length + 6) };
      buffer = buffer.subarray(length + 6); yield result;
    }
  }
  throw moveError('move-peer-unavailable');
}

export async function moveControl(association, selection, { destinationAeTitle, messageId,
  signal, onConnected, onPending, cancelGraceMs = 500 } = {}) {
  if (signal?.aborted) throw cancellationError(signal);
  const { host, port, calledAeTitle, callingAeTitle = 'EASISTORE', timeoutMs = 30000 } = association;
  const model = selection.queryRetrieveModel ?? 'study-root';
  const abstract = [...QUERY_MODELS].find(([, value]) => value.model === model && value.operation === 0x21)?.[0];
  if (!abstract) throw moveError('move-profile-invalid');
  const socket = net.createConnection({ host, port }), iterator = readPdus(socket)[Symbol.asyncIterator]();
  socket.on('error', () => {});
  let peerMax = 16384, requested = false, cancelTimer, canceled = false;
  const cancel = () => {
    if (canceled) return; canceled = true;
    if (!requested) { socket.destroy(cancellationError(signal)); return; }
    sendMessage(socket, 1, commandBytes([[0x100, u16(0x0fff)], [0x120, u16(messageId)], [0x800, u16(0x101)]]), true, peerMax)
      .catch(() => socket.destroy());
    cancelTimer = setTimeout(() => socket.destroy(cancellationError(signal)), cancelGraceMs); cancelTimer.unref();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  socket.setTimeout(timeoutMs, () => socket.destroy(moveError('move-timeout')));
  const next = async () => (await iterator.next()).value;
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    if (signal?.aborted) throw cancellationError(signal);
    await onConnected?.({ remoteAddress: socket.remoteAddress });
    if (signal?.aborted) throw cancellationError(signal);
    const fixed = Buffer.alloc(68); fixed.writeUInt16BE(1); fixed.fill(32, 4, 36);
    fixed.write(calledAeTitle, 4, 'ascii'); fixed.write(callingAeTitle, 20, 'ascii');
    const maximum = Buffer.alloc(4); maximum.writeUInt32BE(16384);
    await send(socket, pdu(1, Buffer.concat([fixed, item(0x10, Buffer.from(APPLICATION)),
      item(0x20, Buffer.concat([Buffer.from([1, 0, 0, 0]), item(0x30, Buffer.from(abstract)),
        item(0x40, Buffer.from(EXPLICIT)), item(0x40, Buffer.from(IMPLICIT))])),
      item(0x50, Buffer.concat([item(0x51, maximum), item(0x52, Buffer.from(IMPLEMENTATION))]))])));
    const ac = await next();
    if (ac.type === 3) throw moveError('move-peer-failure');
    if (ac.type !== 2 || ac.body.length < 68 || ac.body.readUInt16BE() !== 1) throw protocolError();
    const parts = items(ac.body, 68), contexts = parts.filter(value => value.type === 0x21);
    if (parts.filter(value => value.type === 0x10).length !== 1 || parts.find(value => value.type === 0x10).body.toString('ascii') !== APPLICATION
      || contexts.length !== 1 || contexts[0].body.length < 4 || contexts[0].body[0] !== 1) throw protocolError();
    const context = contexts[0], syntaxes = items(context.body, 4).filter(value => value.type === 0x40);
    if (context.body[2] !== 0) throw moveError('move-peer-failure');
    const syntax = syntaxes[0]?.body.toString('ascii');
    if (syntaxes.length !== 1 || ![EXPLICIT, IMPLICIT].includes(syntax)) throw protocolError();
    const user = parts.find(value => value.type === 0x50);
    for (const value of user ? items(user.body) : []) if (value.type === 0x51) {
      if (value.body.length !== 4) throw protocolError();
      peerMax = value.body.readUInt32BE() || 16384;
      if (peerMax < 8) throw protocolError();
      peerMax = Math.min(peerMax, 1024 * 1024);
    }
    const identifier = { '00080052': 'IMAGE', '0020000D': selection.studyUid,
      '0020000E': selection.seriesUid, '00080018': selection.sopUid };
    requested = true;
    await sendMessage(socket, 1, commandBytes([[2, text(abstract)], [0x100, u16(0x21)],
      [0x110, u16(messageId)], [0x600, text(destinationAeTitle, 32)], [0x700, u16(0)], [0x800, u16(0)]]), true, peerMax);
    await sendMessage(socket, 1, encodeIdentifier(identifier, syntax), false, peerMax);
    if (signal?.aborted) cancel();
    let commandChunks = [], commandSize = 0, final, failedParts = [], failedSize = 0, expectingIdentifier = false;
    while (!final || expectingIdentifier) {
      const message = await next();
      if (message.type !== 4) throw protocolError();
      for (let offset = 0; offset < message.body.length;) {
        if (offset + 6 > message.body.length) throw protocolError();
        const length = message.body.readUInt32BE(offset), id = message.body[offset + 4], flags = message.body[offset + 5], end = offset + length + 4;
        if (id !== 1 || length <= 2 || end > message.body.length || flags > 3) throw protocolError();
        const bytes = message.body.subarray(offset + 6, end); offset = end;
        if (flags & 1) {
          if (final || expectingIdentifier) throw protocolError();
          commandSize += bytes.length;
          if (commandSize > 65536) throw protocolError();
          commandChunks.push(bytes);
          if (!(flags & 2)) continue;
          const response = decodeCommand(Buffer.concat(commandChunks)); commandChunks = []; commandSize = 0;
          if (response.field !== 0x8021 || response.respondedTo !== messageId || response.sopClassUid !== abstract
            || response.status === undefined || ![0, 0x101].includes(response.datasetType)) throw protocolError();
          const count = tag => {
            const value = response.elements.get(tag);
            if (value && value.length !== 2) throw protocolError();
            return value?.readUInt16LE();
          };
          const state = { status: response.status, completed: count(0x1021), failed: count(0x1022), warning: count(0x1023), remaining: count(0x1020) };
          if (response.status === 0xff00) {
            if (response.datasetType !== 0x101 || Object.values(state).some(value => value === undefined)
              || state.completed + state.failed + state.warning + state.remaining > 1) throw protocolError();
            onPending?.(state);
          } else {
            if (response.status === 0xff01 || response.status === 0 && response.datasetType !== 0x101) throw protocolError();
            final = state; expectingIdentifier = response.datasetType !== 0x101;
          }
        } else {
          if (!expectingIdentifier || !final || commandSize) throw protocolError();
          failedSize += bytes.length;
          if (failedSize > 1024 * 1024) throw protocolError();
          failedParts.push(bytes);
          if (flags & 2) {
            const values = parseIdentifier(Buffer.concat(failedParts), syntax);
            if ([...values.keys()].some(key => key !== '00080058')) throw protocolError();
            final.failedSopInstanceUids = values.get('00080058')?.split('\\') ?? [];
            if (final.failedSopInstanceUids.length > 1 || final.failedSopInstanceUids.some(uid => uid !== selection.sopUid)) throw protocolError();
            expectingIdentifier = false;
          }
        }
      }
    }
    if (signal?.aborted) throw cancellationError(signal);
    await send(socket, pdu(5, Buffer.alloc(4)));
    if ((await next()).type !== 6) throw protocolError();
    return final;
  } catch (error) {
    if (signal?.aborted) throw cancellationError(signal);
    if (Object.hasOwn(messages, error.code)) throw error;
    throw moveError(error.code && /^(ECONN|EHOST|ENET|EAI_|ENOTFOUND|ETIMEDOUT)/.test(error.code) ? 'move-peer-unavailable' : 'move-protocol-error');
  } finally {
    clearTimeout(cancelTimer); signal?.removeEventListener('abort', cancel); socket.destroy();
    await iterator.return?.().catch(() => {});
  }
}
