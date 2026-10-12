import hljs from 'highlight.js';
import { markdown } from './model';
import { renderDiagramImage } from './render/mermaid';
import { renderMath, sanitizeHtml, tocHtml, type TocEntry } from './render/markdown';
import { katexCssForExport } from './render/katex';

const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = url => /^data:image\/svg\+xml;base64,/i.test(url) || validateLink(url);
export function safeUrl(url: string, image = false): boolean {
  return image ? /^(?:data:image\/(?:png|jpeg|gif|webp|svg\+xml);|https?:\/\/)/i.test(url) : /^(?:https?:|mailto:|#)/i.test(url);
}
const defaultImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, i, options, env, renderer) => {
  const src = tokens[i].attrGet('src') || '', width = tokens[i].attrGet('width');
  // 本地相对路径交给文档资源解析器；不能只放行 assets/，论文也会引用 figures/。
  if (!safeUrl(src, true) && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)) return `<span class="resource-error">图片路径需在导出前解析：${markdown.utils.escapeHtml(src)}</span>`;
  if (width) tokens[i].attrSet('style', `width:${Number(width)}px`);
  if (tokens[i].attrs) tokens[i].attrs = tokens[i].attrs!.filter(([name]) => name !== 'dimensions');
  return defaultImage(tokens, i, options, env, renderer);
};
markdown.renderer.rules.link_open = (tokens, i, options, env, renderer) => {
  if (!safeUrl(tokens[i].attrGet('href') || '')) tokens[i].attrSet('href', '#');
  tokens[i].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, i, options);
};

export const printCss = `
@page { size:A4; margin:15mm }
* { box-sizing:border-box }
html { color:#202632; background:white; font-family:"Microsoft YaHei","Segoe UI",sans-serif; font-size:11pt; line-height:1.65 }
body { margin:0; overflow-wrap:anywhere }
h1,h2,h3 { line-height:1.3; break-after:avoid }
p { orphans:3; widows:3 }
pre { padding:10px 12px; border:1px solid #d9e0e8; background:#f6f8fa; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-all; font:9pt/1.55 Consolas,"Microsoft YaHei",monospace; break-inside:auto }
code { overflow-wrap:anywhere }
table { border-collapse:collapse; width:100%; table-layout:fixed; font-size:10pt; margin:16px 0 }
th,td { border:1px solid #c6ced8; padding:6px 8px; overflow-wrap:anywhere }
thead { display:table-header-group } tr { break-inside:avoid }
img,svg { max-width:100%; height:auto } figure { margin:16px 0; break-inside:avoid }
blockquote { border-left:3px solid #a9bdcf; margin-left:0; padding-left:15px }
.raw-html { white-space:pre-wrap } .resource-error { color:#ad2635 }
mark { background:#fff0a6 }
.math-block { text-align:center; margin:14px 0; break-inside:avoid }
.math-error { color:#ad2635; font-size:9pt; white-space:pre-wrap }
.toc-block { border:1px solid #d9e0e8; border-radius:4px; padding:10px 16px; margin:14px 0; font-size:10pt }
.toc-block ul { margin:4px 0; padding-left:20px } .toc-block a { color:#202632; text-decoration:none }
.toc-empty { color:#777; font-size:9pt }
.footnote-ref { vertical-align:super; font-size:8pt } .footnote-ref a { text-decoration:none }
.footnote-defs { font-size:9pt; color:#444; margin-top:18px } .footnote-defs li { break-inside:avoid }
.footnote-backref { text-decoration:none }
`;

// S-2/S-3/S-4：静态导出与预览共用同一份渲染结果；此处把占位元素替换为最终输出。
function enhanceStatic(container: HTMLElement, formulas: readonly string[]) {
  for (const [index, element] of Array.from(container.querySelectorAll<HTMLElement>('.math-inline, .math-block')).entries()) {
    const latex = formulas[index];
    const holder = document.createElement('span');
    holder.innerHTML = renderMath(latex, element.classList.contains('math-block'));
    const output = holder.firstElementChild ?? holder;
    if (element.classList.contains('math-block')) output.classList.add('math-block');
    element.replaceWith(output);
  }
  const entries: TocEntry[] = [];
  const used = new Set<string>();
  for (const heading of Array.from(container.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))) {
    const index = entries.length + 1;
    const explicit = heading.id || null;
    let anchor = explicit ?? `sec-${(heading.textContent ?? '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section'}-${index}`;
    let suffix = 1;
    while (used.has(anchor)) anchor = `${explicit ?? anchor}-${++suffix}`;
    used.add(anchor);
    heading.id = anchor;
    entries.push({ anchor, level: Number(heading.tagName.slice(1)), text: (heading.textContent ?? '').trim() || '（空标题）' });
  }
  for (const toc of Array.from(container.querySelectorAll<HTMLElement>('.toc-block[data-toc]'))) {
    const holder = document.createElement('div');
    holder.innerHTML = tocHtml(entries);
    toc.replaceWith(holder.firstElementChild ?? holder);
  }
  for (const list of Array.from(container.querySelectorAll<HTMLElement>('.footnote-defs ol'))) {
    for (const backref of Array.from(list.querySelectorAll<HTMLAnchorElement>('.footnote-backref'))) {
      const label = (backref.getAttribute('href') ?? '').replace('#footnote-ref-', '');
      const refs = Array.from(container.querySelectorAll<HTMLElement>(`sup.footnote-ref[id$="-${CSS.escape(label)}"]`));
      if (refs.length < 2) continue;
      backref.replaceWith(...refs.flatMap((ref, index) => [index ? ' ' : '', (() => { const link = document.createElement('a'); link.className = 'footnote-backref'; link.href = `#${ref.id}`; link.textContent = '↩'; return link; })()]));
    }
  }
}

export async function staticHtml(source: string, resolve?: (src: string) => Promise<string | null>): Promise<string> {
  const container = document.createElement('article');
  container.innerHTML = markdown.render(source);
  let sequence = 0;
  for (const code of container.querySelectorAll('pre > code')) {
    const language = Array.from(code.classList).find(name => name.startsWith('language-'))?.slice(9);
    if (language === 'mermaid') {
      // S-6：Mermaid 输出为 data URL 图片，避免在严格白名单下丢弃整段内联 SVG。
      const image = await renderDiagramImage(code.textContent || '', `export-${Date.now()}-${sequence++}`, 'default');
      if (!image) continue;
      const figure = document.createElement('figure'); figure.innerHTML = image; code.parentElement!.replaceWith(figure);
    } else if (language && hljs.getLanguage(language)) code.innerHTML = hljs.highlight(code.textContent || '', { language }).value;
  }
  for (const img of container.querySelectorAll('img')) {
    const url = img.getAttribute('src')!;
    if (!url.startsWith('data:')) {
      if (/^https?:/i.test(url)) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`图片下载失败：${url} (${response.status})`);
        const blob = await response.blob();
        img.src = await new Promise<string>((resolveData, reject) => { const reader = new FileReader(); reader.onload = () => resolveData(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
      } else {
        const resolved = await resolve?.(url);
        if (!resolved) throw new Error(`本地图片未解析：${url}`);
        img.src = resolved;
      }
    }
    await img.decode();
  }
  if (container.querySelector('.resource-error')) throw new Error('存在未解析的图片路径。原型请使用内嵌图片或可获取的 HTTPS 图片。');
  // 先过滤文档内容，再注入受信任的 KaTeX 输出；其根号/伸缩符号需要 SVG，
  // 不能把已生成的公式再次交给普通 HTML 白名单，否则会丢失这些笔画。
  // 原公式单独保存，避免 data-latex 中的 &、< 等实体在过滤时再次转义。
  const formulas = Array.from(container.querySelectorAll<HTMLElement>('.math-inline, .math-block'), element => element.dataset.latex ?? '');
  container.innerHTML = sanitizeHtml(container.innerHTML);
  enhanceStatic(container, formulas);
  await document.fonts.ready;
  // 文档内容已经过白名单；增强器只生成本地受信的公式、目录和脚注标记。
  const body = container.innerHTML;
  // S-2：公式样式与字体内嵌，导出文件离线可打开。
  const mathCss = container.querySelector('.katex') ? await katexCssForExport() : '';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><title>MDRE 文档快照</title><style>${printCss}</style><style>${mathCss}</style><body>${body}</body></html>`;
}
