import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveViewerController } from '../ui/ArchiveViewerController.ts';
import { deletionBody, deletionPreview, deletionResult, studyExportPath } from '../ui/StudyWorkflow.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
const selection = { studyUid: '2.25.1001', seriesUid: '2.25.2001' };
function fixture(overrides = {}) {
  const calls = [], errors = [], loading = [], handlers = new Map();
  const viewer = { ready: Promise.resolve(), pause() { calls.push(['pause']); },
    async disconnectArchive() { calls.push(['disconnect']); },
    configureArchive(config) { calls.push(['configure', config]); },
    async openArchiveSeries(...args) { calls.push(['series', ...args]); },
    async applyStudyContext(...args) { calls.push(['context', ...args]); },
    getState() { return { image: { rows: 512, columns: 512 }, frameCount: 12000, frameIndex: 0 }; },
    on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name); },
    dispose() { calls.push(['dispose']); }, ...overrides };
  const controller = new ArchiveViewerController({ mount: {}, origin: 'http://127.0.0.1:8048', wholeSeries: true,
    loadSdk: async () => ({ createViewer(mount, options) { calls.push(['create', options]); return viewer; } }),
    onLoading: value => loading.push(value), onError: value => errors.push(value) });
  return { controller, viewer, calls, errors, loading, handlers };
}

test('large-series opening delegates lazy metadata and on-demand original retrieval to the published SDK without altering its limits', async () => {
  const f = fixture(); try {
    const state = await f.controller.open(selection); await tick();
    assert.equal(state.frameCount, 12000);
    assert.deepEqual(f.calls.filter(call => call[0] === 'series'), [['series', selection.studyUid, selection.seriesUid]]);
    assert.deepEqual(f.calls.find(call => call[0] === 'configure')[1], { baseUrl: 'http://127.0.0.1:8048/dicomweb/', credentials: 'same-origin', retrievalMode: 'instance' });
    assert.equal(f.calls.find(call => call[0] === 'create')[1].initialDemo, null);
    assert.deepEqual(f.loading, [true, false]); assert.deepEqual(f.errors, []);
  } finally { f.controller.dispose(); }
});

test('a selected instance uses its exact SOP and original frame identity, not an assumed series sort position', async () => {
  const f = fixture(); try {
    await f.controller.open({ ...selection, sopUid: '2.25.3999' });
    const [, context, options] = f.calls.find(call => call[0] === 'context');
    assert.deepEqual(context.viewports[0], { slot: 0, reference: { archiveKey: 'easi-store', ...selection, sopUid: '2.25.3999' }, frameIndex: 0, originalFrameNumber: 1 });
    assert.deepEqual(options.scope, context.viewports[0].reference); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(f.calls.some(call => call[0] === 'series'), false);
  } finally { f.controller.dispose(); }
});

test('a newer instance selection cancels pending exact-instance work and cannot publish the previous result', async () => {
  let calls = 0, firstSignal;
  const f = fixture({ applyStudyContext(_context, { signal }) {
    if (++calls > 1) return Promise.resolve(); firstSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true }));
  } });
  try {
    const first = f.controller.open({ ...selection, sopUid: '2.25.3001' }); const canceled = assert.rejects(first, { name: 'AbortError' });
    await tick(); const second = f.controller.open({ ...selection, sopUid: '2.25.3002' });
    await second; await canceled; await tick(); assert.equal(firstSignal.aborted, true);
    assert.equal(calls, 2); assert.deepEqual(f.errors, []); assert.deepEqual(f.loading, [true, true, false]);
  } finally { f.controller.dispose(); }
});

test('superseding a whole-series load disconnects its archive reader before opening another source', async () => {
  let rejectFirst, opened = 0, active = false;
  const f = fixture({
    async disconnectArchive() { if (active) { active = false; rejectFirst(new DOMException('Canceled', 'AbortError')); } },
    openArchiveSeries() { if (++opened > 1) return Promise.resolve(); active = true; return new Promise((_resolve, reject) => { rejectFirst = reject; }); }
  });
  try {
    const first = f.controller.open(selection), canceled = assert.rejects(first, { name: 'AbortError' }); await tick();
    await f.controller.open({ ...selection, seriesUid: '2.25.2002' }); await canceled; await tick();
    assert.equal(opened, 2); assert.deepEqual(f.errors, []);
  } finally { f.controller.dispose(); }
});

test('disposal before SDK import prevents mounting and disposal during image loading aborts and silences late events', async () => {
  let finish, created = false;
  const controller = new ArchiveViewerController({ mount: {}, origin: 'http://localhost', wholeSeries: false,
    loadSdk: () => new Promise(resolve => { finish = resolve; }), onLoading() {}, onError() { assert.fail('A disposed viewer published an error.'); } });
  const pending = controller.open(selection), canceled = assert.rejects(pending, { name: 'AbortError' }); controller.dispose();
  finish({ createViewer() { created = true; } }); await canceled; assert.equal(created, false);
  let signal;
  const f = fixture({ applyStudyContext(_context, options) { signal = options.signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true })); } });
  const second = f.controller.open({ ...selection, sopUid: '2.25.3' }), rejected = assert.rejects(second, { name: 'AbortError' }); await tick();
  f.controller.dispose(); await rejected; await tick(); assert.equal(signal.aborted, true); assert.equal(f.handlers.size, 0); assert.deepEqual(f.errors, []);
});

test('SDK errors are reported once for loading, while later interactive display errors remain available', async () => {
  const failure = new Error('Unsupported display profile'), f = fixture({ async openArchiveSeries() { throw failure; } });
  try {
    await assert.rejects(f.controller.open(selection), failure); await tick(); assert.deepEqual(f.errors, [failure]); assert.equal(f.loading.at(-1), false);
    f.handlers.get('error')({ message: 'Later frame was unsupported.' }); assert.equal(f.errors.at(-1).message, 'Later frame was unsupported.');
    await assert.rejects(f.controller.open({ studyUid: '../private', seriesUid: '2.3' }), /valid archived/);
  } finally { f.controller.dispose(); }
});

const preview = { studyUid: '2.25.10', revision: 'verified-snapshot-revision', seriesCount: 3, instanceCount: 1234, bytes: 512 * 1024 * 1024, reclaimableBytes: 500 * 1024 * 1024 };
test('removal binds exact typed confirmation to the validated study snapshot and never sends patient identity', () => {
  const validated = deletionPreview({ ...preview, patientName: 'Discarded synthetic name' }, preview.studyUid);
  assert.deepEqual(validated, preview);
  assert.deepEqual(JSON.parse(deletionBody(validated, 'DELETE')), { confirmation: 'DELETE', revision: preview.revision });
  for (const input of ['delete', ' DELETE', 'DELETE ', 'DELET', '']) assert.throws(() => deletionBody(validated, input), /Type DELETE exactly/);
  for (const changes of [{ studyUid: '2.25.11' }, { revision: '' }, { instanceCount: -1 }, { bytes: NaN }, { reclaimableBytes: undefined }, { reclaimableBytes: preview.bytes + 1 }]) assert.throws(() => deletionPreview({ ...preview, ...changes }, preview.studyUid), /preview was invalid/);
});

test('a durable removal with pending storage cleanup is a committed outcome rather than permission to retry', () => {
  const result = deletionResult({ studyUid: preview.studyUid, deleted: true, instanceCount: preview.instanceCount, bytes: preview.bytes, reclaimedBytes: 0, reclamationPending: true }, preview.studyUid);
  assert.equal(result.deleted, true); assert.equal(result.reclamationPending, true); assert.equal(result.reclaimedBytes, 0);
  assert.throws(() => deletionResult({ ...result, studyUid: '2.25.999' }, preview.studyUid), /outcome could not be verified/);
  assert.throws(() => deletionResult({ ...result, deleted: false }, preview.studyUid), /outcome could not be verified/);
});

test('original-study download uses a fixed same-origin native download route with no identifying filename', () => {
  assert.equal(studyExportPath('2.25.10'), '/api/v1/studies/2.25.10/export');
  for (const value of ['../../private', '2.3?token=secret', 'https://elsewhere.test/', '']) assert.throws(() => studyExportPath(value), /valid archived study/);
});
