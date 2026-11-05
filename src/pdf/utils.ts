/** Small DOM / scheduling helpers shared by the PDF viewer internals. */

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (parent) {
    parent.appendChild(el);
  }
  return el;
}

/** True for pdf.js render-task cancellation errors (not real failures). */
export function isRenderingCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === 'RenderingCancelledException' || name === 'AbortException';
}

export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === 'string' ? value : String(value));
}

type IdleHandle = { type: 'idle'; id: number } | { type: 'timeout'; id: number } | null;

export function requestIdle(callback: () => void, timeout = 200): IdleHandle {
  if (typeof window.requestIdleCallback === 'function') {
    return { type: 'idle', id: window.requestIdleCallback(() => callback(), { timeout }) };
  }
  return { type: 'timeout', id: window.setTimeout(callback, 16) };
}

export function cancelIdle(handle: IdleHandle): void {
  if (!handle) {
    return;
  }
  if (handle.type === 'idle' && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle.id);
  } else {
    window.clearTimeout(handle.id);
  }
}

export function currentDevicePixelRatio(): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}
