// 表格操作优化（v0.2.5）：列宽拖拽/双击适应、右键表格菜单、对齐、合并/拆分、转换为 Markdown 表格。
// 数据层在 src/tables.ts；本目录只负责渲染栏交互。main.ts 末尾 provideV025Env 后调用 initTables()。
import { documentHooks, env } from '../runtime';
import { injectTableStyles } from './styles';
import { initTableContextMenu } from './menu';
import { cancelColumnDrag, clearGeometryCache, initColumnResize } from './widths';

// 列宽注释与列数失配时数据层会回退自动列宽；每个文档只在失配集合变化时提示一次，避免刷新刷屏。
const mismatchNotified = new Map<string, string>();

function notifyWidthMismatch(doc: any): void {
  if (!doc || doc.welcome || !doc.model) return;
  let mismatched: string[] = [];
  try {
    mismatched = (doc.model.blocks ?? [])
      .filter((block: any) => block?.type === 'table' && block.node?.attrs?.widthMismatch)
      .map((block: any) => String(block.id));
  } catch { return; }
  const signature = mismatched.join(',');
  if (!mismatched.length) { mismatchNotified.delete(doc.id); return; }
  if (mismatchNotified.get(doc.id) === signature) return;
  mismatchNotified.set(doc.id, signature);
  // 预览刷新结束后 main.ts 还会刷新一次普通状态栏文字；延后一拍再提示，避免被覆盖。
  window.setTimeout(() => {
    try {
      env().message(`表格列宽注释与列数不匹配（${mismatched.length} 处），已回退为自动列宽；可在源码中修正或删除 mdre:table-widths 注释。`);
    } catch { /* 状态栏尚未就绪时静默，等待下一次刷新。 */ }
  }, 0);
}

export function initTables() {
  injectTableStyles();
  initColumnResize();
  initTableContextMenu();
  // 渲染刷新或切换文档后，旧 DOM 的列宽测量缓存与进行中的拖动都必须失效。
  documentHooks.push(doc => {
    cancelColumnDrag();
    clearGeometryCache();
    notifyWidthMismatch(doc);
  });
}
