import type { Viewer, ViewerOptions, ViewerState } from '@xinonix/easi-view';

type Sdk = { createViewer: (mount: HTMLElement, options: ViewerOptions) => Viewer };
export type ArchiveSelection = { studyUid: string; seriesUid: string; sopUid?: string };
type Options = {
  mount: HTMLElement; origin: string; wholeSeries: boolean; loadSdk: () => Promise<Sdk>;
  onLoading: (loading: boolean) => void; onError: (error: Error) => void;
};
const canceled = () => new DOMException('Archive viewing was canceled.', 'AbortError');
const uid = (value: unknown) => typeof value === 'string' && value.length <= 64 && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/.test(value);

/** Host lifecycle only. Metadata, image parsing, cache budgets and frame/stack
 * ordering remain owned by the independently published EASI View SDK. */
export class ArchiveViewerController {
  readonly ready: Promise<Viewer>;
  #viewer: Viewer | null = null; #options: Options; #disposed = false; #generation = 0;
  #operation: AbortController | null = null; #pending: Promise<ViewerState> | null = null;
  #unsubscribe: (() => void) | null = null; #opening = false;
  constructor(options: Options) {
    this.#options = options;
    this.ready = this.#initialize(); this.ready.catch(() => {});
  }
  async #initialize() {
    const sdk = await this.#options.loadSdk(); if (this.#disposed) throw canceled();
    const viewer = sdk.createViewer(this.#options.mount, {
      initialDemo: null, branding: { name: 'EASI View', showReleaseTag: true },
      ui: { library: false, demos: false, inspector: true },
      opening: { localImages: false, localStudies: false, remoteStudies: false, tests: false, sourceEditing: false },
      theme: { accent: '#7bdfc4', background: '#090e15', panel: '#0e1721' }
    });
    this.#viewer = viewer;
    this.#unsubscribe = viewer.on('error', event => { if (!this.#disposed && !this.#opening) this.#options.onError(new Error(event.message || 'The viewer could not complete this display operation.')); });
    await viewer.ready; if (this.#disposed) throw canceled(); return viewer;
  }
  open(selection: ArchiveSelection): Promise<ViewerState> {
    if (!uid(selection.studyUid) || !uid(selection.seriesUid) || selection.sopUid !== undefined && !uid(selection.sopUid)) return Promise.reject(new Error('Select valid archived study, series and instance identifiers.'));
    if (this.#disposed) return Promise.reject(canceled());
    const previous = this.#pending, generation = ++this.#generation; this.#operation?.abort();
    const controller = new AbortController(); this.#operation = controller; this.#opening = true; this.#options.onLoading(true);
    const current = () => !this.#disposed && generation === this.#generation && !controller.signal.aborted;
    const assertCurrent = () => { if (!current()) throw canceled(); };
    const pending = (async () => {
      const viewer = await this.ready; assertCurrent();
      // Disconnect aborts an older SDK archive load as well as frame requests;
      // waiting for that load prevents simultaneous source replacement commits.
      viewer.pause(); await viewer.disconnectArchive();
      if (previous) await previous.catch(() => {}); assertCurrent();
      viewer.configureArchive({ baseUrl: new URL('/dicomweb/', this.#options.origin).href, credentials: 'same-origin', retrievalMode: 'instance' });
      if (selection.sopUid) {
        const reference = { archiveKey: 'easi-store', studyUid: selection.studyUid, seriesUid: selection.seriesUid, sopUid: selection.sopUid };
        await viewer.applyStudyContext({ version: 1, layout: 1, activeViewport: 0,
          viewports: [{ slot: 0, reference, frameIndex: 0, originalFrameNumber: 1 }] },
          { archiveKey: 'easi-store', scope: reference, signal: controller.signal });
      } else await viewer.openArchiveSeries(selection.studyUid, selection.seriesUid);
      assertCurrent(); return viewer.getState();
    })();
    this.#pending = pending;
    pending.catch(error => { if (current() && error?.name !== 'AbortError') this.#options.onError(error instanceof Error ? error : new Error('The archived image could not be displayed.')); })
      .finally(() => { if (current()) { this.#opening = false; this.#options.onLoading(false); this.#operation = null; } }).catch(() => {});
    return pending;
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true; this.#generation++; this.#operation?.abort(); this.#operation = null; this.#unsubscribe?.(); this.#unsubscribe = null;
    this.#viewer?.dispose(); this.#viewer = null;
  }
}
