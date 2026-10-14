export type CodeTheme = 'light' | 'dark';
// 主题是会话内显示偏好，不向 Markdown 写入额外标记；按文档和块 ID 保留。
const themes = new Map<string, CodeTheme>();
export function explicitCodeTheme(owner: string | undefined, id: string): CodeTheme | undefined { return themes.get(`${owner}:${id}`); }
export function codeTheme(owner: string | undefined, id: string): CodeTheme {
  return themes.get(`${owner}:${id}`) ?? (document.documentElement.dataset.codeTheme === 'dark' ? 'dark' : 'light');
}
export function toggleCodeTheme(owner: string | undefined, id: string): CodeTheme {
  const theme = codeTheme(owner,id) === 'light' ? 'dark' : 'light';
  themes.set(`${owner}:${id}`,theme);
  return theme;
}
