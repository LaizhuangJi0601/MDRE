import { invoke, isTauri } from '@tauri-apps/api/core';
import { settings, saveSettings } from './persistence/settings';
import { staticHtml } from './export';
import { resolveImage } from './assets';
import type { Workspace } from './session';

export function setupReadingWidth(paper: {enabled: boolean}, fail: (reason: unknown) => void) {
  const holder = document.createElement('label'); holder.id = 'reading-width'; holder.title = '非 A4 模式下的正文宽度，仅影响屏幕阅读';
  holder.innerHTML = '页宽 <input type="range" min="60" max="100" step="1" aria-label="渲染页宽"><output></output>';
  document.getElementById('status-spacer')!.after(holder);
  const slider = holder.querySelector('input')!, output = holder.querySelector('output')!;
  const paint = (width: number) => { slider.value = String(width); slider.style.setProperty("--range-fill", `${(width-60)/40*100}%`); output.value = `${width}%`; document.documentElement.style.setProperty('--reading-width', `${width}%`); holder.hidden = paper.enabled; };
  paint(settings().render_width);
  slider.oninput = () => paint(Number(slider.value));
  slider.onchange = () => { void saveSettings({render_width:Number(slider.value)}).catch(fail); };
  document.getElementById('render')!.addEventListener('mdre:paper-layout', () => paint(settings().render_width));
  window.addEventListener('mdre:settings-applied', () => paint(settings().render_width));
}

type WordOptions = { workspace: Workspace; flush(): void; fail(reason: unknown): void; message(text: string): void; open(path: string): Promise<void> };
export async function wordHtml(source: string, resolve: (src: string) => Promise<string | null>) {
  const page = new DOMParser().parseFromString(await staticHtml(source, resolve, {mathFormat:'mathml'}), 'text/html');
  // 使用 MathML 交给 Pandoc HTML reader，兼容本机 2.12 并生成 OMML。
  page.querySelectorAll('style,script,link,meta,.code-header,.footnote-backref').forEach(e => e.remove());
  return page.documentElement.outerHTML;
}
export function setupWord(options: WordOptions) {
  const buttons: HTMLButtonElement[] = [];
  let busy = false;
  const work = async (run: () => Promise<void>) => {
    if (busy) return; busy = true; buttons.forEach(b => b.disabled = true);
    try { options.flush(); if (options.workspace.active?.composition) throw new Error('请先提交组合输入再转换。'); await run(); }
    catch (reason) { options.fail(reason); }
    finally { busy = false; paintButtons(); }
  };
  const exportDocx = async (explicitPath?: string) => {
    const doc = options.workspace.active; if (!doc || doc.welcome) throw new Error('请先打开文档。');
    options.flush(); if (doc.composition) throw new Error('请先提交组合输入再导出。');
    // 导出采用调用时快照，转换期间的后续编辑不受影响。
    const text = doc.source;
    await invoke('detect_pandoc', {tool:settings().pandoc_path});
    const path = explicitPath ?? await invoke<string | null>('pick_export', {format:'docx',suggested:doc.title.replace(/\.(md|markdown|txt)$/i,'')+'.docx'});
    if (!path) return;
    options.message('正在调用 Pandoc 导出 Word…');
    const html = await wordHtml(text, src => resolveImage(doc, src));
    const result = await invoke<{path:string; bytes:number; warnings:string}>('word_convert', {direction:'export',tool:settings().pandoc_path,reference:settings().word_reference,path,html});
    report(result, '已导出 Word；颜色、字号、复杂版式可能被简化，请核对输出。'); return result;
  };
  const importDocx = async (inputPath?: string, outputPath?: string) => {
    await invoke('detect_pandoc', {tool:settings().pandoc_path});
    const input = inputPath ?? await invoke<string | null>('pick_word', {kind:'import'}); if (!input) return;
    const path = outputPath ?? await invoke<string | null>('pick_export', {format:'md',suggested:input.replace(/\.docx$/i,'.md')}); if (!path) return;
    options.message('正在调用 Pandoc 导入 Word…');
    const result = await invoke<{path:string; bytes:number; warnings:string}>('word_convert', {direction:'import',tool:settings().pandoc_path,path,input});
    await options.open(result.path);
    report(result, '已导入 Word；图片保存在同目录资源文件夹。页眉页脚、修订、浮动对象和复杂版式需核对。'); return result;
  };
  function report(result: {path:string;warnings:string}, text: string) {
    options.message(`${text} ${result.path}${result.warnings ? ' · '+result.warnings.trim() : ''}`);
    const status = document.getElementById('status-text'); if (status) status.title = `${text}\n${result.path}\n${result.warnings}`;
  }
  function button(id: string, label: string, run: () => Promise<unknown>) {
    const b = document.createElement('button'); b.id=id; b.textContent=label; b.role='menuitem'; b.onclick=() => { document.querySelectorAll<HTMLElement>('.dropdown-popup,.menu-popup').forEach(e => e.hidden=true); void work(async()=>{await run();}); }; buttons.push(b); return b;
  }
  const importButton=button('word-import','导入 Word（.docx）…',()=>importDocx());
  if(document.getElementById('status-settings'))document.getElementById('html')!.before(importButton);
  else document.getElementById('open')!.after(importButton);
  document.getElementById('html')!.after(button('word-export','导出 Word（.docx）…',()=>exportDocx()));
  document.getElementById('status-export-menu')?.append(button('status-word-export','导出 Word（.docx）…',()=>exportDocx()));
  function paintButtons() { for(const b of buttons)b.disabled=busy || b.id.includes('export') && (!options.workspace.active || !!options.workspace.active.welcome); }
  paintButtons();
  window.addEventListener('mdre:document-changed',paintButtons);
  Object.assign(window, {mdreWord:{exportDocx,importDocx}});
}
