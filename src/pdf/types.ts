/**
 * Public types of the shared PDF viewer module.
 *
 * The module is deliberately host agnostic: it never imports project files,
 * CSS, Tauri or VS Code APIs. Every host capability is injected through the
 * constructor arguments or the `PdfHostFile` object.
 */

/** A host provided, random access read-only view of a PDF file on disk. */
export type PdfHostFile = {
  /** Total size of the file in bytes. */
  readonly length: number;
  /**
   * Read `[start, end)` bytes of the file. `end` is exclusive.
   *
   * The returned array must be a fresh `Uint8Array` that is not shared with
   * other readers: pdf.js may transfer its underlying buffer to the worker.
   * Implementations should cap a single call to 4 MiB (the viewer never asks
   * for more than that, but host wrappers may enforce it as well).
   */
  readRange(start: number, end: number): Promise<Uint8Array>;
};

/** URLs of the pdf.js runtime assets, resolved by the host environment. */
export type PdfAssetUrls = {
  /** URL of `pdf.worker.min.mjs` (or `pdf.worker.mjs`). */
  worker: string;
  /** URL of the `cmaps/` directory (trailing slash optional). */
  cMap: string;
  /** URL of the `standard_fonts/` directory (trailing slash optional). */
  standardFonts: string;
};

export type PdfViewerCallbacks = {
  /** Current page changed; `page` is 1-based. `page` is 0 after `close()`. */
  onPageChange?(page: number, pages: number): void;
  /** Zoom factor changed (0.1 - 4). 1 means 100%. */
  onZoomChange?(zoom: number): void;
  /** A document finished loading and the first page layout is ready. */
  onDocumentReady?(info: { pages: number }): void;
  /**
   * Loading progress in bytes. `total` is `null` when the total size is
   * unknown. Values only grow within one `open()` call.
   */
  onProgress?(loaded: number, total: number | null): void;
  /** A readable error; the viewer stays alive and can open another file. */
  onError?(error: PdfViewerError): void;
};

export type PdfOpenOptions = {
  /** 1-based initial page. Defaults to the first page. */
  page?: number;
  /** Initial zoom factor (0.1 - 4, clamped). Defaults to the last zoom. */
  zoom?: number;
};

export type PdfErrorCode =
  | 'invalid' // not a PDF / unparsable
  | 'password' // encrypted document
  | 'read' // host read failure
  | 'render' // page rendering failure
  | 'destroyed' // viewer already destroyed
  | 'unknown';

/** Error passed to `PdfViewerCallbacks.onError`. */
export class PdfViewerError extends Error {
  readonly code: PdfErrorCode;

  constructor(code: PdfErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = 'PdfViewerError';
    this.code = code;
  }
}

/** Human readable label set; every value may contain `{name}` placeholders. */
export type PdfLabelPatch = Record<string, string>;
