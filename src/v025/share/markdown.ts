// MDRE 0.2.5：图片目标改写工具（可分享副本用）。
// 只处理 `![alt](target "title")` 形态；宽度后缀 `{w:…}` 不在图片 atom 区域内，无需处理。

export function encodeMarkdownDestination(value: string): string {
  const destination = value.replace(/\\/g, '/');
  if (/[\s()<>]/.test(destination) || /^file:/i.test(destination)) {
    return `<${destination.replace(/</g, '%3C').replace(/>/g, '%3E')}>`;
  }
  return destination;
}

/** 把单个 Markdown 图片语法中的目标替换为 destination；无法识别时返回 null。 */
export function rewriteImageDestination(imageSyntax: string, destination: string): string | null {
  const match = /^(!\[[\s\S]*?\])\(([\s\S]*)\)$/.exec(imageSyntax);
  if (!match) return null;
  const body = match[2];
  const target = /^(\s*)(<[^>]*>|[^\s]+)([\s\S]*)$/.exec(body);
  if (!target) return null;
  return `${match[1]}(${target[1]}${encodeMarkdownDestination(destination)}${target[3]})`;
}
