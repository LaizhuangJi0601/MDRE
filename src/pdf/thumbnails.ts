import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { PdfLabels } from './labels';
import { formatLabel } from './labels';
import { cancelIdle, createElement, isRenderingCancelled, requestIdle, toError } from './utils';

export type ThumbnailStripOptions = {
  doc: PDFDocumentProxy;
  labels: PdfLabels;
  /** 1-based page that is currently shown in the viewer. */
  currentPage: number;
  /** CSS aspect ratio (height / width) of the first page, used for placeholders. */
  baseAspect: number;
  onSelect(page: number): void;
};

/** CSS width of a thumbnail; kept in sync with `--mdre-pdf-thumb-width` in viewer.css. */
const THUMB_WIDTH = 108;
const THUMB_MAX_DPR = 2;
/** Backing store pixel budget for a single thumbnail. */
const THUMB_MAX_PIXELS = 512 * 720;
/** How many thumbnail placeholders are appended per animation frame. */
const CREATE_BATCH = 150;
/** The first batch is appended synchronously so the current page appears at once. */
const FIRST_BATCH = 150;

type ThumbItem = {
  page: number;
  el: HTMLDivElement;
  frame: HTMLDivElement;
  label: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  task: RenderTask | null;
  rendered: boolean;
  queued: boolean;
  visible: boolean;
  aspect: number;
};

/**
 * Lazily rendered page thumbnails for the "outline / thumbnails" sidebar.
 * Only visible thumbnails (plus a small prefetch margin) keep a canvas; the
 * rest release their bitmap, which keeps memory flat for documents with
 * thousands of pages.
 */
export class ThumbnailStrip {
  private readonly doc: PDFDocumentProxy;
  private readonly onSelect: (page: number) => void;
  private readonly root: HTMLDivElement;
  private readonly scroll: HTMLDivElement;
  private readonly items: ThumbItem[] = [];
  private readonly queue: number[] = [];
  private labels: PdfLabels;
  private observer: IntersectionObserver | null = null;
  private batchRaf = 0;
  private nextPage = 1;
  private idleHandle: ReturnType<typeof requestIdle> | null = null;
  private active: number;
  private pumping = false;
  private destroyed = false;

  constructor(host: HTMLElement, options: ThumbnailStripOptions) {
    this.doc = options.doc;
    this.labels = options.labels;
    this.onSelect = options.onSelect;
    this.active = options.currentPage;

    this.root = createElement('div', 'mdre-pdf-thumbs');
    this.root.setAttribute('role', 'list');
    this.root.setAttribute('aria-label', this.labels.thumbnails);
    this.scroll = createElement('div', 'mdre-pdf-thumbs-scroll', this.root);
    this.scroll.addEventListener('click', this.handleClick);
    host.appendChild(this.root);

    this.observer = new IntersectionObserver(this.handleIntersections, {
      root: this.scroll,
      rootMargin: '400px 0px',
      threshold: 0,
    });

    const total = this.doc.numPages;
    this.createBatch(Math.min(FIRST_BATCH, total), options.baseAspect);
    if (this.nextPage <= total) {
      this.scheduleBatch();
    }
    this.refreshActive();
  }

  private scheduleBatch(): void {
    if (this.destroyed) {
      return;
    }
    this.batchRaf = window.requestAnimationFrame(() => {
      this.batchRaf = 0;
      if (this.destroyed) {
        return;
      }
      const total = this.doc.numPages;
      const from = this.nextPage;
      const to = Math.min(total, from + CREATE_BATCH - 1);
      const aspect = this.items.length > 0 ? this.items[0].aspect : 1.4;
      this.createBatch(to - from + 1, aspect);
      if (this.nextPage <= total) {
        this.scheduleBatch();
      }
    });
  }

  private createBatch(count: number, aspect: number): void {
    const fragment = document.createDocumentFragment();
    const created: ThumbItem[] = [];
    for (let i = 0; i < count; i += 1) {
      const page = this.nextPage;
      if (page > this.doc.numPages) {
        break;
      }
      this.nextPage += 1;
      const el = document.createElement('div');
      el.className = 'mdre-pdf-thumb';
      el.dataset.page = String(page);
      el.setAttribute('role', 'listitem');
      el.tabIndex = 0;
      el.setAttribute('aria-label', formatLabel(this.labels.goToPage, { page }));
      const frame = document.createElement('div');
      frame.className = 'mdre-pdf-thumb-frame';
      frame.style.aspectRatio = `${1 / aspect}`;
      const label = document.createElement('div');
      label.className = 'mdre-pdf-thumb-label';
      label.textContent = String(page);
      el.append(frame, label);
      fragment.appendChild(el);
      const item: ThumbItem = {
        page,
        el,
        frame,
        label,
        canvas: null,
        task: null,
        rendered: false,
        queued: false,
        visible: false,
        aspect,
      };
      this.items.push(item);
      created.push(item);
    }
    this.scroll.appendChild(fragment);
    for (const item of created) {
      this.observer?.observe(item.el);
    }
  }

  private handleClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const itemEl = target?.closest('.mdre-pdf-thumb') as HTMLElement | null;
    if (!itemEl || !this.scroll.contains(itemEl)) {
      return;
    }
    const page = Number(itemEl.dataset.page);
    if (Number.isFinite(page) && page >= 1) {
      this.setActive(page);
      this.onSelect(page);
    }
  };

  private handleIntersections = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      const item = this.itemFor(entry.target as HTMLElement);
      if (!item) {
        continue;
      }
      item.visible = entry.isIntersecting;
      if (entry.isIntersecting) {
        this.enqueue(item);
      } else {
        this.release(item);
      }
    }
    this.pump();
  };

  private itemFor(el: HTMLElement): ThumbItem | undefined {
    const page = Number(el.dataset.page);
    return Number.isFinite(page) ? this.items[page - 1] : undefined;
  }

  private enqueue(item: ThumbItem): void {
    if (item.rendered || item.task || item.queued || this.destroyed) {
      return;
    }
    item.queued = true;
    this.queue.push(item.page);
  }

  private pump(): void {
    if (this.pumping || this.destroyed || this.queue.length === 0) {
      return;
    }
    this.pumping = true;
    this.idleHandle = requestIdle(() => {
      this.idleHandle = null;
      if (this.destroyed) {
        this.pumping = false;
        return;
      }
      const page = this.queue.shift();
      if (page === undefined) {
        this.pumping = false;
        return;
      }
      const item = this.items[page - 1];
      if (!item) {
        this.pumping = false;
        this.pump();
        return;
      }
      item.queued = false;
      void this.renderItem(item).finally(() => {
        this.pumping = false;
        this.pump();
      });
    }, 120);
  }

  private async renderItem(item: ThumbItem): Promise<void> {
    if (item.rendered || item.task || this.destroyed) {
      return;
    }
    let canvas: HTMLCanvasElement | null = null;
    try {
      const page = await this.doc.getPage(item.page);
      if (this.destroyed || item.rendered || !item.visible) {
        return;
      }
      const base = page.getViewport({ scale: 1 });
      item.aspect = base.height / base.width;
      item.frame.style.aspectRatio = `${base.width} / ${base.height}`;
      // Use the laid out width so a host override of --mdre-pdf-thumb-width
      // keeps thumbnails sharp instead of upscaling a fixed bitmap.
      const cssWidth = item.frame.clientWidth || THUMB_WIDTH;
      const dpr = Math.min(window.devicePixelRatio || 1, THUMB_MAX_DPR);
      let scale = (cssWidth * dpr) / base.width;
      const pixels = base.width * scale * base.height * scale;
      if (pixels > THUMB_MAX_PIXELS) {
        scale *= Math.sqrt(THUMB_MAX_PIXELS / pixels);
      }
      const viewport = page.getViewport({ scale });
      canvas = document.createElement('canvas');
      canvas.className = 'mdre-pdf-thumb-canvas';
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      // Keep the canvas transparent while rendering so a not-yet-finished
      // thumbnail shows the white paper frame instead of a black box.
      const context = canvas.getContext('2d');
      if (!context) {
        return;
      }
      item.canvas = canvas;
      item.frame.appendChild(canvas);
      const task = page.render({ canvasContext: context, viewport, background: 'rgba(0, 0, 0, 0)' });
      item.task = task;
      await task.promise;
      if (item.task === task) {
        item.task = null;
      }
      if (this.destroyed) {
        return;
      }
      if (!item.visible) {
        this.release(item);
        return;
      }
      item.rendered = true;
      item.el.classList.add('is-rendered');
    } catch (error) {
      if (isRenderingCancelled(error)) {
        return;
      }
      item.task = null;
      if (canvas && canvas === item.canvas) {
        canvas.remove();
        item.canvas = null;
      }
      console.warn('[pdf-viewer] thumbnail render failed', toError(error));
    }
  }

  private release(item: ThumbItem): void {
    if (item.task) {
      item.task.cancel();
      item.task = null;
    }
    if (item.canvas) {
      item.canvas.width = 0;
      item.canvas.height = 0;
      item.canvas.remove();
      item.canvas = null;
    }
    item.rendered = false;
    item.queued = false;
    item.el.classList.remove('is-rendered');
    const index = this.queue.indexOf(item.page);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  /** Update the highlighted page (called while the main view scrolls). */
  setActive(page: number): void {
    if (this.active === page) {
      return;
    }
    this.active = page;
    this.refreshActive();
    this.ensureActiveVisible();
  }

  private refreshActive(): void {
    const activeItem = this.items[this.active - 1];
    for (const item of this.items) {
      item.el.classList.toggle('is-active', item === activeItem);
      if (item === activeItem) {
        item.el.setAttribute('aria-current', 'page');
      } else {
        item.el.removeAttribute('aria-current');
      }
    }
  }

  private ensureActiveVisible(): void {
    const item = this.items[this.active - 1];
    if (!item) {
      return;
    }
    const itemRect = item.el.getBoundingClientRect();
    const rootRect = this.scroll.getBoundingClientRect();
    if (itemRect.top < rootRect.top || itemRect.bottom > rootRect.bottom) {
      item.el.scrollIntoView({ block: 'nearest' });
    }
  }

  updateLabels(labels: PdfLabels): void {
    this.labels = labels;
    this.root.setAttribute('aria-label', labels.thumbnails);
    for (const item of this.items) {
      item.el.setAttribute('aria-label', formatLabel(labels.goToPage, { page: item.page }));
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.batchRaf) {
      window.cancelAnimationFrame(this.batchRaf);
      this.batchRaf = 0;
    }
    cancelIdle(this.idleHandle);
    this.idleHandle = null;
    this.observer?.disconnect();
    this.observer = null;
    this.scroll.removeEventListener('click', this.handleClick);
    for (const item of this.items) {
      this.release(item);
    }
    this.queue.length = 0;
    this.root.remove();
  }
}
