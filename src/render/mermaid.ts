// Mermaid 体积大（数百 KB～1 MB+），仅在文档确实包含图表时才动态加载。
type Mermaid = typeof import('mermaid').default;
let loading: Promise<Mermaid> | null = null;
let applied: 'default' | 'dark' | null = null;
let appTheme: 'default' | 'dark' = 'default';
let sequence = 0;
// Mermaid 的 render 会读写全局配置并往 document.body 挂临时节点；串行执行避免多图并发时互相踩配置，
// 也保证每张图用的都是自己请求的主题。渲染本身是主线程 CPU 工作，串行不会比并发更慢。
let queue: Promise<unknown> = Promise.resolve();

export function setDiagramTheme(dark: boolean) { appTheme = dark ? 'dark' : 'default'; }
export function diagramsLoaded(): boolean { return loading !== null; }

async function initialize(theme: 'default' | 'dark'): Promise<Mermaid> {
  if (!loading) loading = import('mermaid').then(module => module.default);
  const mermaid = await loading;
  if (applied !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      // 失败时由调用方给出可读提示，并避免 Mermaid 把错误图形和临时节点留在 body 里。
      suppressErrorRendering: true,
      // 沿用原有外观：节点/连线标签走 Mermaid 的 HTML 标签布局（宽度与换行表现与旧版一致）。
      flowchart: { htmlLabels: false },
    });
    applied = theme;
  }
  return mermaid;
}

export async function renderDiagram(code: string, prefix: string, theme: 'default' | 'dark' = appTheme): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await initialize(theme);
    const { svg } = await mermaid.render(`${prefix}-${Date.now()}-${sequence++}`, code);
    return svg;
  });
  queue = run.catch(() => {});
  return run;
}

// Mermaid 返回的 SVG 是 HTML 序列化结果：可能含 `<br>`、`<img>` 等非自闭合写法，也可能缺少
// xmlns:xlink 声明（click 链接会产出 xlink:href）。直接作为 image/svg+xml 使用不是合法 XML，
// 浏览器解码失败 → 破图 + alt。这里先交给 HTML 解析器（容错），再用 XMLSerializer 输出规范 XML。
function normalizedSvg(svg: string): SVGSVGElement | null {
  const holder = document.createElement('div');
  holder.innerHTML = svg;
  const root = holder.firstElementChild;
  return root instanceof SVGSVGElement ? root : null;
}

// 图片解码前先确认是合法 XML，避免把无法解码的 SVG 塞进 <img> 后显示破图。
function isXml(svg: string): boolean {
  try { return !new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror'); }
  catch { return false; }
}

function intrinsicSize(root: SVGSVGElement): { width: number | null; height: number | null } {
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return { width: null, height: null };
  // 向上取整避免小图被拉伸；width/height 写进 SVG 与 <img>，导出/打印时尺寸稳定。
  return { width: Math.ceil(box[2]), height: Math.ceil(box[3]) };
}

function prepareSvg(svg: string): { text: string; width: number | null; height: number | null; unsafe: boolean } | null {
  const root = normalizedSvg(svg);
  if (root) {
    const { width, height } = intrinsicSize(root);
    if (width && height) {
      root.setAttribute('width', String(width));
      root.setAttribute('height', String(height));
      // 根上的 max-width 针对整页容器，图片内没有意义；其它内联样式（主题相关）保留。
      const style = root.getAttribute('style');
      if (style) {
        const kept = style.split(';').map(part => part.trim()).filter(part => part && !/^max-width\s*:/i.test(part)).join('; ');
        if (kept) root.setAttribute('style', kept); else root.removeAttribute('style');
      }
    }
    try {
      const text = new XMLSerializer().serializeToString(root);
      if (isXml(text)) return { text, width, height, unsafe: unsafeSvg(root) };
    } catch { /* 落到原始输出 */ }
  }
  // 降级：原始输出本身是合法 XML 时仍可使用（不改变现有能正常显示的图）。
  const box = /viewBox="([^"]+)"/.exec(svg)?.[1].trim().split(/[\s,]+/).map(Number);
  const fallback = box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0
    ? { width: Math.ceil(box[2]), height: Math.ceil(box[3]) } : { width: null, height: null };
  return isXml(svg) ? { text: svg, ...fallback, unsafe: unsafeSvgText(svg) } : null;
}

// 安全检查直接看 DOM 节点/属性：标签文本里出现 “ onclick = …” 这类字面量不应被误判。
function unsafeSvg(root: SVGSVGElement): boolean {
  const elements: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const element of elements) {
    const tag = element.localName.toLowerCase();
    if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed') return true;
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (/^on[a-z]+$/.test(name)) return true;
      if (name === 'href' || name.endsWith(':href')) {
        const value = attribute.value.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
        if (value.startsWith('javascript:') || value.startsWith('vbscript:')) return true;
      }
    }
  }
  return false;
}

const unsafeSvgText = (svg: string) => /<script[\s>]/i.test(svg) || /\son[a-z]+\s*=/i.test(svg) || /(?:xlink:href|href)\s*=\s*["']?\s*javascript:/i.test(svg);

// S-6：图上不含脚本时以 data URL 图片输出，既保持外观又让渲染输出可以走严格白名单。
// 渲染路径优先使用 prepareSvg 里的 DOM 级安全检查，这里保留同样的字符串判定供白名单/测试复用。
export function svgDataUrl(svg: string): string | null {
  if (unsafeSvgText(svg)) return null;
  return dataUrl(svg);
}

function dataUrl(svg: string): string {
  const utf8 = new TextEncoder().encode(svg), chunks: string[] = [];
  for (let index = 0; index < utf8.length; index += 0x8000) chunks.push(String.fromCharCode(...utf8.subarray(index, index + 0x8000)));
  return `data:image/svg+xml;base64,${btoa(chunks.join(''))}`;
}

const escapeAttribute = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

// alt 只放简短描述：渲染失败时不能把整段图源码当文字显示。
export async function renderDiagramImage(code: string, prefix: string, theme: 'default' | 'dark' = appTheme, alt = 'Mermaid 图'): Promise<string> {
  const svg = await renderDiagram(code, prefix, theme);
  const prepared = prepareSvg(svg);
  if (!prepared || prepared.unsafe) return '';
  const url = dataUrl(prepared.text);
  if (!url) return '';
  // Mermaid 的 SVG 通常使用 width="100%"。明确固有尺寸，避免小图被拉伸到整栏。
  const dimensions = prepared.width && prepared.height ? ` width="${prepared.width}" height="${prepared.height}"` : '';
  return `<img class="diagram"${dimensions} src="${url}" alt="${escapeAttribute(alt)}">`;
}

// 把 Mermaid 的解析错误整理成可读定位信息：只保留行号与首行说明，不把源码片段整段显示出来。
export function describeDiagramError(error: unknown): { line: number | null; detail: string } {
  const raw = (error instanceof Error ? error.message : String(error ?? '')).trim();
  const line = Number(/(?:parse|lexical|lexer|parsing)[^.\n]*?line[^\d\n]*(\d+)/i.exec(raw)?.[1] ?? 0) || null;
  const detail = raw.split(/\r?\n/).map(text => text.trim()).find(Boolean)?.replace(/^Error:\s*/i, '').slice(0, 240) ?? '';
  return { line, detail };
}
