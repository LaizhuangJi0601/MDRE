import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PageViewport,
  type RenderTask,
} from 'pdfjs-dist';
import type { PdfLabels } from './labels';
import { DEFAULT_LABELS, formatLabel, formatPercent, mergeLabels } from './labels';
import { HostRangeTransport, MAX_RANGE_READ } from './range';
import { ThumbnailStrip } from './thumbnails';
import type {
  PdfAssetUrls,
  PdfErrorCode,
  PdfHostFile,
  PdfLabelPatch,
  PdfOpenOptions,
  PdfViewerCallbacks,
} from './types';
import { PdfViewerError } from './types';
import {
  cancelIdle,
  clamp,
  createElement,
  isRenderingCancelled,
  requestIdle,
  toError,
} from './utils';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
/** Step of the +/- buttons, in zoom factor units (5 percentage points). */
export const ZOOM_BUTTON_STEP = 0.05;
/** Step of Ctrl+wheel, in zoom factor units (0.1 percentage point). */
export const ZOOM_WHEEL_STEP = 0.001;
/** Files up to this size are read whole and handed to pdf.js as `data`. */
export const WHOLE_FILE_LIMIT = 16 * 1024 * 1024;
/** Per page canvas pixel budget (width * height). */
const MAX_CANVAS_PIXELS = 16_000_000;
/** Per page canvas maximum side length in device pixels. */
const MAX_CANVAS_SIDE = 8192;
/** Total canvas pixel budget across all pages kept in memory. */
const TOTAL_CANVAS_PIXELS = 48_000_000;
/** Render pages within this many pages of the visible range. */
const RENDER_PADDING = 2;
/** Keep already rendered pages within this many pages of the visible range. */
const KEEP_PADDING = 3;
/** Must match the padding / gap values in viewer.css. */
const PAGE_PADDING = 12;
const PAGE_GAP = 12;

type PageSize = { width: number; height: number };

type PageRenderState = {
  canvas: HTMLCanvasElement | null;
  task: RenderTask | null;
  key: string | null;
};

type StatusState =
  | { kind: 'hidden' }
  | { kind: 'loading'; percent: number | null }
  | { kind: 'error'; code: PdfErrorCode; detail: string };

type Anchor = { index: number; yRatio: number; xRatio: number };

/**
 * Self contained continuous scrolling PDF viewer built on pdf.js.
 *
 * The class owns a DOM subtree inside the given host element and never
 * touches the rest of the document. All host capabilities (file bytes,
 * asset URLs, labels, theme) are injected.
 */
export class PdfViewer {
  private readonly host: HTMLElement;
  private readonly assets: PdfAssetUrls;
  private readonly callbacks: PdfViewerCallbacks;

  private readonly root: HTMLDivElement;
  private readonly scrollEl: HTMLDivElement;
  private readonly pagesEl: HTMLDivElement;
  private readonly hud: HTMLDivElement;
  private readonly pageIndicator: HTMLSpanElement;
  private readonly zoomOutButton: HTMLButtonElement;
  private readonly zoomValue: HTMLSpanElement;
  private readonly zoomInButton: HTMLButtonElement;
  private readonly status: HTMLDivElement;
  private readonly statusText: HTMLDivElement;
  private readonly statusDetail: HTMLDivElement;
  private readonly progressTrack: HTMLDivElement;
  private readonly progressBar: HTMLDivElement;

  private labels: PdfLabels = { ...DEFAULT_LABELS };
  private statusState: StatusState = { kind: 'hidden' };

  private destroyed = false;
  private generation = 0;
  private renderToken = 0;
  private file: PdfHostFile | null = null;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private doc: PDFDocumentProxy | null = null;
  private transport: HostRangeTransport | null = null;
  private pages = 0;
  private currentPage = 0;
  private zoom = 1;
  private dpr = 1;

  private baseWidth = 612;
  private baseHeight = 792;
  private readonly pageSizes: PageSize[] = [];
  private readonly offsets: number[] = [];
  private maxPageWidth = 0;

  private readonly pageEls: HTMLDivElement[] = [];
  private readonly pageStates: PageRenderState[] = [];
  private readonly visiblePages = new Set<number>();
  private readonly pendingRenders = new Set<number>();

  private observer: IntersectionObserver | null = null;
  private renderRange: [number, number] = [0, 0];
  private renderPumping = false;
  private renderIdle: ReturnType<typeof requestIdle> | null = null;
  private scrollRaf = 0;
  private anchorRaf = 0;

  private dprMedia: MediaQueryList | null = null;
  private dprListener: (() => void) | null = null;

  private thumbHost: HTMLElement | null = null;
  private thumbStrip: ThumbnailStrip | null = null;

  private progress = { loaded: 0, total: null as number | null };

  constructor(host: HTMLElement, assets: PdfAssetUrls, callbacks: PdfViewerCallbacks = {}) {
    this.host = host;
    this.assets = assets;
    this.callbacks = callbacks;
    this.dpr = window.devicePixelRatio || 1;

    host.classList.add('mdre-pdf-host');
    this.root = createElement('div', 'mdre-pdf-viewer');
    this.scrollEl = createElement('div', 'mdre-pdf-scroll', this.root);
    this.scrollEl.tabIndex = 0;
    this.pagesEl = createElement('div', 'mdre-pdf-pages', this.scrollEl);

    this.hud = createElement('div', 'mdre-pdf-hud', this.root);
    this.hud.hidden = true;
    this.pageIndicator = createElement('span', 'mdre-pdf-page-indicator', this.hud);
    this.pageIndicator.setAttribute('aria-live', 'polite');
    this.zoomOutButton = createElement('button', 'mdre-pdf-zoom-button', this.hud);
    this.zoomOutButton.type = 'button';
    this.zoomOutButton.textContent = '\u2212';
    this.zoomValue = createElement('span', 'mdre-pdf-zoom-value', this.hud);
    this.zoomInButton = createElement('button', 'mdre-pdf-zoom-button', this.hud);
    this.zoomInButton.type = 'button';
    this.zoomInButton.textContent = '+';

    this.status = createElement('div', 'mdre-pdf-status', this.root);
    this.status.hidden = true;
    this.status.setAttribute('role', 'status');
    createElement('div', 'mdre-pdf-spinner', this.status);
    this.statusText = createElement('div', 'mdre-pdf-status-text', this.status);
    this.statusDetail = createElement('div', 'mdre-pdf-status-detail', this.status);
    this.progressTrack = createElement('div', 'mdre-pdf-progress', this.status);
    this.progressBar = createElement('div', 'mdre-pdf-progress-bar', this.progressTrack);

    host.appendChild(this.root);

    this.root.addEventListener('wheel', this.handleWheel, { passive: false });
    this.scrollEl.addEventListener('scroll', this.handleScroll, { passive: true });
    this.zoomInButton.addEventListener('click', this.handleZoomIn);
    this.zoomOutButton.addEventListener('click', this.handleZoomOut);
    this.watchDevicePixelRatio();
    this.updateHud();
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Open a PDF file. Resolves once the document is ready. Document level
   * failures (invalid / encrypted PDFs, read errors) are reported through
   * `callbacks.onError` and do not reject the returned promise.
   */
  async open(file: PdfHostFile, opts: PdfOpenOptions = {}): Promise<void> {
    if (this.destroyed) {
      throw new PdfViewerError('destroyed', 'PdfViewer has been destroyed.');
    }
    this.close();
    const generation = ++this.generation;
    this.file = file;
    const total = Number(file && file.length);
    if (!file || !Number.isFinite(total) || total <= 0) {
      this.failOpen(generation, new PdfViewerError('invalid', this.labels.errorInvalid));
      return;
    }
    const requestedZoom =
      typeof opts.zoom === 'number' && Number.isFinite(opts.zoom)
        ? clamp(opts.zoom, MIN_ZOOM, MAX_ZOOM)
        : clamp(this.zoom, MIN_ZOOM, MAX_ZOOM);
    this.zoom = requestedZoom;
    this.progress = { loaded: 0, total: null };
    this.statusState = { kind: 'loading', percent: null };
    this.renderStatus();

    try {
      const task = await this.createLoadingTask(file, total, generation);
      if (!task || generation !== this.generation) {
        return;
      }
      this.loadingTask = task;
      task.onProgress = (params: { loaded: number; total: number }) => {
        if (generation !== this.generation) {
          return;
        }
        this.reportProgress(params.loaded, params.total);
      };
      let doc: PDFDocumentProxy;
      try {
        doc = await task.promise;
      } catch (error) {
        if (generation === this.generation) {
          this.failOpen(generation, error);
        }
        return;
      }
      if (generation !== this.generation) {
        void doc.destroy().catch(() => undefined);
        return;
      }
      this.doc = doc;
      this.pages = doc.numPages;
      const firstPage = await doc.getPage(1);
      if (generation !== this.generation || !this.doc) {
        return;
      }
      const firstViewport = firstPage.getViewport({ scale: 1 });
      this.baseWidth = firstViewport.width;
      this.baseHeight = firstViewport.height;
      this.pageSizes.length = 0;
      for (let i = 0; i < this.pages; i += 1) {
        this.pageSizes.push({ width: this.baseWidth, height: this.baseHeight });
      }
      this.buildPageElements();
      this.applyLayout();
      this.currentPage = 0;
      this.statusState = { kind: 'hidden' };
      this.renderStatus();
      this.attachObserver();
      this.goToPage(opts.page ?? 1);
      this.updateHud();
      this.startThumbnails();
      this.callbacks.onDocumentReady?.({ pages: this.pages });
      this.callbacks.onZoomChange?.(this.zoom);
      // `goToPage` above already reported the initial page through onPageChange.
      this.refreshRenderWindow();
      this.queueAroundCurrent();
    } catch (error) {
      if (generation === this.generation) {
        this.failOpen(generation, error);
      }
    }
  }

  /** Close the current document but keep the viewer instance usable. */
  close(): void {
    if (this.destroyed) {
      return;
    }
    const hadDocument = this.doc !== null || this.pages > 0;
    this.generation += 1;
    this.stopPageWork();
    this.thumbStrip?.destroy();
    this.thumbStrip = null;
    const doc = this.doc;
    this.doc = null;
    if (doc) {
      void doc.destroy().catch(() => undefined);
    }
    const task = this.loadingTask;
    this.loadingTask = null;
    if (task) {
      void task.destroy().catch(() => undefined);
    }
    this.transport?.abort();
    this.transport = null;
    this.file = null;
    this.pages = 0;
    this.currentPage = 0;
    this.pageSizes.length = 0;
    this.offsets.length = 0;
    this.pageEls.length = 0;
    this.pageStates.length = 0;
    this.visiblePages.clear();
    this.pendingRenders.clear();
    this.pagesEl.replaceChildren();
    this.progress = { loaded: 0, total: null };
    this.statusState = { kind: 'hidden' };
    this.renderStatus();
    this.hud.hidden = true;
    if (hadDocument) {
      this.callbacks.onPageChange?.(0, 0);
    }
  }

  /** Tear down the viewer completely: no listeners, observers or DOM remain. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.close();
    this.unmountThumbnails();
    this.unwatchDevicePixelRatio();
    this.root.removeEventListener('wheel', this.handleWheel);
    this.scrollEl.removeEventListener('scroll', this.handleScroll);
    this.zoomInButton.removeEventListener('click', this.handleZoomIn);
    this.zoomOutButton.removeEventListener('click', this.handleZoomOut);
    if (this.scrollRaf) {
      window.cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = 0;
    }
    if (this.anchorRaf) {
      window.cancelAnimationFrame(this.anchorRaf);
      this.anchorRaf = 0;
    }
    this.root.remove();
    this.host.classList.remove('mdre-pdf-host');
    this.destroyed = true;
  }

  /** Set the zoom factor (clamped to 0.1 - 4). */
  setZoom(zoom: number): void {
    if (this.destroyed || !Number.isFinite(zoom)) {
      return;
    }
    const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(next - this.zoom) < 1e-6) {
      return;
    }
    const anchor = this.pages > 0 ? this.captureAnchor() : null;
    this.zoom = next;
    if (this.pages > 0) {
      this.applyLayout();
      this.invalidateRenders();
      this.updateHud();
      this.restoreAnchorSoon(anchor);
      this.refreshRenderWindow();
      this.queueAroundCurrent();
    }
    this.callbacks.onZoomChange?.(this.zoom);
  }

  /** Zoom in by 5 percentage points. */
  zoomIn(): void {
    this.setZoom(roundZoom(this.zoom + ZOOM_BUTTON_STEP));
  }

  /** Zoom out by 5 percentage points. */
  zoomOut(): void {
    this.setZoom(roundZoom(this.zoom - ZOOM_BUTTON_STEP));
  }

  /** Merge host provided labels over the built in English defaults. */
  setLabels(labels: PdfLabelPatch): void {
    this.labels = mergeLabels(labels);
    for (let i = 0; i < this.pageEls.length; i += 1) {
      this.pageEls[i].setAttribute('aria-label', formatLabel(this.labels.page, { page: i + 1 }));
    }
    this.thumbStrip?.updateLabels(this.labels);
    this.updateHud();
    this.renderStatus();
  }

  /** Scroll to a 1-based page. */
  goToPage(page: number): void {
    if (this.pages <= 0) {
      return;
    }
    // An explicit jump wins over a pending zoom anchor restore.
    if (this.anchorRaf) {
      window.cancelAnimationFrame(this.anchorRaf);
      this.anchorRaf = 0;
    }
    const target = clamp(Math.round(page), 1, this.pages);
    const top = this.offsets[target - 1] ?? 0;
    this.scrollEl.scrollTop = Math.max(0, top - PAGE_PADDING);
    this.updateCurrentPage();
    this.queueAroundCurrent();
  }

  /** Current page, 1-based; 0 when no document is open. */
  getPage(): number {
    return this.currentPage;
  }

  /** Number of pages of the open document; 0 when no document is open. */
  getPages(): number {
    return this.pages;
  }

  /** Current zoom factor (0.1 - 4). */
  getZoom(): number {
    return this.zoom;
  }

  /** Mount the thumbnail sidebar into the given host element. */
  mountThumbnails(host: HTMLElement): void {
    if (this.destroyed) {
      return;
    }
    if (host === this.thumbHost && this.thumbStrip) {
      this.thumbStrip.updateLabels(this.labels);
      this.thumbStrip.setActive(this.currentPage || 1);
      return;
    }
    this.unmountThumbnails();
    this.thumbHost = host;
    host.classList.add('mdre-pdf-thumbs-host');
    this.startThumbnails();
  }

  /** Remove the thumbnail sidebar and stop all thumbnail work. */
  unmountThumbnails(): void {
    this.thumbStrip?.destroy();
    this.thumbStrip = null;
    if (this.thumbHost) {
      this.thumbHost.classList.remove('mdre-pdf-thumbs-host');
      this.thumbHost = null;
    }
  }

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------

  private async createLoadingTask(
    file: PdfHostFile,
    total: number,
    generation: number,
  ): Promise<PDFDocumentLoadingTask | null> {
    if (this.assets.worker) {
      GlobalWorkerOptions.workerSrc = this.assets.worker;
    }
    const base = {
      cMapUrl: this.assets.cMap ? withTrailingSlash(this.assets.cMap) : undefined,
      cMapPacked: true,
      standardFontDataUrl: this.assets.standardFonts
        ? withTrailingSlash(this.assets.standardFonts)
        : undefined,
      isEvalSupported: false,
      rangeChunkSize: 1024 * 1024,
    };
    if (total <= WHOLE_FILE_LIMIT) {
      const data = await this.readWholeFile(file, total, generation);
      if (!data || generation !== this.generation) {
        return null;
      }
      return getDocument({ ...base, data, length: total });
    }
    const initialLength = Math.min(MAX_RANGE_READ, total);
    let initialData: Uint8Array | null = null;
    try {
      const chunk = await file.readRange(0, initialLength);
      if (generation !== this.generation) {
        return null;
      }
      if (chunk instanceof Uint8Array && chunk.length > 0) {
        initialData = chunk;
        this.reportProgress(chunk.length, total);
      }
    } catch (error) {
      throw new PdfViewerError('read', this.labels.errorRead, { cause: error });
    }
    const transport = new HostRangeTransport(file, initialData, {
      onProgress: (loaded, bytesTotal) => {
        if (generation === this.generation) {
          this.reportProgress(loaded, bytesTotal);
        }
      },
      onError: (error) => {
        if (generation === this.generation) {
          this.failOpen(generation, new PdfViewerError('read', this.labels.errorRead, { cause: error }));
        }
      },
    });
    this.transport = transport;
    return getDocument({
      ...base,
      range: transport,
      length: total,
      disableAutoFetch: true,
    });
  }

  private async readWholeFile(
    file: PdfHostFile,
    total: number,
    generation: number,
  ): Promise<Uint8Array | null> {
    const data = new Uint8Array(total);
    let offset = 0;
    while (offset < total) {
      if (generation !== this.generation) {
        return null;
      }
      const size = Math.min(MAX_RANGE_READ, total - offset);
      let chunk: Uint8Array;
      try {
        chunk = await file.readRange(offset, offset + size);
      } catch (error) {
        throw new PdfViewerError('read', this.labels.errorRead, { cause: error });
      }
      if (!(chunk instanceof Uint8Array) || chunk.length === 0) {
        throw new PdfViewerError('read', this.labels.errorRead);
      }
      if (generation !== this.generation) {
        return null;
      }
      const copyLength = Math.min(chunk.length, size);
      data.set(chunk.subarray(0, copyLength), offset);
      offset += copyLength;
      this.reportProgress(offset, total);
    }
    return data;
  }

  private reportProgress(loaded: number, total: number | null | undefined): void {
    if (!Number.isFinite(loaded)) {
      return;
    }
    const normalizedTotal =
      typeof total === 'number' && Number.isFinite(total) && total > 0 ? Math.floor(total) : null;
    let normalizedLoaded = Math.max(0, Math.floor(loaded));
    if (normalizedTotal !== null) {
      normalizedLoaded = Math.min(normalizedLoaded, normalizedTotal);
    }
    const previous = this.progress;
    if (previous.total === normalizedTotal && normalizedLoaded <= previous.loaded) {
      return;
    }
    this.progress = { loaded: normalizedLoaded, total: normalizedTotal };
    if (this.statusState.kind === 'loading') {
      this.statusState = {
        kind: 'loading',
        percent: normalizedTotal ? normalizedLoaded / normalizedTotal : null,
      };
      this.renderStatus();
    }
    this.callbacks.onProgress?.(normalizedLoaded, normalizedTotal);
  }

  private failOpen(generation: number, error: unknown): void {
    if (generation !== this.generation) {
      return;
    }
    const wrapped = this.toViewerError(error);
    this.statusState = { kind: 'error', code: wrapped.code, detail: wrapped.message };
    this.renderStatus();
    this.hud.hidden = true;
    this.pages = 0;
    this.currentPage = 0;
    this.doc = null;
    this.pageEls.length = 0;
    this.pageStates.length = 0;
    this.pageSizes.length = 0;
    this.offsets.length = 0;
    this.visiblePages.clear();
    this.pendingRenders.clear();
    this.pagesEl.replaceChildren();
    const task = this.loadingTask;
    this.loadingTask = null;
    if (task) {
      void task.destroy().catch(() => undefined);
    }
    this.transport?.abort();
    this.transport = null;
    this.callbacks.onError?.(wrapped);
  }

  private toViewerError(error: unknown): PdfViewerError {
    if (error instanceof PdfViewerError) {
      return error;
    }
    const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : '';
    let code: PdfErrorCode = 'unknown';
    let message = this.labels.errorUnknown;
    if (name === 'PasswordException') {
      code = 'password';
      message = this.labels.errorPassword;
    } else if (
      name === 'InvalidPDFException' ||
      name === 'MissingPDFException' ||
      name === 'UnexpectedResponseException'
    ) {
      code = 'invalid';
      message = this.labels.errorInvalid;
    } else if (name === 'AbortException') {
      code = 'unknown';
      message = this.labels.errorUnknown;
    }
    const wrapped = new PdfViewerError(code, message, { cause: error });
    return wrapped;
  }

  // ------------------------------------------------------------------
  // Layout
  // ------------------------------------------------------------------

  private buildPageElements(): void {
    this.pageEls.length = 0;
    this.pageStates.length = 0;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < this.pages; i += 1) {
      const el = document.createElement('div');
      el.className = 'mdre-pdf-page';
      el.dataset.page = String(i + 1);
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', formatLabel(this.labels.page, { page: i + 1 }));
      fragment.appendChild(el);
      this.pageEls.push(el);
      this.pageStates.push({ canvas: null, task: null, key: null });
    }
    this.pagesEl.replaceChildren(fragment);
    this.offsets.length = this.pages;
  }

  private applyLayout(): void {
    const zoom = this.zoom;
    let top = PAGE_PADDING;
    let maxWidth = 0;
    for (let i = 0; i < this.pages; i += 1) {
      const size = this.pageSizes[i];
      const width = size.width * zoom;
      const height = size.height * zoom;
      this.offsets[i] = top;
      const el = this.pageEls[i];
      if (el) {
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;
      }
      top += height + PAGE_GAP;
      if (width > maxWidth) {
        maxWidth = width;
      }
    }
    this.maxPageWidth = maxWidth;
  }

  private recomputeOffsets(): void {
    const zoom = this.zoom;
    let top = PAGE_PADDING;
    let maxWidth = 0;
    for (let i = 0; i < this.pages; i += 1) {
      this.offsets[i] = top;
      const size = this.pageSizes[i];
      top += size.height * zoom + PAGE_GAP;
      const width = size.width * zoom;
      if (width > maxWidth) {
        maxWidth = width;
      }
    }
    this.maxPageWidth = maxWidth;
  }

  /**
   * A page reported a different size than assumed from page 1. Update the
   * layout, keeping the current scroll position anchored when the changed
   * page is above the viewport.
   */
  private syncPageSize(index: number, width: number, height: number): boolean {
    const size = this.pageSizes[index];
    if (!size || (Math.abs(size.width - width) < 0.01 && Math.abs(size.height - height) < 0.01)) {
      return false;
    }
    const oldHeight = size.height * this.zoom;
    size.width = width;
    size.height = height;
    const newHeight = height * this.zoom;
    const el = this.pageEls[index];
    if (el) {
      el.style.width = `${width * this.zoom}px`;
      el.style.height = `${newHeight}px`;
    }
    const anchorPage = this.currentPage - 1;
    if (index < anchorPage) {
      this.scrollEl.scrollTop = Math.max(0, this.scrollEl.scrollTop + newHeight - oldHeight);
    }
    this.recomputeOffsets();
    return true;
  }

  private pageIndexAt(contentY: number): number {
    if (this.pages <= 0) {
      return 0;
    }
    let low = 0;
    let high = this.pages - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.offsets[mid] <= contentY) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  }

  private captureAnchor(): Anchor | null {
    if (this.pages <= 0) {
      return null;
    }
    const center = this.scrollEl.scrollTop + this.scrollEl.clientHeight / 2;
    const index = this.pageIndexAt(center);
    const height = (this.pageSizes[index]?.height ?? this.baseHeight) * this.zoom;
    const top = this.offsets[index] ?? 0;
    const yRatio = height > 0 ? clamp((center - top) / height, 0, 1) : 0;
    const contentWidth = Math.max(this.scrollEl.clientWidth, this.maxPageWidth + PAGE_PADDING * 2);
    const xRatio =
      contentWidth > 0
        ? clamp((this.scrollEl.scrollLeft + this.scrollEl.clientWidth / 2) / contentWidth, 0, 1)
        : 0;
    return { index, yRatio, xRatio };
  }

  private restoreAnchorSoon(anchor: Anchor | null): void {
    if (!anchor) {
      return;
    }
    if (this.anchorRaf) {
      window.cancelAnimationFrame(this.anchorRaf);
    }
    this.anchorRaf = window.requestAnimationFrame(() => {
      this.anchorRaf = 0;
      if (this.pages <= 0 || !this.pageSizes[anchor.index]) {
        return;
      }
      const height = this.pageSizes[anchor.index].height * this.zoom;
      const top = this.offsets[anchor.index] ?? 0;
      this.scrollEl.scrollTop = Math.max(
        0,
        top + anchor.yRatio * height - this.scrollEl.clientHeight / 2,
      );
      const contentWidth = Math.max(this.scrollEl.clientWidth, this.maxPageWidth + PAGE_PADDING * 2);
      this.scrollEl.scrollLeft = Math.max(
        0,
        anchor.xRatio * contentWidth - this.scrollEl.clientWidth / 2,
      );
      this.updateCurrentPage();
      this.refreshRenderWindow();
    });
  }

  // ------------------------------------------------------------------
  // Visibility / current page
  // ------------------------------------------------------------------

  private attachObserver(): void {
    this.observer?.disconnect();
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }
    this.observer = new IntersectionObserver(this.handleIntersections, {
      root: this.scrollEl,
      threshold: [0, 0.01, 0.5],
    });
    for (const el of this.pageEls) {
      this.observer.observe(el);
    }
  }

  private handleIntersections = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      const index = Number(target.dataset.page) - 1;
      if (!Number.isFinite(index) || index < 0) {
        continue;
      }
      if (entry.isIntersecting) {
        this.visiblePages.add(index);
      } else {
        this.visiblePages.delete(index);
      }
    }
    this.refreshRenderWindow();
  };

  private handleScroll = (): void => {
    if (this.scrollRaf) {
      return;
    }
    this.scrollRaf = window.requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.updateCurrentPage();
    });
  };

  private updateCurrentPage(): void {
    if (this.pages <= 0) {
      return;
    }
    const center = this.scrollEl.scrollTop + this.scrollEl.clientHeight / 2;
    const page = this.pageIndexAt(center) + 1;
    if (page === this.currentPage) {
      return;
    }
    this.currentPage = page;
    this.updateHud();
    this.thumbStrip?.setActive(page);
    this.callbacks.onPageChange?.(page, this.pages);
    this.queueAroundCurrent();
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  private renderKey(): string {
    return `${this.zoom}|${this.dpr}`;
  }

  private refreshRenderWindow(): void {
    if (this.pages <= 0) {
      return;
    }
    let min = Number.POSITIVE_INFINITY;
    let max = -1;
    for (const index of this.visiblePages) {
      if (index < min) {
        min = index;
      }
      if (index > max) {
        max = index;
      }
    }
    if (max < 0) {
      const fallback = Math.max(0, Math.min(this.pages - 1, (this.currentPage || 1) - 1));
      min = fallback;
      max = fallback;
    }
    const from = Math.max(0, min - RENDER_PADDING);
    const to = Math.min(this.pages - 1, max + RENDER_PADDING);
    this.renderRange = [from, to];
    const keepFrom = Math.max(0, min - KEEP_PADDING);
    const keepTo = Math.min(this.pages - 1, max + KEEP_PADDING);
    const key = this.renderKey();
    for (let i = 0; i < this.pages; i += 1) {
      const state = this.pageStates[i];
      if (!state) {
        continue;
      }
      if (i < keepFrom || i > keepTo) {
        this.releasePage(i);
        continue;
      }
      if (state.task && (i < from || i > to)) {
        state.task.cancel();
      }
    }
    for (let i = from; i <= to; i += 1) {
      const state = this.pageStates[i];
      if (!state || state.task || state.key === key) {
        continue;
      }
      this.pendingRenders.add(i);
    }
    this.pumpRenders();
  }

  private queueAroundCurrent(): void {
    if (this.pages <= 0 || !this.doc) {
      return;
    }
    const key = this.renderKey();
    const center = Math.max(0, Math.min(this.pages - 1, (this.currentPage || 1) - 1));
    const from = Math.max(0, center - RENDER_PADDING);
    const to = Math.min(this.pages - 1, center + RENDER_PADDING);
    for (let i = from; i <= to; i += 1) {
      const state = this.pageStates[i];
      if (!state || state.task || state.key === key) {
        continue;
      }
      this.pendingRenders.add(i);
    }
    this.pumpRenders();
  }

  private pumpRenders(): void {
    if (this.destroyed || !this.doc || this.renderPumping || this.pendingRenders.size === 0) {
      return;
    }
    this.renderPumping = true;
    this.renderIdle = requestIdle(() => {
      this.renderIdle = null;
      if (this.destroyed || !this.doc) {
        this.renderPumping = false;
        return;
      }
      const index = this.takeNextRender();
      if (index < 0) {
        this.renderPumping = false;
        return;
      }
      void this.renderPage(index, this.renderToken).finally(() => {
        this.renderPumping = false;
        this.pumpRenders();
      });
    }, 120);
  }

  private takeNextRender(): number {
    const key = this.renderKey();
    const center = Math.max(0, (this.currentPage || 1) - 1);
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const index of this.pendingRenders) {
      const state = this.pageStates[index];
      const inRange = index >= this.renderRange[0] && index <= this.renderRange[1];
      if (!state || state.task || state.key === key || !inRange) {
        this.pendingRenders.delete(index);
        continue;
      }
      const distance = Math.abs(index - center);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    if (best >= 0) {
      this.pendingRenders.delete(best);
    }
    return best;
  }

  private async renderPage(index: number, token: number): Promise<void> {
    const doc = this.doc;
    const state = this.pageStates[index];
    const el = this.pageEls[index];
    if (!doc || !state || !el || this.destroyed) {
      return;
    }
    let page: PDFPageProxy;
    try {
      page = await doc.getPage(index + 1);
    } catch (error) {
      if (!isRenderingCancelled(error)) {
        this.reportRenderError(error);
      }
      return;
    }
    if (token !== this.renderToken || this.destroyed || !this.doc) {
      return;
    }
    const baseViewport = page.getViewport({ scale: 1 });
    if (this.syncPageSize(index, baseViewport.width, baseViewport.height)) {
      this.refreshRenderWindow();
    }
    const viewport = page.getViewport({ scale: this.zoom });
    const outputScale = canvasOutputScale(viewport, this.dpr);
    // A fresh canvas per render avoids pdf.js' "same canvas in use" guard when
    // a previous render was cancelled but has not settled yet, and it keeps
    // the old bitmap visible until the new one is ready (no blank flash).
    const canvas = document.createElement('canvas');
    canvas.className = 'mdre-pdf-canvas';
    canvas.width = Math.max(1, Math.round(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.round(viewport.height * outputScale));
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    const key = this.renderKey();
    let task: RenderTask;
    try {
      task = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        background: 'rgba(0, 0, 0, 0)',
      });
    } catch (error) {
      if (!isRenderingCancelled(error)) {
        this.reportRenderError(error);
      }
      return;
    }
    el.appendChild(canvas);
    state.task = task;
    try {
      await task.promise;
    } catch (error) {
      if (!isRenderingCancelled(error)) {
        this.reportRenderError(error);
      }
      return;
    } finally {
      if (state.task === task) {
        state.task = null;
      }
      if (!canvas.isConnected || token !== this.renderToken || this.destroyed) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
        return;
      }
    }
    if (token !== this.renderToken || this.destroyed) {
      canvas.remove();
      return;
    }
    const previous = state.canvas;
    state.canvas = canvas;
    if (previous && previous !== canvas) {
      previous.width = 0;
      previous.height = 0;
      previous.remove();
    }
    state.key = key;
    el.classList.add('is-rendered');
    this.enforceCanvasBudget(index);
  }

  private reportRenderError(error: unknown): void {
    const wrapped = new PdfViewerError('render', this.labels.errorRender, { cause: error });
    this.statusState = { kind: 'error', code: 'render', detail: this.labels.errorRender };
    this.renderStatus();
    this.callbacks.onError?.(wrapped);
  }

  private invalidateRenders(): void {
    this.renderToken += 1;
    cancelIdle(this.renderIdle);
    this.renderIdle = null;
    this.renderPumping = false;
    for (const state of this.pageStates) {
      if (state.task) {
        state.task.cancel();
        state.task = null;
      }
      state.key = null;
    }
    this.pendingRenders.clear();
  }

  private releasePage(index: number): void {
    const state = this.pageStates[index];
    const el = this.pageEls[index];
    if (!state) {
      return;
    }
    if (state.task) {
      state.task.cancel();
      state.task = null;
    }
    if (el) {
      // A render started after the last committed canvas may still be attached.
      for (const canvas of el.querySelectorAll('canvas')) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
      }
      el.classList.remove('is-rendered');
    }
    state.canvas = null;
    state.key = null;
    this.pendingRenders.delete(index);
  }

  private enforceCanvasBudget(focusIndex: number): void {
    let total = 0;
    for (const state of this.pageStates) {
      if (state.canvas) {
        total += state.canvas.width * state.canvas.height;
      }
    }
    if (total <= TOTAL_CANVAS_PIXELS) {
      return;
    }
    const [from, to] = this.renderRange;
    const candidates: number[] = [];
    for (let i = 0; i < this.pageStates.length; i += 1) {
      if (i !== focusIndex && this.pageStates[i]?.canvas) {
        candidates.push(i);
      }
    }
    const center = Math.max(0, (this.currentPage || 1) - 1);
    candidates.sort((a, b) => {
      const aInRange = a >= from && a <= to ? 0 : 1;
      const bInRange = b >= from && b <= to ? 0 : 1;
      if (aInRange !== bInRange) {
        return bInRange - aInRange;
      }
      return Math.abs(b - center) - Math.abs(a - center);
    });
    for (const index of candidates) {
      if (total <= TOTAL_CANVAS_PIXELS) {
        break;
      }
      const canvas = this.pageStates[index]?.canvas;
      if (!canvas) {
        continue;
      }
      total -= canvas.width * canvas.height;
      this.releasePage(index);
    }
  }

  private stopPageWork(): void {
    this.renderToken += 1;
    cancelIdle(this.renderIdle);
    this.renderIdle = null;
    this.renderPumping = false;
    this.observer?.disconnect();
    this.observer = null;
    this.pendingRenders.clear();
    this.visiblePages.clear();
    if (this.scrollRaf) {
      window.cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = 0;
    }
    if (this.anchorRaf) {
      window.cancelAnimationFrame(this.anchorRaf);
      this.anchorRaf = 0;
    }
    for (let i = 0; i < this.pageStates.length; i += 1) {
      this.releasePage(i);
    }
  }

  // ------------------------------------------------------------------
  // HUD / status
  // ------------------------------------------------------------------

  private updateHud(): void {
    if (this.pages <= 0) {
      this.hud.hidden = true;
      return;
    }
    this.hud.hidden = false;
    this.pageIndicator.textContent = formatLabel(this.labels.pageOf, {
      page: this.currentPage || 1,
      pages: this.pages,
    });
    const percent = formatPercent(this.zoom);
    this.zoomValue.textContent = `${percent}%`;
    this.zoomOutButton.setAttribute('aria-label', this.labels.zoomOut);
    this.zoomOutButton.title = this.labels.zoomOut;
    this.zoomInButton.setAttribute('aria-label', this.labels.zoomIn);
    this.zoomInButton.title = this.labels.zoomIn;
    this.zoomValue.setAttribute('aria-label', formatLabel(this.labels.zoomLevel, { percent }));
    this.zoomValue.title = formatLabel(this.labels.zoomLevel, { percent });
    this.zoomOutButton.disabled = this.zoom <= MIN_ZOOM + 1e-9;
    this.zoomInButton.disabled = this.zoom >= MAX_ZOOM - 1e-9;
  }

  private renderStatus(): void {
    const state = this.statusState;
    if (state.kind === 'hidden') {
      this.status.hidden = true;
      return;
    }
    this.status.hidden = false;
    this.status.classList.toggle('is-error', state.kind === 'error');
    if (state.kind === 'loading') {
      this.statusText.textContent =
        state.percent === null
          ? this.labels.loading
          : formatLabel(this.labels.loadingPercent, {
              percent: Math.round(state.percent * 100),
            });
      this.statusDetail.textContent = '';
      this.statusDetail.hidden = true;
      this.progressTrack.hidden = state.percent === null;
      const value = state.percent === null ? 0 : clamp(state.percent, 0, 1);
      this.progressBar.style.transform = `scaleX(${value})`;
      return;
    }
    this.statusText.textContent = this.labels.errorTitle;
    this.statusDetail.textContent = state.detail;
    this.statusDetail.hidden = false;
    this.progressTrack.hidden = true;
  }

  // ------------------------------------------------------------------
  // Thumbnails
  // ------------------------------------------------------------------

  private startThumbnails(): void {
    this.thumbStrip?.destroy();
    this.thumbStrip = null;
    if (!this.thumbHost || !this.doc || this.destroyed) {
      return;
    }
    const aspect = this.baseWidth > 0 ? this.baseHeight / this.baseWidth : 1.4;
    this.thumbStrip = new ThumbnailStrip(this.thumbHost, {
      doc: this.doc,
      labels: this.labels,
      currentPage: this.currentPage || 1,
      baseAspect: aspect,
      onSelect: (page) => {
        this.goToPage(page);
      },
    });
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------

  private handleWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey) {
      return;
    }
    event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
    if (direction === 0) {
      return;
    }
    this.setZoom(roundZoom(this.zoom + direction * ZOOM_WHEEL_STEP));
  };

  private handleZoomIn = (): void => {
    this.zoomIn();
  };

  private handleZoomOut = (): void => {
    this.zoomOut();
  };

  private watchDevicePixelRatio(): void {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    this.unwatchDevicePixelRatio();
    const media = window.matchMedia(`(resolution: ${this.dpr}dppx)`);
    this.dprMedia = media;
    this.dprListener = () => {
      this.dpr = window.devicePixelRatio || 1;
      this.watchDevicePixelRatio();
      if (this.pages > 0) {
        this.invalidateRenders();
        this.refreshRenderWindow();
        this.queueAroundCurrent();
      }
    };
    media.addEventListener('change', this.dprListener);
  }

  private unwatchDevicePixelRatio(): void {
    if (this.dprMedia && this.dprListener) {
      this.dprMedia.removeEventListener('change', this.dprListener);
    }
    this.dprMedia = null;
    this.dprListener = null;
  }
}

function withTrailingSlash(url: string): string {
  if (!url) {
    return url;
  }
  return url.endsWith('/') ? url : `${url}/`;
}

function roundZoom(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function canvasOutputScale(viewport: PageViewport, dpr: number): number {
  const cssPixels = viewport.width * viewport.height;
  if (!(cssPixels > 0)) {
    return 1;
  }
  const requested = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  let scale = Math.min(
    requested,
    Math.sqrt(MAX_CANVAS_PIXELS / cssPixels),
    MAX_CANVAS_SIDE / viewport.width,
    MAX_CANVAS_SIDE / viewport.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    scale = 1;
  }
  // Keep at least half resolution so downsampled pages stay legible.
  return clamp(scale, 0.5, requested);
}

export type { PdfAssetUrls, PdfHostFile, PdfViewerCallbacks, PdfOpenOptions, PdfLabelPatch };
export type { PdfLabels } from './labels';
