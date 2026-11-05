// 文件格式模块入口（MDRE 0.3.0）：txt/代码/docx 的纯前端支持。
// 纯模块：不访问 Tauri/vscode API、不 import 项目内其他文件、不 import CSS。
// 由接线方引入 `formats.css`，并把宿主主题/字体等通过 CodeEditor 的 appearance() 回调注入。

export {
  detectFileKind,
  codeLanguageFor,
  supportedCodeExtensions,
  fileName,
  extensionOf,
  type FileKind,
  type CodeLanguage,
} from './detect';

export {
  CodeEditor,
  type CodeAppearance,
  type CodeEditorOptions,
} from './code';

export {
  renderDocx,
  sanitizeDocxHtml,
  annotateDocxHeadings,
  decodeDocxEntities,
  docxHeadingSlug,
  headingText,
  docxLabels,
  type DocxHeading,
  type DocxRenderOptions,
  type DocxRenderResult,
} from './docx';

export { loadLanguage } from './language';

export {
  languageSpecs,
  languageSpec,
  languageSpecForExtension,
  languageSpecForFilename,
  languageIds,
  type LanguageSpec,
} from './languages';
