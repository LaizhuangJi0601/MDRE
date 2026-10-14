import katexCss from 'katex/dist/katex.min.css?raw';

// 使用 Vite 实际打包的字体 URL，不能从 ?raw CSS 中直接访问 fonts/ 相对路径。
const assets = import.meta.glob('../../node_modules/katex/dist/fonts/*.woff2', { eager: true, query: '?url&inline', import: 'default' }) as Record<string, string>;
let embedded: Promise<string> | null = null;
export function katexCssForExport(): Promise<string> {
  if (embedded) return embedded;
  embedded = (async () => {
    const fonts = new Map<string,string>();
    await Promise.all(Object.entries(assets).map(async ([name,url]) => {
      if (url.startsWith('data:')) { fonts.set(name.split('/').at(-1)!,url); return; }
      const response = await fetch(url);
      if (!response.ok) throw new Error(`公式字体读取失败：${name} (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let offset=0;offset<bytes.length;offset+=0x8000) binary += String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
      fonts.set(name.split('/').at(-1)!,`data:font/woff2;base64,${btoa(binary)}`);
    }));
    return katexCss.replace(/src:[^;}]+;?/g,source => {
      const name = /fonts\/([^)'"\s]+\.woff2)/.exec(source)?.[1];
      if (!name || !fonts.has(name)) throw new Error(`导出缺少公式字体：${name ?? source}`);
      return `src:url(${fonts.get(name)}) format('woff2');`;
    });
  })().catch(reason => { embedded=null; throw reason; });
  return embedded;
}
