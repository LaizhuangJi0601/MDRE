import { invoke, isTauri } from '@tauri-apps/api/core';
import { saveSettings, settings } from '../persistence/settings';
import { t } from '../i18n/ui';

// v0.3.0：桌面版检查更新的“指示器”。
// 主窗口只负责顶部版本按钮、可用更新蓝点与自动检查；检查/下载/重启的界面在独立“检查更新”窗口中完成。
const DAY = 24 * 60 * 60 * 1000;
type UpdateInfo = {
  current_version?: string; currentVersion?: string;
  latest_version?: string; latestVersion?: string;
  update_available?: boolean; updateAvailable?: boolean;
};
type Options = { open: () => void | Promise<void>; fail: (reason: unknown) => void };

export function setupUpdateIndicator(options: Options) {
  if (!isTauri()) return { refresh: () => undefined };
  const button = document.getElementById('version-button') as HTMLButtonElement | null;
  if (!button) return { refresh: () => undefined };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setDot = (on: boolean) => { button.dataset.update = on ? 'true' : 'false'; };
  const paintVersion = (value: string) => {
    const version = value.trim();
    button.textContent = version ? `MDRE v${version}` : 'MDRE';
    button.title = version ? `MDRE v${version} · ${t('检查版本更新')}` : t('检查版本更新');
  };
  const check = async () => {
    try {
      const info = await invoke<UpdateInfo>('check_latest_release');
      const available = !!(info.update_available ?? info.updateAvailable);
      setDot(available);
      paintVersion(info.current_version ?? info.currentVersion ?? '');
      await saveSettings({ last_update_check: Date.now() });
    } catch {
      // 自动检查失败保持静默；手动检查由独立窗口显示错误。
    }
  };
  const scheduleAuto = () => {
    if (timer) clearTimeout(timer);
    const now = new Date();
    const next = new Date(now); next.setHours(12, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    timer = setTimeout(() => { void check(); scheduleAuto(); }, next.getTime() - now.getTime());
  };
  const missedCheck = () => {
    const last = Number(settings().last_update_check) || 0;
    const now = Date.now();
    if (!last || now - last > DAY) return true;
    const noon = new Date(now); noon.setHours(12, 0, 0, 0);
    return last < noon.getTime();
  };
  button.addEventListener('click', () => { void Promise.resolve(options.open()).catch(options.fail); });
  void invoke<string>('app_version').then(paintVersion).catch(() => {});
  void invoke('cleanup_stale_update').catch(() => {});
  if (missedCheck()) void check();
  scheduleAuto();
  // 独立检查更新窗口完成检查后，通知主窗口刷新蓝点。
  void import('@tauri-apps/api/event').then(({ listen }) => listen<{ available: boolean }>('update-status', event => { setDot(!!event.payload?.available); }, { target: 'main' })).catch(() => {});
  return { refresh: () => { void check(); } };
}
