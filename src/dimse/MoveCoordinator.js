import { normalizeAddress } from '../http/AccessPolicy.js';
import { uidValid } from './wire.js';
import { moveControl, moveError, cancellationError } from './MoveControlScu.js';

const validAe = value => typeof value === 'string' && /^[\x20-\x7e]{1,16}$/.test(value)
  && value.trim() === value && !value.includes('\\');
const abortError = () => Object.assign(new Error('DIMSE retrieval cancelled.'), { name: 'AbortError' });

// One IMAGE-level request per queued instance. Register correlation before the
// command is sent, and quarantine retired IDs to reject late callbacks. The
// callback socket still has to pass StorageScp's independent AE/IP policy.
export class MoveCoordinator {
  constructor({ archive, maxActive = 8, lateCallbackTtlMs = 300000 } = {}) {
    if (!archive || !Number.isInteger(maxActive) || maxActive < 1 || maxActive > 64
      || !Number.isInteger(lateCallbackTtlMs) || lateCallbackTtlMs < 1 || lateCallbackTtlMs > 86400000) throw new Error('Invalid C-MOVE coordinator configuration.');
    Object.assign(this, { archive, maxActive, lateCallbackTtlMs });
    this.receiver = null; this.active = new Map(); this.retired = new Map(); this.originators = new Set(); this.nextId = 1;
    // Allocation precedes the outgoing command and survives a process restart.
    // Otherwise a delayed callback from the previous process could match the
    // same AE/message ID (and same requested instance) in a resumed queue job.
    archive.db.exec(`CREATE TABLE IF NOT EXISTS dimse_move_ids (
      originator TEXT NOT NULL, messageId INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
      PRIMARY KEY(originator,messageId));
      CREATE TABLE IF NOT EXISTS dimse_move_originators (aeTitle TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO dimse_move_originators SELECT DISTINCT originator FROM dimse_move_ids;
      CREATE TABLE IF NOT EXISTS dimse_move_state (id INTEGER PRIMARY KEY CHECK(id=1), nextId INTEGER NOT NULL);
      INSERT OR IGNORE INTO dimse_move_state SELECT 1,(COALESCE(MAX(messageId),0)%65535)+1 FROM dimse_move_ids;`);
    for (const row of archive.db.prepare('SELECT aeTitle FROM dimse_move_originators').all()) this.originators.add(row.aeTitle);
    if (this.originators.size > 256) throw moveError('move-state-failure');
    this.nextId = archive.db.prepare('SELECT nextId FROM dimse_move_state WHERE id=1').get().nextId;
  }
  attach(receiver) {
    if (this.receiver && this.receiver !== receiver) throw new Error('C-MOVE already has an attached receiver.');
    this.registerOriginator(receiver.aeTitle); this.receiver = receiver;
  }
  registerOriginator(aeTitle) {
    if (this.originators.has(aeTitle)) return;
    if (this.originators.size >= 256) throw moveError('move-capacity');
    try { this.archive.db.prepare('INSERT INTO dimse_move_originators VALUES (?)').run(aeTitle); }
    catch { throw moveError('move-state-failure'); }
    this.originators.add(aeTitle);
  }
  detach(receiver) {
    if (this.receiver !== receiver) return;
    this.receiver = null;
    for (const entry of this.active.values()) entry.controller.abort(moveError('move-receiver-closed'));
  }
  getState() {
    const receiver = this.receiver, address = receiver?.server.address();
    const available = !!(receiver?.server.listening && !receiver.closing && receiver.archiveReady());
    return { available, active: this.active.size, maxActive: this.maxActive,
      destinationAeTitle: receiver?.aeTitle ?? null, host: typeof address === 'object' ? address?.address ?? null : null,
      port: typeof address === 'object' ? address?.port ?? null : null };
  }
  preflight() {
    const state = this.getState();
    if (!state.available) throw moveError('move-receiver-unavailable');
    return state;
  }
  allocate(originator, timeoutMs) {
    this.registerOriginator(originator);
    const now = Date.now();
    for (const [key, expires] of this.retired) if (expires <= now) this.retired.delete(key);
    this.archive.db.prepare('DELETE FROM dimse_move_ids WHERE expiresAt<=?').run(now);
    if (this.archive.db.prepare('SELECT COUNT(*) AS count FROM dimse_move_ids').get().count >= 65535) throw moveError('move-capacity');
    for (let attempt = 0; attempt < 65535; attempt++) {
      const messageId = this.nextId; this.nextId = messageId % 65535 + 1;
      const key = JSON.stringify([originator, messageId]);
      if (!this.active.has(key) && !this.retired.has(key)
        && !this.archive.db.prepare('SELECT 1 FROM dimse_move_ids WHERE originator=? AND messageId=?').get(originator,messageId)) {
        this.archive.db.prepare('INSERT INTO dimse_move_ids VALUES (?,?,?)').run(originator,messageId,now + timeoutMs + this.lateCallbackTtlMs);
        this.archive.db.prepare('UPDATE dimse_move_state SET nextId=? WHERE id=1').run(this.nextId);
        return { key, messageId };
      }
    }
    throw moveError('move-capacity');
  }
  async retrieve(association, item, { signal, source = `dimse:${association?.calledAeTitle}`, onProgress } = {}) {
    if (signal?.aborted) throw cancellationError(signal);
    const receiver = this.receiver, state = this.preflight();
    const callingAeTitle = association.callingAeTitle ?? 'EASISTORE', sopClassUid = item?.sopClassUid ??
      (item?.storageSopClassUids?.length === 1 ? item.storageSopClassUids[0] : null);
    if (![item?.studyUid, item?.seriesUid, item?.sopUid, sopClassUid].every(uidValid)
      || !validAe(association.calledAeTitle) || !validAe(callingAeTitle)
      || typeof source !== 'string' || !source.length || source.length > 128
      || !['study-root', 'patient-root'].includes(item.queryRetrieveModel ?? 'study-root')) throw moveError('move-profile-invalid');
    if (this.active.size >= this.maxActive) throw moveError('move-capacity');
    const timeoutMs = association.timeoutMs ?? 30000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw moveError('move-profile-invalid');
    let allocation;
    try { allocation = this.allocate(callingAeTitle, timeoutMs); }
    catch (error) { throw error.code === 'move-capacity' ? error : moveError('move-state-failure'); }
    const { key, messageId } = allocation, controller = new AbortController();
    const entry = { key, messageId, controller, receiver, originator: callingAeTitle, callingAeTitle: association.calledAeTitle,
      selection: { studyUid: item.studyUid, seriesUid: item.seriesUid, sopUid: item.sopUid, sopClassUid, queryRetrieveModel: item.queryRetrieveModel },
      source, claimed: false, outcome: null, remoteAddress: null, cancelClaim: null, claimSettled: null };
    this.originators.add(callingAeTitle); this.active.set(key, entry);
    const abort = () => { controller.abort(signal?.reason instanceof Error ? signal.reason : abortError()); };
    const cancelClaim = () => entry.cancelClaim?.();
    controller.signal.addEventListener('abort', cancelClaim, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(moveError(entry.claimed ? 'move-timeout' : 'move-no-callback')), timeoutMs); timer.unref();
    let releaseImport;
    try {
      // A pending remote callback is an import too: study removal must not race
      // the interval between the outgoing request and the first Storage PDV.
      releaseImport = this.archive.acquireImportReservation();
      const task = moveControl({ ...association, callingAeTitle }, entry.selection, {
        destinationAeTitle: state.destinationAeTitle, messageId, signal: controller.signal,
        onConnected: async ({ remoteAddress }) => {
          entry.remoteAddress = normalizeAddress(remoteAddress);
          if (!entry.remoteAddress || this.receiver !== receiver || !this.getState().available) throw moveError('move-receiver-unavailable');
          const trusted = await receiver.associationPolicy({ callingAeTitle: entry.callingAeTitle,
            calledAeTitle: state.destinationAeTitle, remoteAddress: entry.remoteAddress });
          if (!trusted) throw moveError('move-callback-not-trusted');
        }
      });
      entry.controlTask = task;
      const final = await task;
      if (controller.signal.aborted) throw cancellationError(controller.signal);
      if (final.status === 0xa801) throw moveError('move-destination-unknown', { dimseStatus: final.status });
      if (entry.outcome?.error) throw moveError('move-receive-failure', { dimseStatus: final.status });
      if (final.status !== 0) throw moveError('move-peer-failure', { dimseStatus: final.status });
      if (!entry.outcome?.result) throw moveError('move-no-callback');
      if (final.completed !== undefined && final.completed !== 1 || final.failed !== undefined && final.failed !== 0
        || final.warning !== undefined && final.warning !== 0 || final.remaining !== undefined && final.remaining !== 0
        || final.failedSopInstanceUids?.length) throw moveError('move-protocol-error');
      const duplicate = entry.outcome.result.status === 'duplicate';
      const result = { status: 0, completed: 1, failed: 0, warning: 0, remaining: 0,
        stored: duplicate ? 0 : 1, duplicates: duplicate ? 1 : 0, failedSopInstanceUids: [] };
      onProgress?.({ ...result });
      return result;
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      // Never let an in-flight durable callback outlive the queue operation.
      // Destroying its socket also tears down the receiving spool stream.
      entry.cancelClaim?.();
      if (entry.claimSettled) await entry.claimSettled;
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancelClaim);
      const expires = Date.now() + this.lateCallbackTtlMs;
      this.active.delete(key); this.retired.set(key, expires);
      try {
        this.archive.db.prepare('UPDATE dimse_move_ids SET expiresAt=? WHERE originator=? AND messageId=?').run(expires,callingAeTitle,messageId);
      } catch { throw moveError('move-state-failure');
      } finally { releaseImport?.(); }
    }
  }
  claimStore({ command, callingAeTitle, remoteAddress, cancel }) {
    const originator = command.moveOriginatorAeTitle, messageId = command.moveOriginatorMessageId;
    if (originator === undefined && messageId === undefined) return null;
    if (!validAe(originator) || !Number.isInteger(messageId) || messageId < 1 || messageId > 65535) throw moveError('move-protocol-error');
    const key = JSON.stringify([originator, messageId]), entry = this.active.get(key);
    if (!entry) {
      if (this.originators.has(originator) || this.retired.has(key)
        || [...this.active.values()].some(value => value.selection.sopUid === command.sopUid)) throw moveError('move-protocol-error');
      // A separately initiated third-party C-MOVE may legitimately target this
      // archive. It is an ordinary authorized import, never this job's result.
      return null;
    }
    if (entry.controller.signal.aborted || this.receiver !== entry.receiver || entry.claimed
      || !entry.remoteAddress || normalizeAddress(remoteAddress) !== entry.remoteAddress || callingAeTitle !== entry.callingAeTitle
      || command.sopUid !== entry.selection.sopUid || command.sopClassUid !== entry.selection.sopClassUid) throw moveError('move-protocol-error');
    entry.claimed = true; entry.cancelClaim = cancel;
    let settle;
    entry.claimSettled = new Promise(resolve => { settle = resolve; });
    let finished = false;
    return {
      options: { source: entry.source, expectedStudyUid: entry.selection.studyUid, expectedSeriesUid: entry.selection.seriesUid,
        expectedSopUid: entry.selection.sopUid, expectedSopClassUid: entry.selection.sopClassUid },
      finish: outcome => {
        if (finished) return; finished = true;
        const instance = outcome?.result?.instance;
        if (!outcome?.error && (!['stored', 'duplicate'].includes(outcome?.result?.status) || !instance
          || instance.studyUid !== entry.selection.studyUid || instance.seriesUid !== entry.selection.seriesUid
          || instance.sopUid !== entry.selection.sopUid || instance.sopClassUid !== entry.selection.sopClassUid)) outcome = { error: moveError('move-receive-failure') };
        entry.outcome = outcome; entry.cancelClaim = null; settle();
      }
    };
  }
  async close() {
    const entries = [...this.active.values()];
    for (const entry of entries) entry.controller.abort(moveError('move-receiver-closed'));
    await Promise.allSettled(entries.flatMap(entry => [entry.controlTask, entry.claimSettled]).filter(Boolean));
    this.receiver = null;
  }
}
