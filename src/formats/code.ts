// 文件格式模块：纯前端代码编辑器（CodeMirror 6 外壳），供桌面主窗口与插件 webview 共用（MDRE 0.3.0）。
// 纯模块：不访问 Tauri/vscode API、不 import 项目内其他文件；字体/主题/行距全部由 appearance() 注入。
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { loadLanguage } from './language';

/** 宿主注入的外观参数。lineHeight 为无单位倍数（如 1.85）；大于 5 时按像素处理。 */
export interface CodeAppearance {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  theme: 'light' | 'dark';
}

export interface CodeEditorOptions {
  /** `codeLanguageFor(path)?.id`；null 表示纯文本（无语法着色）。 */
  languageId: string | null;
  text: string;
  /** 文档内容变化时回调（输入法组合输入结束时才会触发，setText 默认也会触发）。 */
  onChange?(text: string): void;
  /** 每次需要主题/字号时调用；宿主在这里返回当前正文设置。 */
  appearance(): CodeAppearance;
  /** 自动换行，默认 true。 */
  lineWrapping?: boolean;
  /** 缩进空格数，默认 2。 */
  tabSize?: number;
  /** 只读，默认 false。 */
  readOnly?: boolean;
}

interface Palette {
  background: string; foreground: string; gutterBackground: string; gutterForeground: string; gutterBorder: string;
  activeLine: string; activeLineGutter: string; selection: string; cursor: string; matchingBracket: string; border: string;
  comment: string; keyword: string; string: string; number: string; operator: string; variable: string;
  definition: string; type: string; property: string; tag: string; meta: string; invalid: string;
}

const palettes: Record<'light' | 'dark', Palette> = {
  light: {
    background: '#ffffff', foreground: '#1f2328', gutterBackground: '#ffffff', gutterForeground: '#6e7781', gutterBorder: '#d8dee4',
    activeLine: '#f6f8fa', activeLineGutter: '#f0f3f6', selection: '#b6d7ff', cursor: '#1f2328', matchingBracket: '#dbeafe', border: '#d0d7de',
    comment: '#6e7781', keyword: '#cf222e', string: '#0a3069', number: '#0550ae', operator: '#24292f', variable: '#24292f',
    definition: '#8250df', type: '#953800', property: '#0550ae', tag: '#116329', meta: '#6e7781', invalid: '#82071e',
  },
  dark: {
    background: '#1e1e1e', foreground: '#d4d4d4', gutterBackground: '#1e1e1e', gutterForeground: '#858585', gutterBorder: '#2b2b2b',
    activeLine: '#2a2d2e', activeLineGutter: '#242424', selection: '#264f78', cursor: '#aeafad', matchingBracket: '#3a3d41', border: '#3c3c3c',
    comment: '#6a9955', keyword: '#c586c0', string: '#ce9178', number: '#b5cea8', operator: '#d4d4d4', variable: '#9cdcfe',
    definition: '#dcdcaa', type: '#4ec9b0', property: '#9cdcfe', tag: '#569cd6', meta: '#9b9b9b', invalid: '#f44747',
  },
};

const lineHeightOf = (appearance: CodeAppearance): string => appearance.lineHeight > 5 ? `${appearance.lineHeight}px` : String(appearance.lineHeight);

/** 由宿主外观参数生成 CodeMirror 主题（配色由模块自持，字号/字体/行距/明暗由宿主决定）。 */
function themeExtension(appearance: CodeAppearance): Extension {
  const palette = palettes[appearance.theme === 'dark' ? 'dark' : 'light'];
  const lineHeight = lineHeightOf(appearance);
  return EditorView.theme({
    '&': { color: palette.foreground, backgroundColor: palette.background, fontSize: `${appearance.fontSize}px`, fontFamily: appearance.fontFamily, height: '100%' },
    '.cm-scroller': { fontFamily: appearance.fontFamily, lineHeight, overflow: 'auto' },
    '.cm-content': { fontFamily: appearance.fontFamily, lineHeight, caretColor: palette.cursor },
    '.cm-gutters': { backgroundColor: palette.gutterBackground, color: palette.gutterForeground, borderRight: `1px solid ${palette.gutterBorder}`, fontFamily: appearance.fontFamily, lineHeight },
    '.cm-activeLine': { backgroundColor: palette.activeLine },
    '.cm-activeLineGutter': { backgroundColor: palette.activeLineGutter },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: palette.selection },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: palette.cursor },
    '&.cm-focused': { outline: 'none' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: palette.matchingBracket, outline: `1px solid ${palette.border}` },
    '.cm-line': { padding: '0 6px 0 4px' },
    '.cm-panels': { backgroundColor: palette.gutterBackground, color: palette.foreground },
  }, { dark: appearance.theme === 'dark' });
}

/** 由宿主外观参数生成语法高亮样式（浅色/深色两套，接近 VS Code 默认配色）。 */
function highlightExtension(appearance: CodeAppearance): Extension {
  const palette = palettes[appearance.theme === 'dark' ? 'dark' : 'light'];
  return syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: palette.comment, fontStyle: 'italic' },
    { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword], color: palette.keyword },
    { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character, tags.docString], color: palette.string },
    { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.unit], color: palette.number },
    { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket, tags.squareBracket, tags.paren, tags.brace, tags.derefOperator], color: palette.operator },
    { tag: [tags.variableName, tags.special(tags.variableName), tags.self], color: palette.variable },
    { tag: [tags.definition(tags.variableName), tags.function(tags.variableName), tags.function(tags.propertyName)], color: palette.definition },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: palette.type },
    { tag: [tags.propertyName, tags.attributeName, tags.attributeValue], color: palette.property },
    { tag: [tags.tagName, tags.angleBracket], color: palette.tag },
    { tag: [tags.meta, tags.processingInstruction, tags.annotation, tags.documentMeta], color: palette.meta },
    { tag: [tags.labelName, tags.macroName], color: palette.type },
    { tag: [tags.invalid, tags.deleted], color: palette.invalid },
    { tag: [tags.heading, tags.strong, tags.emphasis, tags.link, tags.url, tags.monospace], color: palette.definition },
  ]));
}

/**
 * 代码文件编辑器（只负责编辑区本身）。
 *
 * 特性：行号、历史撤销/重做、多选与列选择、Tab 缩进/Shift+Tab 反缩进、自动换行开关、
 * 组合输入（IME）走 CodeMirror 原生流程不做按键拦截、深浅色与字体/字号/行距跟随 `appearance()`。
 * 使用方负责容器尺寸（`formats.css` 中 `.formats-code` 提供默认铺满样式）。
 */
export class CodeEditor {
  private readonly host: HTMLElement;
  private readonly options: CodeEditorOptions;
  private readonly view: EditorView;
  private readonly languageCompartment = new Compartment();
  private readonly appearanceCompartment = new Compartment();
  private readonly highlightCompartment = new Compartment();
  private readonly readOnlyCompartment = new Compartment();
  private readonly wrapCompartment = new Compartment();
  private readonly tabSize: number;
  private readonly loading: Promise<void>;
  private languageId: string | null;
  private readOnly: boolean;
  private silent = false;
  private disposed = false;
  private loadGeneration = 0;

  constructor(host: HTMLElement, options: CodeEditorOptions) {
    if (!host) throw new Error('CodeEditor 需要一个宿主元素。');
    this.host = host;
    this.options = options;
    this.languageId = options.languageId ?? null;
    this.readOnly = options.readOnly ?? false;
    this.tabSize = Math.max(1, Math.min(12, Math.round(options.tabSize ?? 2)));
    const appearance = options.appearance();
    host.classList.add('formats-code');
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: options.text ?? '',
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          EditorState.allowMultipleSelections.of(true),
          EditorState.tabSize.of(this.tabSize),
          indentUnit.of(' '.repeat(this.tabSize)),
          // indentWithTab 同时处理 Tab 缩进与 Shift+Tab 反缩进；快捷键不拦截组合输入（IME）。
          keymap.of([...closeBracketsKeymap, indentWithTab, ...historyKeymap, ...defaultKeymap]),
          this.wrapCompartment.of((options.lineWrapping ?? true) ? EditorView.lineWrapping : []),
          this.languageCompartment.of([]),
          this.appearanceCompartment.of(themeExtension(appearance)),
          this.highlightCompartment.of(highlightExtension(appearance)),
          this.readOnlyCompartment.of(this.readOnlyExtensions()),
          EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', translate: 'no' }),
          EditorView.updateListener.of(update => {
            if (!update.docChanged || this.silent || this.disposed) return;
            this.options.onChange?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    this.loading = this.applyLanguage(this.languageId);
  }

  /** 语言扩展的首次加载完成（失败也会 resolve；语言不可用时回退纯文本）。 */
  ready(): Promise<void> { return this.loading; }

  /** 当前编辑器内容（与输入法组合输入的状态一致，CodeMirror 在组合期间不派发变更）。 */
  getText(): string { return this.view.state.doc.toString(); }

  /** 替换全文。silent=true 时既不触发 onChange 也不写入撤销历史（用于外部同步）。 */
  setText(text: string, options?: { silent?: boolean }): void {
    if (this.disposed) return;
    const silent = options?.silent ?? false;
    this.silent = silent;
    try {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: text ?? '' },
        selection: { anchor: 0 },
        annotations: silent ? Transaction.addToHistory.of(false) : [],
        userEvent: silent ? 'setText.silent' : 'setText',
      });
    } finally {
      this.silent = false;
    }
  }

  /** 切换只读：只读状态下可选中/复制，但不能编辑。 */
  setReadOnly(readOnly: boolean): void {
    if (this.disposed) return;
    this.readOnly = readOnly;
    this.view.dispatch({ effects: this.readOnlyCompartment.reconfigure(this.readOnlyExtensions()) });
  }

  /** 切换语法语言（异步加载；null 为纯文本）。 */
  async setLanguage(languageId: string | null): Promise<void> {
    if (this.disposed) return;
    this.languageId = languageId;
    await this.applyLanguage(languageId);
  }

  getLanguageId(): string | null { return this.languageId; }

  /** 自动换行开关。 */
  setLineWrapping(enabled: boolean): void {
    if (this.disposed) return;
    this.view.dispatch({ effects: this.wrapCompartment.reconfigure(enabled ? EditorView.lineWrapping : []) });
  }

  /** 重新读取 appearance() 并应用主题/字号/字体/行距（正文设置变化时调用）。 */
  refreshAppearance(): void {
    if (this.disposed) return;
    const appearance = this.options.appearance();
    this.view.dispatch({ effects: [
      this.appearanceCompartment.reconfigure(themeExtension(appearance)),
      this.highlightCompartment.reconfigure(highlightExtension(appearance)),
    ] });
  }

  focus(): void { if (!this.disposed) this.view.focus(); }

  undo(): boolean { return !this.disposed && undo(this.view); }

  redo(): boolean { return !this.disposed && redo(this.view); }

  /** 暴露底层 EditorView，供宿主做滚动同步等高级接线（不属于稳定契约的语义保证）。 */
  getView(): EditorView { return this.view; }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadGeneration++;
    this.host.classList.remove('formats-code');
    this.view.destroy();
  }

  private readOnlyExtensions(): Extension {
    return [EditorState.readOnly.of(this.readOnly), EditorView.editable.of(!this.readOnly)];
  }

  private async applyLanguage(languageId: string | null): Promise<void> {
    const generation = ++this.loadGeneration;
    const language = await loadLanguage(languageId);
    if (this.disposed || generation !== this.loadGeneration) return;
    this.view.dispatch({ effects: this.languageCompartment.reconfigure(language ?? []) });
  }
}
