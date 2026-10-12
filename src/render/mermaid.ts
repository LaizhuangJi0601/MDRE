// Mermaid 体积大（数百 KB～1 MB+），仅在文档确实包含图表时才动态加载。
type Mermaid = typeof import('mermaid').default;
let loading: Promise<Mermaid> | null = null;
let applied: 'default' | 'dark' | null = null;
let appTheme: 'default' | 'dark' = 'default';
let sequence = 0;

export function setDiagramTheme(dark: boolean) { appTheme = dark ? 'dark' : 'default'; }
export function diagramsLoaded(): boolean { return loading !== null; }

async function initialize(theme: 'default' | 'dark'): Promise<Mermaid> {
  if (!loading) loading = import('mermaid').then(module => module.default);
  const mermaid = await loading;
  if (applied !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, flowchart: { htmlLabels: false } });
    applied = theme;
  }
  return mermaid;
}
export async function renderDiagram(code: string, prefix: string, theme: 'default' | 'dark' = appTheme): Promise<string> {
  const mermaid = await initialize(theme);
  const { svg } = await mermaid.render(`${prefix}-${Date.now()}-${sequence++}`, code);
  return svg;
}
// S-6：图上不含脚本时以 data URL 图片输出，既保持外观又让渲染输出可以走严格白名单。
export function svgDataUrl(svg: string): string | null {
  if (/<script[\s>]/i.test(svg) || /\son[a-z]+\s*=/i.test(svg) || /(?:xlink:href|href)\s*=\s*["']?\s*javascript:/i.test(svg)) return null;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}
export async function renderDiagramImage(code: string, prefix: string, theme: 'default' | 'dark' = appTheme): Promise<string> {
  const url = svgDataUrl(await renderDiagram(code, prefix, theme));
  return url ? `<img class="diagram" src="${url}" alt="${escapeAlt(code)}">` : '';
}
const escapeAlt = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

