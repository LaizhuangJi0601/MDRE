import { isTauri } from '@tauri-apps/api/core';
import { saveSettings, settings } from '../persistence/settings';
export type Theme = 'system' | 'light' | 'dark';
export async function setupTheme(select: HTMLSelectElement, changed: (dark: boolean) => void, error: (reason: unknown) => void) {
  const system = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const host = document.body.dataset.vscodeThemeKind || [...document.body.classList].find(name => /^vscode-(?:light|dark|high-contrast)/.test(name));
    const systemDark = host ? /dark|high-contrast(?!-light)/.test(host) : system.matches;
    const dark = select.value === 'system' ? systemDark : select.value === 'dark';
    const next = dark ? 'dark' : 'light';
    const repaint = document.documentElement.dataset.theme !== next || document.documentElement.dataset.codeTheme !== settings().code_theme;
    document.documentElement.dataset.theme = next;
    document.documentElement.dataset.codeTheme = settings().code_theme;
    if (repaint) changed(dark);
  };
  select.onchange = () => {
    apply();
    if (isTauri()) saveSettings({ theme: select.value as Theme }).catch(error);
  };
  system.addEventListener('change', () => { if (select.value === 'system') apply(); });
  select.value = settings().theme;
  new MutationObserver(() => { if (select.value === 'system') apply(); }).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] });
  apply();
  return apply;
}
export function defaultMode(): 'edit' | 'read' { return settings().default_mode; }
export function setupDefaultMode(select: HTMLSelectElement, error: (reason: unknown) => void) {
  select.value = defaultMode();
  select.onchange = () => { void saveSettings({ default_mode: select.value === 'read' ? 'read' : 'edit' }).catch(error); };
}
