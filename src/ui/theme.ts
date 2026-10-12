import { isTauri } from '@tauri-apps/api/core';
import { loadSettings, saveSettings, settings } from '../persistence/settings';
export type Theme = 'system' | 'light' | 'dark';
export async function setupTheme(select: HTMLSelectElement, changed: (dark: boolean) => void, error: (reason: unknown) => void) {
  const system = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const dark = select.value === 'system' ? system.matches : select.value === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'; changed(dark);
    document.documentElement.dataset.codeTheme = settings().code_theme;
  };
  select.onchange = () => {
    apply();
    if (isTauri()) saveSettings({ theme: select.value as Theme }).catch(error);
  };
  system.addEventListener('change', () => { if (select.value === 'system') apply(); });
  if (isTauri()) {
    try { select.value = (await loadSettings()).theme; } catch (reason) { error(reason); }
  }
  apply();
  return apply;
}
export function defaultMode(): 'edit' | 'read' { return settings().default_mode; }
export function setupDefaultMode(select: HTMLSelectElement, error: (reason: unknown) => void) {
  select.value = defaultMode();
  select.onchange = () => { void saveSettings({ default_mode: select.value === 'read' ? 'read' : 'edit' }).catch(error); };
}
