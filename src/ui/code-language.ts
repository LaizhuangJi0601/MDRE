// 界面使用完整语言名称，Markdown 围栏保留标准语言标识。
export const codeLanguages = [
  ['text', '纯文本'], ['python', 'Python'], ['js', 'JavaScript'], ['ts', 'TypeScript'],
  ['html', 'HTML'], ['css', 'CSS'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'],
  ['powershell', 'PowerShell'], ['bash', 'Bash'], ['java', 'Java'], ['json', 'JSON'],
  ['yaml', 'YAML'], ['sql', 'SQL'], ['rust', 'Rust'], ['go', 'Go'], ['matlab', 'MATLAB'],
  ['markdown', 'Markdown'], ['xml', 'XML'], ['latex', 'LaTeX'],
] as const;
const aliases: Record<string, string> = { py:'python', javascript:'js', typescript:'ts', ps1:'powershell', pwsh:'powershell', htm:'html', 'c++':'cpp', cs:'csharp', sh:'bash', yml:'yaml', md:'markdown', tex:'latex', plain:'text', plaintext:'text', txt:'text' };
export function codeLanguageName(info: string): string {
  const value = info.trim().split(/\s/)[0].toLowerCase() || 'text';
  return codeLanguages.find(([key]) => key === (aliases[value] ?? value))?.[1] ?? info.trim();
}
