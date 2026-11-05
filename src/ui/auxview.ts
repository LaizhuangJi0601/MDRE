import { CodeEditor } from '../formats';
import { codeLanguageFor, detectFileKind } from '../formats';
import { renderDocx, type DocxHeading } from '../formats';
import { PdfViewer, type PdfErrorCode } from '../pdf';
import { pdfAssetUrls } from './pdf-assets';
import '../pdf/viewer.css';

// v0.3.0：桌面主窗口内的非 Markdown 文档视图（txt/代码/docx/pdf）。
// - txt/代码：CodeMirror 编辑区，可编辑、保存仍走主窗口文档模型；
// - docx：mammoth 渲染的只读连续阅读区，标题进入大纲；
// - pdf：pdf.js 查看器，大纲导航显示页面缩略图，范围读取由宿主提供。
// 平台差异（文件读取、保存、错误提示）全部通过 options 注入，桌面与插件共用同一实现。
export type AuxKind = 'code' | 'text' | 'docx' | 'pdf';
export type AuxDocumentView = {
  id: string;
  kind: AuxKind;
  title: string;
  path: string | null;
  source: string;
};
export type AuxAppearance = { fontFamily: string; fontSize: number; lineHeight: number; theme: 'light' | 'dark' };
export type AuxViewOptions = {
  readRange: (path: string, start: number, end: number) => Promise<Uint8Array>;
  fileLength: (path: string) => Promise<number>;
  readArrayBuffer: (path: string) => Promise<ArrayBuffer>;
  onCodeChange: (docId: string, text: string) => void;
  labels: () => Record<string, string>;
  appearance: () => AuxAppearance;
  fail: (reason: unknown) => void;
  message: (text: string) => void;
};

type Elements = {
  panes: HTMLElement; codePane: HTMLElement; codeHost: HTMLElement; codeTitle: HTMLElement; codeLanguage: HTMLElement;
  renderPane: HTMLElement; render: HTMLElement; docxView: HTMLElement; pdfView: HTMLElement;
  sourcePane: HTMLElement; divider: HTMLElement; renderTitle: HTMLElement; previewState: HTMLElement;
  outlineList: HTMLElement; outlineEmpty: HTMLElement; outlineCount: HTMLElement; thumbnails: HTMLElement;
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class AuxViews {
  private codeEditors = new Map<string, { wrapper: HTMLElement; editor: CodeEditor }>();
  private docxCache = new Map<string, { html: string; headings: DocxHeading[] }>();
  private viewer: PdfViewer | null = null;
  private active: AuxDocumentView | null = null;
  private elements: Elements;

  constructor(private options: AuxViewOptions) {
    this.elements = {
      panes: $('panes'), codePane: $('code-pane'), codeHost: $('code-host'), codeTitle: $('code-title'), codeLanguage: $('code-language'),
      renderPane: $('render-pane'), render: $('render'), docxView: $('docx-view'), pdfView: $('pdf-view'),
      sourcePane: $('source-pane'), divider: $('divider'), renderTitle: $('render-title'), previewState: $('preview-state'),
      outlineList: $('outline-list'), outlineEmpty: $('outline-empty'), outlineCount: $('outline-count'), thumbnails: $('pdf-thumbnails'),
    };
  }

  static isAux(kind: string): kind is AuxKind { return kind === 'code' || kind === 'text' || kind === 'docx' || kind === 'pdf'; }
  static kindOf(path: string | null): 'markdown' | AuxKind {
    if (!path) return 'markdown';
    const kind = detectFileKind(path);
    return kind === 'markdown' ? 'markdown' : kind as AuxKind;
  }

  // 显示某个非 Markdown 文档；切换文档时保留各自的编辑/阅读状态。
  show(doc: AuxDocumentView) {
    this.active = doc;
    this.hideAllPanels();
    this.elements.sourcePane.hidden = true;
    this.elements.divider.hidden = true;
    this.elements.previewState.textContent = '';
    if (doc.kind === 'code' || doc.kind === 'text') this.showCode(doc);
    else if (doc.kind === 'docx') void this.showDocx(doc);
    else this.showPdf(doc);
  }

  // 恢复 Markdown 文档视图：隐藏所有辅助面板，由主窗口继续控制源码栏与渲染栏。
  hide() {
    this.active = null;
    this.hideAllPanels();
    this.elements.renderTitle.textContent = '渲染页面';
    this.elements.previewState.textContent = '';
  }

  destroy(docId: string) {
    const entry = this.codeEditors.get(docId);
    if (entry) { entry.editor.destroy(); entry.wrapper.remove(); this.codeEditors.delete(docId); }
    this.docxCache.delete(docId);
    if (this.active?.id === docId && this.active.kind === 'pdf') this.closeViewer();
  }

  refreshAppearance() {
    for (const { editor } of this.codeEditors.values()) editor.refreshAppearance();
  }

  // 供状态栏显示当前代码视图的行列位置。
  codePosition(): { line: number; column: number } | null {
    if (!this.active || (this.active.kind !== 'code' && this.active.kind !== 'text')) return null;
    const entry = this.codeEditors.get(this.active.id);
    if (!entry) return null;
    const head = entry.editor.getView().state.selection.main.head;
    const line = entry.editor.getView().state.doc.lineAt(head);
    return { line: line.number, column: head - line.from + 1 };
  }

  private hideAllPanels() {
    this.closeViewer();
    this.elements.codePane.hidden = true;
    this.elements.render.hidden = false;
    this.elements.docxView.hidden = true;
    this.elements.pdfView.hidden = true;
    this.elements.pdfView.replaceChildren();
    this.elements.thumbnails.hidden = true;
    this.elements.thumbnails.replaceChildren();
    this.elements.outlineList.hidden = false;
    this.elements.codeHost.querySelectorAll<HTMLElement>('[data-aux-editor]').forEach(host => { host.hidden = true; });
  }

  private closeViewer() {
    if (!this.viewer) return;
    try { this.viewer.destroy(); } catch { /* 已销毁或加载中失败 */ }
    this.viewer = null;
  }

  private showCode(doc: AuxDocumentView) {
    this.elements.codePane.hidden = false;
    this.elements.render.hidden = true;
    this.elements.renderTitle.textContent = '代码';
    this.elements.codeTitle.textContent = doc.title;
    const language = codeLanguageFor(doc.path ?? doc.title);
    this.elements.codeLanguage.textContent = language?.label ?? '纯文本';
    this.elements.outlineList.replaceChildren();
    this.elements.outlineEmpty.hidden = false;
    this.elements.outlineEmpty.textContent = '代码文件不提供大纲';
    let entry = this.codeEditors.get(doc.id);
    if (!entry) {
      const wrapper = document.createElement('div');
      wrapper.dataset.auxEditor = 'true';
      wrapper.style.cssText = 'flex:1;min-width:0;min-height:0;display:flex;';
      this.elements.codeHost.append(wrapper);
      const editor = new CodeEditor(wrapper, {
        languageId: language?.id ?? null,
        text: doc.source,
        appearance: this.options.appearance,
        onChange: text => this.options.onCodeChange(doc.id, text),
      });
      entry = { wrapper, editor };
      this.codeEditors.set(doc.id, entry);
      void editor.ready().then(() => { if (this.active?.id === doc.id) editor.focus(); }).catch(this.options.fail);
    } else if (entry.editor.getText() !== doc.source) {
      entry.editor.setText(doc.source, { silent: true });
    }
    entry.wrapper.hidden = false;
    entry.editor.refreshAppearance();
  }

  private async showDocx(doc: AuxDocumentView) {
    this.elements.render.hidden = true;
    this.elements.docxView.hidden = false;
    this.elements.renderTitle.textContent = 'Word 文档';
    this.elements.outlineList.replaceChildren();
    this.elements.outlineEmpty.hidden = true;
    this.elements.outlineCount.textContent = '';
    this.elements.docxView.classList.add('formats-docx');
    let cached = this.docxCache.get(doc.id);
    if (!cached) {
      this.elements.docxView.textContent = '正在载入 Word 文档…';
      try {
        const buffer = await this.options.readArrayBuffer(doc.path!);
        const rendered = await renderDocx(buffer, { labels: this.options.labels() });
        cached = { html: rendered.html, headings: rendered.headings };
        this.docxCache.set(doc.id, cached);
        if (this.active?.id !== doc.id) return;
        this.renderOutline(cached.headings);
        if (rendered.warnings.length) this.options.message(rendered.warnings[0]);
      } catch (reason) {
        this.elements.docxView.textContent = reason instanceof Error ? reason.message : String(reason);
        return;
      }
    }
    this.elements.docxView.innerHTML = cached.html;
    this.elements.docxView.scrollTop = 0;
    this.elements.docxView.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach(heading => {
      heading.style.cursor = 'pointer';
      heading.addEventListener('click', () => document.getElementById(heading.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    });
  }

  private renderOutline(headings: DocxHeading[]) {
    this.elements.outlineList.replaceChildren();
    this.elements.outlineCount.textContent = headings.length ? String(headings.length) : '';
    this.elements.outlineEmpty.hidden = !!headings.length;
    if (!headings.length) { this.elements.outlineEmpty.textContent = '当前文档没有标题'; return; }
    for (const heading of headings) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'outline-item';
      button.textContent = heading.text;
      button.style.paddingLeft = `${8 + (heading.level - 1) * 12}px`;
      button.onclick = () => document.getElementById(heading.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      this.elements.outlineList.append(button);
    }
  }

  private showPdf(doc: AuxDocumentView) {
    this.elements.render.hidden = true;
    this.elements.pdfView.hidden = false;
    this.elements.renderTitle.textContent = 'PDF';
    this.elements.outlineList.hidden = true;
    this.elements.outlineEmpty.hidden = true;
    this.elements.outlineCount.textContent = '';
    this.elements.thumbnails.hidden = false;
    this.closeViewer();
    const host = document.createElement('div');
    host.className = 'pdf-view-host';
    this.elements.pdfView.append(host);
    const viewer = new PdfViewer(host, pdfAssetUrls(), {
      onPageChange: (page, pages) => { if (this.active?.id === doc.id) this.elements.previewState.textContent = `${page} / ${pages}`; },
      onError: error => {
        const code = (error as { code?: PdfErrorCode }).code;
        const readable = code === 'password' ? '此 PDF 受密码保护，暂不支持打开。' : error.message || '无法打开此 PDF。';
        host.replaceChildren(Object.assign(document.createElement('p'), { className: 'dialog-hint', textContent: readable }));
        this.options.fail(error);
      },
    });
    this.viewer = viewer;
    void this.openPdf(viewer, doc);
  }

  private async openPdf(viewer: PdfViewer, doc: AuxDocumentView) {
    try {
      const length = await this.options.fileLength(doc.path!);
      if (this.viewer !== viewer) return;
      await viewer.open({ length, readRange: (start, end) => this.options.readRange(doc.path!, start, end) });
      if (this.viewer !== viewer) return;
      viewer.setLabels(this.options.labels());
      viewer.mountThumbnails(this.elements.thumbnails);
    } catch (reason) {
      this.options.fail(reason);
    }
  }
}
