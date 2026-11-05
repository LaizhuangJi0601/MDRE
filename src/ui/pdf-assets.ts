import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfAssetUrls } from '../pdf';

// v0.3.0：pdf.js 运行时资源地址。
// worker 由 Vite 以带哈希的静态资源输出；cmaps 与标准字体由 scripts/pdf-assets.mjs 在构建时复制到
// dist/pdfjs/（桌面）或 VscodeExtension/dist/webview/pdfjs/（插件），这里按文档基准地址解析。
const assetRoot = () => new URL('.', document.baseURI);
export function pdfAssetUrls(): PdfAssetUrls {
  const root = assetRoot();
  return {
    worker: workerUrl,
    cMap: new URL('pdfjs/cmaps/', root).href,
    standardFonts: new URL('pdfjs/standard_fonts/', root).href,
  };
}
