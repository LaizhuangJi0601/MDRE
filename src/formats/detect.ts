// 文件格式模块：按路径识别文档类型与代码语言（MDRE 0.3.0）。
// 纯模块：不访问 Tauri/vscode API、不 import 项目内其他文件，可直接在 Node 单测中使用。
import { languageSpecForExtension, languageSpecForFilename, languageSpecs } from './languages';

export type FileKind = 'markdown' | 'text' | 'code' | 'docx' | 'pdf';

export type CodeLanguage = { id: string; label: string };

const markdownExtensions = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdwn', 'mkdn', 'mdx', 'rmd', 'qmd']);
// doc/docm 也归入 docx 类型：docm 是可被 mammoth 读取的 OOXML 包；旧版二进制 .doc 由 renderDocx 给出可读错误。
const docxExtensions = new Set(['docx', 'docm', 'doc']);
const pdfExtensions = new Set(['pdf']);

/** 取路径最后一段（同时接受正斜杠/反斜杠，忽略末尾分隔符之外的内容）。 */
export function fileName(path: string): string {
  const value = typeof path === 'string' ? path.trim() : '';
  const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return cut >= 0 ? value.slice(cut + 1) : value;
}

/** 取小写扩展名（不带点）；无扩展名、仅有一个前导点的隐藏文件名返回 null。 */
export function extensionOf(path: string): string | null {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 识别文档类型：
 * `markdown`（.md 等）、`docx`（.docx/.docm/.doc）、`pdf`、其它已知代码扩展名/文件名归 `code`，其余为 `text`。
 * 二进制的非文档格式（图片、压缩包等）也会落到 `text`，调用方应先按支持的类型过滤再处理。
 */
export function detectFileKind(path: string): FileKind {
  const name = fileName(path).toLowerCase();
  if (!name) return 'text';
  // 精确文件名优先于扩展名：CMakeLists.txt（.txt）、nginx.conf（.conf）这类通用扩展名也要识别为代码。
  if (languageSpecForFilename(name)) return 'code';
  const extension = extensionOf(name);
  if (extension) {
    if (markdownExtensions.has(extension)) return 'markdown';
    if (docxExtensions.has(extension)) return 'docx';
    if (pdfExtensions.has(extension)) return 'pdf';
    if (languageSpecForExtension(extension)) return 'code';
    return 'text';
  }
  return 'text';
}

/**
 * 返回路径对应的代码语言（稳定 id + 英文显示名）；Markdown/文档/未知扩展名返回 null（回退纯文本）。
 * 优先匹配精确文件名（Dockerfile、Makefile、CMakeLists.txt 等），其次匹配文件扩展名。
 */
export function codeLanguageFor(path: string): CodeLanguage | null {
  const byFilename = languageSpecForFilename(fileName(path).toLowerCase());
  if (byFilename) return { id: byFilename.id, label: byFilename.label };
  const extension = extensionOf(path);
  const byExtension = extension ? languageSpecForExtension(extension) : null;
  return byExtension ? { id: byExtension.id, label: byExtension.label } : null;
}

/** 所有支持的代码扩展名（小写、无点、去重、按字典序排序），供打开对话框/文件列表过滤使用。 */
export function supportedCodeExtensions(): string[] {
  const extensions = new Set<string>();
  for (const spec of languageSpecs) for (const extension of spec.extensions) extensions.add(extension);
  return [...extensions].sort();
}
