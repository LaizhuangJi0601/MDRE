// 文件格式模块：把语言 id 解析为 CodeMirror 的 StreamLanguage（按需动态加载）。
// 纯模块：不访问 Tauri/vscode API、不 import 项目内其他文件。
import { StreamLanguage } from '@codemirror/language';
import { languageSpec } from './languages';

/**
 * 按稳定语言 id 加载 CodeMirror 语言扩展。
 * 未知 id、legacy mode 加载失败或解析器构造失败时返回 null，由调用方回退纯文本。
 */
export async function loadLanguage(id: string | null | undefined): Promise<StreamLanguage<unknown> | null> {
  const spec = languageSpec(id);
  if (!spec) return null;
  try {
    const parser = await spec.load();
    return StreamLanguage.define(parser);
  } catch {
    // 按需分块加载失败（离线缓存缺失、打包裁剪等）不应让编辑器不可用。
    return null;
  }
}

export { languageSpec } from './languages';
