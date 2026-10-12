import katexCss from 'katex/dist/katex.min.css?raw';

// S-2：导出页只允许 data: 字体，因此把 KaTeX 样式与字体一起内嵌，保证离线可打开。
let embedded: Promise<string> | null = null;
const cache = new Map<string, Promise<string | null>>();

async function assetDataUrl(url: string): Promise<string | null> {
  const cached = cache.get(url);
  if (cached) return cached;
  const task = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const blob = await response.blob();
      const mime = /\.woff2?$/.test(url) ? 'font/woff2' : /\.ttf$/.test(url) ? 'font/ttf' : blob.type || 'application/octet-stream';
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob([blob], { type: mime }));
      });
    } catch { return null; }
  })();
  cache.set(url, task);
  return task;
}

export function katexCssForExport(): Promise<string> {
  if (embedded) return embedded;
  embedded = (async () => {
    const urls = Array.from(new Set(Array.from(katexCss.matchAll(/url\(([^)]+)\)/g)).map(match => match[1].replace(/["']/g, '').trim())));
    const resolved = new Map<string, string>();
    for (const url of urls) {
      if (/^data:/.test(url)) { resolved.set(url, url); continue; }
      const data = await assetDataUrl(url);
      if (data) resolved.set(url, data);
    }
    return katexCss.replace(/url\(([^)]+)\)/g, (whole, raw: string) => {
      const key = raw.replace(/["']/g, '').trim();
      const data = resolved.get(key);
      return data ? `url(${data})` : whole;
    });
  })();
  return embedded;
}
