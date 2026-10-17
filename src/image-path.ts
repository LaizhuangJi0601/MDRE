// 使用 CommonMark 图片目的地址 + 标准 file URI，不引入图片路径自定义语法。
export function absoluteImagePath(value: string): string | null {
  if (/^file:/i.test(value)) {
    try {
      const uri = new URL(value), pathname = decodeURIComponent(uri.pathname);
      if (uri.hostname && uri.hostname !== 'localhost') return `//${uri.hostname}${pathname}`;
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch { return null; }
  }
  const path = value.replace(/\\/g, '/');
  return /^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+|\/)/.test(path) ? path : null;
}

// 导出时图片必须能内嵌进单个 HTML：data、HTTPS 或可读取的本地绝对路径（file URI、盘符、UNC）。
export function embeddableImageSource(value: string): boolean {
  return /^(?:data:image\/(?:png|jpeg|gif|webp|svg\+xml);|https?:\/\/)/i.test(value) || !!absoluteImagePath(value);
}

export function imageFileUri(value: string): string {
  const path = absoluteImagePath(value);
  if (!path) throw new Error('图片需要绝对文件路径。');
  if (/^file:/i.test(value)) return new URL(value).href;
  const encoded = path.split('/').map((part, index) => index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join('/');
  return path.startsWith('//') ? `file:${encoded}` : `file://${path.startsWith('/') ? '' : '/'}${encoded}`;
}

export function imageMarkdown(alt: string, source: string): string {
  const src = absoluteImagePath(source) ? imageFileUri(source) : source;
  const destination = /[\s()<>]/.test(src) || /^file:/i.test(src) ? `<${src.replace(/</g, '%3C').replace(/>/g, '%3E')}>` : src;
  return `![${alt.replace(/[\[\]()]/g, '')}](${destination})`;
}

export function imagePaths(data: DataTransfer | null): string[] {
  if (!data) return [];
  const paths = [...data.files].map(file => (file as File & { path?: string }).path ?? '');
  for (const kind of ['text/uri-list', 'text/plain']) paths.push(...data.getData(kind).split(/\r?\n/).map(value => value.trim().replace(/^"|"$/g, '')));
  const vscodeResources = data.getData('application/vnd.code.resources');
  if (vscodeResources) { try { const values: unknown = JSON.parse(vscodeResources); if (Array.isArray(values)) paths.push(...values.filter((value): value is string => typeof value === 'string')); } catch { /* 非资源拖放保持原流程。 */ } }
  return [...new Set(paths.filter(value => !value.startsWith('#')).map(absoluteImagePath).filter((value): value is string => !!value && /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(value)))];
}

export function imagePathsFromText(text: string): string[] {
  return text.split(/\r?\n/).map(value => value.trim().replace(/^"|"$/g, '')).map(absoluteImagePath)
    .filter((value): value is string => !!value && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(value));
}
