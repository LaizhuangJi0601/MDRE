import hljs from 'highlight.js';
import { markdown, normalizeWidths, parseWidthList } from './model';
import { renderDiagramImage } from './render/mermaid';
import { renderMath, sanitizeHtml, tocHtml, type TocEntry } from './render/markdown';
import { codeLanguageName } from './ui/code-language';
import codeThemeCss from './ui/code-theme.css?inline';
import { codeTheme, type CodeTheme } from './ui/code-appearance';
import { embeddableImageSource } from './image-path';
import type { Model } from './model';

export type ExportAppearance = { fontSize?: string; fontFamily?: string; lineHeight?: string; codeThemes?: CodeTheme[] };
export function exportAppearance(owner: string, model: Model, editor: HTMLElement): ExportAppearance {
  const style=getComputedStyle(editor);
  return {fontSize:style.fontSize,fontFamily:style.fontFamily,lineHeight:style.lineHeight,
    codeThemes:model.blocks.filter(block=>block.type==='opaque'&&block.node.attrs.kind==='code').sort((a,b)=>a.pos-b.pos).map(block=>codeTheme(owner,block.id))};
}

const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = url => /^data:image\/svg\+xml;base64,/i.test(url) || validateLink(url);
export function safeUrl(url: string, image = false): boolean {
  return image ? embeddableImageSource(url) : /^(?:https?:|mailto:|#)/i.test(url);
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
// v0.2.5：GFM 表格后的 mdre:table-widths 注释在导出时转成 colgroup + 固定布局，
// HTML 格式表格由源码原样保留（含 colgroup 与跨度），两者都按百分比渲染。
const defaultTableOpen = markdown.renderer.rules.table_open;
markdown.renderer.rules.table_open = (tokens, index, options, env, renderer) => {
  const opening = defaultTableOpen ? defaultTableOpen(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
  let close = tokens.length;
  for (let cursor = index + 1; cursor < tokens.length; cursor++) if (tokens[cursor].type === 'table_close') { close = cursor; break; }
  const comment = tokens[close + 1];
  if (comment?.type !== 'html_block') return opening;
  const match = /^[ \t]*<!--[ \t]*mdre:table-widths[ \t]*:[ \t]*([^>]*?)[ \t]*-->/.exec(comment.content);
  if (!match) return opening;
  const values = parseWidthList(match[1]);
  if (!values) return opening;
  let columns = 0;
  for (let cursor = index + 1; cursor < close; cursor++) if (tokens[cursor].type === 'th_open') columns++;
  if (columns !== values.length) return opening;
  const widths = normalizeWidths(values);
  if (!widths) return opening;
  tokens[index].attrSet('style', 'table-layout:fixed;width:100%');
  return (defaultTableOpen ? defaultTableOpen(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options))
    + `<colgroup>${widths.map(width => `<col style="width:${width}%">`).join('')}</colgroup>\n`;
};

export const printCss = `
@page { size:A4; margin:15mm }
* { box-sizing:border-box }
.katex * { box-sizing:content-box }
html { color:#202632; background:white; font-family:"Microsoft YaHei","Segoe UI",sans-serif; font-size:11pt; line-height:1.65 }
body { margin:0; overflow-wrap:anywhere; -webkit-print-color-adjust:exact; print-color-adjust:exact }
h1,h2,h3 { line-height:1.3; break-after:avoid }
p { orphans:3; widows:3 }
pre { padding:10px 12px; border:1px solid #d9e0e8; background:#f6f8fa; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-all; font:9pt/1.55 Consolas,"Microsoft YaHei",monospace; break-inside:auto }
code { overflow-wrap:anywhere }
.inline-code { background:#e9e9e9; border-radius:3px; padding:2px 4px; box-shadow:0 1px 1px #0002 }
.task-item { position:relative; list-style:none; margin:5px 0 }
.task-item > p { margin:10px 0 }
.task-toggle { position:absolute; left:-23px; top:6px; width:15px; height:15px; border:1px solid #858585; border-radius:3px; text-align:center; font:11px/13px "Segoe UI","Microsoft YaHei",sans-serif; color:#424242 }
.code-block { border:1px solid var(--code-border); border-radius:5px; margin:14px 0; }
.code-header { padding:7px 12px; border-bottom:1px solid var(--code-border); color:var(--code-fg); font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif; break-after:avoid; }
.code-block pre { margin:0; border:0; border-radius:0; background:transparent; color:inherit; }
.code-block code { font:inherit; color:inherit; background:transparent; }
table { border-collapse:collapse; width:100%; max-width:100%; table-layout:fixed; font-size:10pt; margin:16px 0 }
th,td { border:1px solid #c6ced8; padding:6px 8px; overflow-wrap:anywhere; word-break:break-word; vertical-align:top; break-inside:avoid }
th { background:#f2f5f8; font-weight:600 }
thead { display:table-header-group } tr { break-inside:avoid }
colgroup { break-inside:avoid }
a,code { overflow-wrap:anywhere; word-break:break-word }
img,figure > svg { max-width:100%; height:auto } figure { margin:16px 0; break-inside:avoid }
blockquote { border-left:3px solid #a9bdcf; margin-left:0; padding-left:15px }
.raw-html { white-space:pre-wrap } .resource-error { color:#ad2635 }
mark { background:#fff0a6 }
.math-block { text-align:center; margin:14px 0; break-inside:avoid }
.math-block .katex-display { margin:0 }
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

export async function staticHtml(source: string, resolve?: (src: string) => Promise<string | null>, appearance: ExportAppearance = {}): Promise<string> {
  const container = document.createElement('article');
  const env = {};
  const tokens = markdown.parse(source,env);
  // 只识别列表项首段源码中的任务前缀，转义的 [ ]、行内代码与后续段落保持原文。
  for (let index=0;index<tokens.length;index++) {
    const item=tokens[index], inline=tokens[index+2];
    if (item.type!=='list_item_open' || tokens[index+1]?.type!=='paragraph_open' || inline?.type!=='inline') continue;
    const task=/^\[([ xX])\](?:[ \t]+|$)/.exec(inline.content);
    if (!task || inline.children?.[0]?.type!=='text') continue;
    item.attrJoin('class','task-item'); item.attrSet('data-checked',String(task[1]!==' '));
    inline.children[0].content=inline.children[0].content.slice(task[0].length);
  }
  container.innerHTML = markdown.renderer.render(tokens,markdown.options,env);
  // v0.2.5：列宽注释只参与排版计算，导出快照中不保留 MDRE 私有注释。
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === Node.COMMENT_NODE && /^\s*mdre:table-widths\s*:/.test((node as Comment).data)) node.remove();
  }
  let sequence = 0;
  let codeIndex = 0;
  for (const code of container.querySelectorAll('pre > code')) {
    const language = Array.from(code.classList).find(name => name.startsWith('language-'))?.slice(9);
    if (language === 'mermaid') {
      // S-6：Mermaid 输出为 data URL 图片，避免在严格白名单下丢弃整段内联 SVG。
      const image = await renderDiagramImage(code.textContent || '', `export-${Date.now()}-${sequence++}`, 'default');
      if (!image) continue;
      const figure = document.createElement('figure'); figure.innerHTML = image; code.parentElement!.replaceWith(figure);
    } else {
      if (language && hljs.getLanguage(language)) code.innerHTML = hljs.highlight(code.textContent || '', { language }).value;
      const wrapper=document.createElement('div'); wrapper.className='code-block';
      wrapper.dataset.codeTheme=appearance.codeThemes?.[codeIndex++] ?? (document.documentElement.dataset.codeTheme==='dark'?'dark':'light');
      const header=document.createElement('div'); header.className='code-header'; header.textContent=codeLanguageName(language || 'text');
      const pre=code.parentElement!; pre.replaceWith(wrapper); wrapper.append(header,pre);
    }
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
  for (const item of container.querySelectorAll<HTMLElement>('li.task-item[data-checked]')) {
    const checked=item.dataset.checked==='true', checkbox=document.createElement('span');
    checkbox.className='task-toggle'; checkbox.textContent=checked ? '✓' : '';
    checkbox.setAttribute('role','checkbox'); checkbox.setAttribute('aria-checked',String(checked));
    item.prepend(checkbox);
  }
  for (const code of container.querySelectorAll('code')) {
    if (!code.closest('pre')) code.classList.add('inline-code');
  }
  enhanceStatic(container, formulas);
  // 文档内容已经过白名单；增强器只生成本地受信的公式、目录和脚注标记。
  // S-2：公式样式与字体内嵌，导出文件离线可打开。
  const mathCss = container.querySelector('.katex') ? await (await import('./render/katex')).katexCssForExport() : '';
  const styling=document.createElement('div');
  styling.style.fontSize=appearance.fontSize ?? '16px'; styling.style.fontFamily=appearance.fontFamily ?? '"Microsoft YaHei","Segoe UI",sans-serif'; styling.style.lineHeight=appearance.lineHeight ?? '1.65';
  // A4 页宽减两侧 15mm：在同一渲染字体下测量，超宽公式只做等比例缩小。
  container.style.cssText=styling.style.cssText+';position:fixed;left:-10000px;top:0;width:180mm;visibility:hidden;';
  document.body.append(container);
  try {
    await document.fonts.ready;
    for (const block of container.querySelectorAll<HTMLElement>('.math-block')) {
      const formula=block.matches('.katex-display') ? block : block.querySelector<HTMLElement>('.katex-display');
      if (!formula) continue;
      const content=Array.from(formula.querySelectorAll<HTMLElement>('.katex-html > .base')).reduce((width,base)=>width+base.getBoundingClientRect().width,0);
      const tag=formula.querySelector<HTMLElement>('.tag');
      // 内容居中、编号靠右：两边均预留编号宽度，避免编号压到最长公式行。
      const width=content+(tag ? 2*(tag.getBoundingClientRect().width+parseFloat(styling.style.fontSize)) : 0);
      if (width>container.clientWidth) block.style.fontSize=`${parseFloat(styling.style.fontSize)*container.clientWidth/width*0.995}px`;
    }
    // v0.2.5：表格按百分比排版，A4 页宽内不横向截断；源码带固定像素宽度导致超宽时等比压缩字号。
    for (const table of Array.from(container.querySelectorAll<HTMLTableElement>('table'))) {
      const width = table.getBoundingClientRect().width;
      if (width <= container.clientWidth + 1) continue;
      const ratio = container.clientWidth / width;
      const current = Number.parseFloat(getComputedStyle(table).fontSize) || 10;
      table.style.fontSize = `${Math.max(6, current * ratio * 0.995)}pt`;
      table.style.tableLayout = 'fixed';
      table.style.width = '100%';
    }
  } finally { container.remove(); }
  const body=container.innerHTML;
  // CSSOM 序列化后再进行属性转义，字体名中的引号不会破坏快照 HTML。
  const style=markdown.utils.escapeHtml(styling.style.cssText);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><title>MDRE 文档快照</title><style>${printCss}\n${codeThemeCss}</style><style>${mathCss}</style><body style="${style}">${body}</body></html>`;
}
