import { PDFDataRangeTransport } from 'pdfjs-dist';
import type { PdfHostFile } from './types';

/**
 * Largest number of bytes requested from the host in a single `readRange`
 * call. pdf.js may ask for bigger ranges (it groups chunks); the transport
 * splits those into host friendly reads and delivers a single chunk to
 * pdf.js, because pdf.js matches incoming chunks by their exact start offset.
 */
export const MAX_RANGE_READ = 4 * 1024 * 1024;

export type RangeTransportOptions = {
  onProgress?(loaded: number, total: number): void;
  onError?(error: Error): void;
};

/**
 * pdf.js range transport backed by `PdfHostFile.readRange`.
 *
 * This is used for files larger than the whole-file threshold so that only
 * the pages that are actually viewed are read from disk.
 */
export class HostRangeTransport extends PDFDataRangeTransport {
  private readonly file: PdfHostFile;
  private readonly options: RangeTransportOptions;
  private aborted = false;
  private loaded: number;

  constructor(file: PdfHostFile, initialData: Uint8Array | null, options: RangeTransportOptions = {}) {
    super(file.length, initialData ?? null, false);
    this.file = file;
    this.options = options;
    this.loaded = initialData ? initialData.length : 0;
  }

  override requestDataRange(begin: number, end: number): void {
    void this.loadRange(begin, end);
  }

  override abort(): void {
    this.aborted = true;
  }

  private async loadRange(begin: number, end: number): Promise<void> {
    if (this.aborted) {
      return;
    }
    const length = end - begin;
    if (!(length > 0)) {
      this.deliver(begin, new Uint8Array(0));
      return;
    }

    const parts: Uint8Array[] = [];
    let position = begin;
    try {
      while (position < end) {
        if (this.aborted) {
          return;
        }
        const size = Math.min(MAX_RANGE_READ, end - position);
        const chunk = await this.file.readRange(position, position + size);
        if (this.aborted) {
          return;
        }
        if (!(chunk instanceof Uint8Array)) {
          throw new Error('PdfHostFile.readRange must resolve to a Uint8Array');
        }
        if (chunk.length === 0) {
          throw new Error(`Empty range read at offset ${position}`);
        }
        parts.push(chunk);
        position += chunk.length;
        this.loaded += chunk.length;
        this.options.onProgress?.(this.loaded, this.file.length);
      }
    } catch (error) {
      if (!this.aborted) {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    if (this.aborted) {
      return;
    }
    // pdf.js expects one chunk starting exactly at `begin`. Avoid an extra
    // copy for the common small request case.
    let data: Uint8Array;
    try {
      data = parts.length === 1 ? parts[0] : concat(parts, length);
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.deliver(begin, data);
  }

  private deliver(begin: number, chunk: Uint8Array): void {
    this.onDataRange(begin, chunk);
  }
}

function concat(parts: Uint8Array[], expected: number): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  if (total < expected) {
    // The host returned less than requested without reaching the end of the
    // file; pdf.js would wait forever for the missing bytes.
    throw new Error(`Range read returned ${total} of ${expected} bytes`);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
