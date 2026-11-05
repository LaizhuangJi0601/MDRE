import type { PdfLabelPatch } from './types';

/**
 * Labels used by the viewer UI. All strings default to English; the host is
 * expected to call `setLabels()` with translated values. Placeholders:
 * `{page}`, `{pages}`, `{percent}`.
 */
export type PdfLabels = {
  loading: string;
  loadingPercent: string;
  zoomIn: string;
  zoomOut: string;
  zoomLevel: string;
  pageOf: string;
  goToPage: string;
  page: string;
  thumbnails: string;
  errorTitle: string;
  errorInvalid: string;
  errorPassword: string;
  errorRead: string;
  errorRender: string;
  errorUnknown: string;
};

export const DEFAULT_LABELS: Readonly<PdfLabels> = Object.freeze({
  loading: 'Loading PDF',
  loadingPercent: 'Loading PDF {percent}%',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomLevel: 'Zoom {percent}%',
  pageOf: '{page} / {pages}',
  goToPage: 'Go to page {page}',
  page: 'Page {page}',
  thumbnails: 'Page thumbnails',
  errorTitle: 'Unable to open the PDF',
  errorInvalid: 'The file is not a valid PDF document.',
  errorPassword: 'This PDF is password-protected. Open it with a PDF reader that supports passwords.',
  errorRead: 'The PDF file could not be read.',
  errorRender: 'A page of the PDF could not be rendered.',
  errorUnknown: 'The PDF could not be opened.',
});

/** Merge a partial (host provided) label set over the defaults. */
export function mergeLabels(patch: PdfLabelPatch | null | undefined): PdfLabels {
  const labels: PdfLabels = { ...DEFAULT_LABELS };
  if (!patch) {
    return labels;
  }
  for (const key of Object.keys(DEFAULT_LABELS) as (keyof PdfLabels)[]) {
    const value = patch[key];
    if (typeof value === 'string') {
      labels[key] = value;
    }
  }
  return labels;
}

/** Format `{name}` placeholders in a label template. */
export function formatLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

/** Format a zoom factor as a percentage: `1` -> `100`, `1.001` -> `100.1`. */
export function formatPercent(zoom: number): string {
  const percent = Math.round(zoom * 1000) / 10;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}
