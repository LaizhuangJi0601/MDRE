/**
 * Shared PDF viewer module (pdf.js based, no framework, host agnostic).
 *
 * Usage from a host (desktop or VS Code webview):
 *
 * ```ts
 * import { PdfViewer } from './pdf';
 * import './pdf/viewer.css';
 *
 * const viewer = new PdfViewer(hostElement, {
 *   worker: assetUrl('pdf.worker.min.mjs'),
 *   cMap: assetUrl('cmaps/'),
 *   standardFonts: assetUrl('standard_fonts/'),
 * }, { onError: (error) => showError(error) });
 * await viewer.open({ length, readRange: (start, end) => hostRead(start, end) });
 * ```
 *
 * The module never imports project files, CSS, Tauri or VS Code APIs; the
 * caller imports `viewer.css` separately and injects all host capabilities.
 */
export {
  PdfViewer,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_BUTTON_STEP,
  ZOOM_WHEEL_STEP,
  WHOLE_FILE_LIMIT,
} from './viewer';
export { DEFAULT_LABELS } from './labels';
export type { PdfLabels } from './labels';
export { PdfViewerError } from './types';
export type {
  PdfAssetUrls,
  PdfHostFile,
  PdfViewerCallbacks,
  PdfOpenOptions,
  PdfErrorCode,
  PdfLabelPatch,
} from './types';
export { MAX_RANGE_READ } from './range';
