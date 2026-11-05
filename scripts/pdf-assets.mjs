import { cp } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

// v0.3.0：把 pdf.js 的 cmaps 与标准字体复制到构建输出目录（dist 或插件 dist/webview）。
// worker 由 Vite 通过 `?url` 单独输出，不需要在这里处理。
export function pdfAssets() {
  let root = process.cwd();
  let outDir = '';
  return {
    name: 'mdre-pdf-assets',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      try {
        const require = createRequire(path.join(root, 'package.json'));
        const packageDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
        await cp(path.join(packageDir, 'cmaps'), path.join(outDir, 'pdfjs', 'cmaps'), { recursive: true });
        await cp(path.join(packageDir, 'standard_fonts'), path.join(outDir, 'pdfjs', 'standard_fonts'), { recursive: true });
      } catch (reason) {
        this.error(`复制 pdf.js 运行时资源失败：${reason instanceof Error ? reason.message : String(reason)}`);
      }
    },
  };
}
