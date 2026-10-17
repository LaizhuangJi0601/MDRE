import { decodeHTML } from 'entities';
// S-6：渲染输出的单一白名单出口，解析器、预览和导出共用。
const allowedTags = new Set(['p', 'br', 'hr', 'strong', 'em', 's', 'del', 'code', 'pre', 'mark', 'span', 'div', 'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'nav', 'figure', 'figcaption', 'section', 'article', 'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'msqrt', 'mtext', 'mspace', 'mover', 'munder', 'mtable', 'mtr', 'mtd']);
const allowedAttrs = new Set(['href', 'title', 'alt', 'src', 'width', 'height', 'class', 'style', 'id', 'colspan', 'rowspan', 'start', 'align', 'valign', 'encoding', 'mathvariant']);
const voidTags = new Set(['br', 'hr', 'img']);
for (const tag of ['u', 'b', 'i', 'small', 'abbr', 'cite', 'kbd', 'samp', 'var', 'details', 'summary', 'dl', 'dt', 'dd', 'address', 'caption', 'colgroup', 'col', 'aside', 'header', 'footer']) allowedTags.add(tag);
voidTags.add('col');
allowedAttrs.add('open');
// 扩展文档展示：语义标签、ruby、表单外观、媒体、SVG 与 MathML；源码不转换。
export const htmlInlineTags = new Set(['span', 'mark', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'sup', 'sub', 'small', 'abbr', 'cite', 'kbd', 'samp', 'var', 'a', 'code', 'q', 'dfn', 'bdi', 'bdo', 'ruby', 'rb', 'rt', 'rp', 'rtc', 'time', 'data', 'font', 'label', 'output']);
const moreTags = ['main', 'hgroup', 'search', 'center', 'menu', 'figure', 'figcaption', 'wbr', 'picture', 'source', 'map', 'area', 'audio', 'video', 'track', 'form', 'fieldset', 'legend', 'label', 'input', 'button', 'select', 'optgroup', 'option', 'textarea', 'datalist', 'output', 'progress', 'meter', 'tfoot', 'svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'image', 'clippath', 'mask', 'pattern', 'lineargradient', 'radialgradient', 'stop', 'filter', 'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'fecomposite', 'feflood', 'femerge', 'femergenode', 'foreignobject', 'desc', 'title', 'mfrac', 'mroot', 'msubsup', 'mmultiscripts', 'mprescripts', 'none', 'munderover', 'menclose', 'mfenced', 'mstyle', 'mpadded', 'mphantom', 'mlabeledtr', 'maction'];
for (const tag of [...htmlInlineTags, ...moreTags]) allowedTags.add(tag);
allowedTags.add('marker');
for (const tag of ['input', 'wbr', 'source', 'track', 'area']) voidTags.add(tag);
for (const attr of ['dir', 'lang', 'datetime', 'cite', 'value', 'type', 'name', 'checked', 'selected', 'disabled', 'readonly', 'placeholder', 'rows', 'cols', 'size', 'multiple', 'min', 'max', 'step', 'low', 'high', 'optimum', 'label', 'controls', 'loop', 'muted', 'preload', 'poster', 'kind', 'srclang', 'for', 'scope', 'headers', 'reversed', 'color', 'face', 'viewbox', 'preserveaspectratio', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'transform', 'clip-path', 'mask', 'filter', 'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'patternunits', 'patterncontentunits', 'patterntransform', 'stddeviation', 'dx', 'dy', 'in', 'in2', 'result', 'mode', 'operator', 'values', 'text-anchor', 'dominant-baseline', 'font-family', 'font-size', 'font-weight', 'mathsize', 'mathcolor', 'mathbackground', 'displaystyle', 'scriptlevel', 'linethickness', 'notation', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'stretchy', 'fence', 'separator', 'xmlns', 'xlink:href']) allowedAttrs.add(attr);
const canonical: Record<string, string> = { viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', textpath: 'textPath', clippath: 'clipPath', lineargradient: 'linearGradient', radialgradient: 'radialGradient', foreignobject: 'foreignObject', gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform', patternunits: 'patternUnits', patterncontentunits: 'patternContentUnits', patterntransform: 'patternTransform', stddeviation: 'stdDeviation', fegaussianblur: 'feGaussianBlur', feoffset: 'feOffset', feblend: 'feBlend', fecolormatrix: 'feColorMatrix', fecomposite: 'feComposite', feflood: 'feFlood', femerge: 'feMerge', femergenode: 'feMergeNode' };
const frozenControls = new Set(['input', 'button', 'select', 'textarea']);
Object.assign(canonical, { markerwidth: 'markerWidth', markerheight: 'markerHeight', markerunits: 'markerUnits', refx: 'refX', refy: 'refY', clippathunits: 'clipPathUnits', maskunits: 'maskUnits', maskcontentunits: 'maskContentUnits' });
for (const attr of ['markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient', 'marker-start', 'marker-mid', 'marker-end', 'clippathunits', 'maskunits', 'maskcontentunits']) allowedAttrs.add(attr);
const attributePattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
const tagPattern = /<\/?([a-zA-Z][-a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

export function sanitizeHtml(html: string): string {
  html = html.replace(/<(script|style|iframe|object|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  let output = '';
  let cursor = 0;
  tagPattern.lastIndex = 0;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    // 标签之间的文本已由 markdown-it 转义，原样保留；只有标签与属性参与白名单判定。
    output += html.slice(cursor, match.index);
    cursor = tagPattern.lastIndex;
    const closing = match[0].startsWith('</');
    const tag = match[1].toLowerCase();
    // 未在白名单内的标签整体丢弃（保留其文本内容）。
    if (!allowedTags.has(tag)) continue;
    if (closing) { if (!voidTags.has(tag)) output += `</${canonical[tag] ?? tag}>`; continue; }
    const attrs: string[] = [];
    attributePattern.lastIndex = 0;
    for (let attr = attributePattern.exec(match[2]); attr; attr = attributePattern.exec(match[2])) {
      const name = attr[1].toLowerCase();
      const assigned = attr[2] !== undefined || attr[3] !== undefined || attr[4] !== undefined;
      const value = decodeHTML(attr[2] ?? attr[3] ?? attr[4] ?? '');
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'action') continue;
      if (!allowedAttrs.has(name) && !name.startsWith('data-') && !name.startsWith('aria-')) continue;
      if (['href', 'src', 'xlink:href', 'poster', 'cite'].includes(name) && !safeAttributeUrl(value, ['img', 'image', 'source', 'track', 'audio', 'video'].includes(tag))) continue;
      if (name === 'xmlns' && !/^http:\/\/www\.w3\.org\/(?:2000\/svg|1998\/Math\/MathML)$/.test(value)) continue;
      if (name === 'style' && /expression|javascript:|url\s*\(\s*['"]?\s*(?:javascript|data:text\/html)/i.test(value)) continue;
      attrs.push(assigned ? ` ${canonical[name] ?? name}="${escapeAttribute(value)}"` : ` ${canonical[name] ?? name}`);
    }
    if (frozenControls.has(tag) && !attrs.some(attr => /^ disabled(?:=|$)/.test(attr))) attrs.push(' disabled');
    // SVG/MathML 自闭合节点必须保留斜线，否则后面的兄弟节点会被浏览器嵌套进去。
    const selfClosing = !voidTags.has(tag) && /\/\s*>$/.test(match[0]);
    output += `<${canonical[tag] ?? tag}${attrs.join('')}${selfClosing ? '/' : ''}>`;
  }
  output += html.slice(cursor);
  return output;
}

// 先去掉控制字符再判定协议，避免 `java&Tab;script:` 一类实体或空白分隔绕过前缀匹配。
function safeAttributeUrl(raw: string, isImage: boolean): boolean {
  const value = decodeHTML(raw).replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
  if (value.startsWith('#')) return true;
  if (/^(?:https?:|mailto:)/.test(value)) return true;
  if (isImage && /^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml);/.test(value)) return true;
  if (isImage && /^(?:file:\/\/|[a-z]:[\\/])/.test(value)) return true;
  if (!/^[^/?#]*:/.test(value)) return true;
  return false;
}

const escapeAttribute = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
