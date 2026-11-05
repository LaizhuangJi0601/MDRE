import { invoke } from '@tauri-apps/api/core';
import { saveSettings } from '../persistence/settings';
import { t } from '../i18n/ui';
import { windowDialog } from './window-dialog';

// v0.3.0：独立“检查更新”窗口（与设置、帮助窗口同一套窗口控件与缩放方式）。
// 主窗口只显示版本按钮与蓝点；这里完成检查、显示更新说明、下载校验以及重启选择。
const RELEASES_PAGE = 'https://github.com/LaizhuangJi0601/MDRE/releases/latest';
type UpdateInfo = {
  currentVersion?: string; current_version?: string;
  latestVersion?: string; latest_version?: string;
  tag?: string; htmlUrl?: string; html_url?: string;
  publishedAt?: string; published_at?: string;
  notes?: string;
  assetUrl?: string; asset_url?: string;
  assetSize?: number; asset_size?: number;
  sha256Url?: string; sha256_url?: string; shaUrl?: string;
  updateAvailable?: boolean; update_available?: boolean;
};
type Phase = 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error';
type State = { phase: Phase; info: UpdateInfo | null; error: string; staged: boolean };

export function setupUpdateWindow(options: { close: () => void }) {
  document.body.classList.add('update-window');
  const dialog = document.createElement('dialog');
  dialog.id = 'update-window';
  dialog.setAttribute('aria-label', t('检查版本更新'));
  dialog.innerHTML = `<h3 id="update-window-title">${t('检查版本更新')}</h3>
    <div class="update-content">
      <p id="update-status" role="status"></p>
      <div id="update-meta" class="update-meta"></div>
      <div id="update-notes" class="update-notes"></div>
      <progress id="update-progress" hidden></progress>
      <p id="update-error" role="alert"></p>
    </div>
    <div class="dialog-actions" id="update-actions"></div>`;
  document.body.append(dialog);
  const status = dialog.querySelector<HTMLElement>('#update-status')!;
  const meta = dialog.querySelector<HTMLElement>('#update-meta')!;
  const notes = dialog.querySelector<HTMLElement>('#update-notes')!;
  const progress = dialog.querySelector<HTMLProgressElement>('#update-progress')!;
  const error = dialog.querySelector<HTMLElement>('#update-error')!;
  const actions = dialog.querySelector<HTMLElement>('#update-actions')!;
  const state: State = { phase: 'checking', info: null, error: '', staged: false };
  const currentVersion = () => state.info?.currentVersion ?? state.info?.current_version ?? '';
  const latestVersion = () => state.info?.latestVersion ?? state.info?.latest_version ?? '';
  const available = () => !!(state.info?.updateAvailable ?? state.info?.update_available);
  const htmlUrl = () => state.info?.htmlUrl ?? state.info?.html_url ?? RELEASES_PAGE;
  const assetUrl = () => state.info?.assetUrl ?? state.info?.asset_url ?? '';
  const shaUrl = () => state.info?.sha256Url ?? state.info?.sha256_url ?? state.info?.shaUrl ?? '';
  const formatBytes = (bytes: number) => bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : '';
  const button = (id: string, label: string, primary = false) => `<button id="${id}" type="button"${primary ? ' class="primary-button"' : ''}>${label}</button>`;
  const openPage = () => { void invoke('open_external', { url: htmlUrl() }).catch(reason => { state.error = String(reason); render(); }); };
  const close = () => options.close();
  const render = () => {
    status.textContent = state.phase === 'checking' ? t('正在检查更新…')
      : state.phase === 'available' ? t('有新版本可用，下载完成后重启即可生效。')
      : state.phase === 'downloading' ? t('正在下载并校验更新…')
      : state.phase === 'downloaded' ? t('新版本已下载并校验完成，重启后生效。')
      : state.phase === 'error' ? t('检查更新失败。')
      : t('已是最新版本。');
    const rows: string[] = [];
    if (currentVersion()) rows.push(`${t('当前版本')} · v${currentVersion()}`);
    if (latestVersion()) rows.push(`${t('最新版本')} · v${latestVersion()}`);
    const published = state.info?.publishedAt ?? state.info?.published_at ?? '';
    if (published && state.phase !== 'checking') rows.push(`${t('发布时间')} · ${published.slice(0, 10)}`);
    const size = formatBytes(Number(state.info?.assetSize ?? state.info?.asset_size ?? 0));
    if (size) rows.push(`${t('安装包大小')} · ${size}`);
    meta.replaceChildren(...rows.map(text => Object.assign(document.createElement('p'), { textContent: text })));
    notes.textContent = state.info?.notes ?? '';
    notes.hidden = !state.info?.notes;
    progress.hidden = state.phase !== 'downloading';
    error.textContent = state.error;
    error.hidden = !state.error;
    const parts: string[] = [];
    if (state.phase === 'available' && actionDownload()) parts.push(button('update-download', t('立即更新'), true));
    if (state.phase === 'available') parts.push(button('update-page', t('打开下载页')));
    if (state.phase === 'downloaded') parts.push(button('update-restart', t('点击重启'), true), button('update-later', t('稍后重启')));
    if (state.phase === 'latest') parts.push(button('update-page', t('打开发布页')));
    if (state.phase === 'error') parts.push(button('update-page', t('打开下载页')));
    actions.innerHTML = parts.join('');
    dialog.querySelector<HTMLButtonElement>('#update-page')?.addEventListener('click', openPage);
    dialog.querySelector<HTMLButtonElement>('#update-download')?.addEventListener('click', () => void download());
    dialog.querySelector<HTMLButtonElement>('#update-restart')?.addEventListener('click', () => void restart());
    dialog.querySelector<HTMLButtonElement>('#update-later')?.addEventListener('click', close);
  };
  const actionDownload = () => !!assetUrl();
  const download = async () => {
    if (state.phase !== 'available') return;
    state.phase = 'downloading'; state.error = ''; render();
    try {
      await invoke('download_update', { assetUrl: assetUrl(), shaUrl: shaUrl(), version: latestVersion() });
      state.phase = 'downloaded'; state.staged = true;
    } catch (reason) {
      state.phase = 'error'; state.error = reason instanceof Error ? reason.message : String(reason);
    }
    render();
  };
  const restart = async () => {
    try { await invoke('restart_after_update'); }
    catch (reason) { state.error = String(reason); render(); }
  };
  const check = async () => {
    state.phase = 'checking'; state.error = ''; render();
    try {
      const info = await invoke<UpdateInfo>('check_latest_release');
      state.info = info;
      state.phase = available() ? 'available' : 'latest';
      await saveSettings({ last_update_check: Date.now() });
      void invoke('update_status_to_main', { available: available(), latest: latestVersion() }).catch(() => {});
    } catch (reason) {
      state.phase = 'error';
      state.error = reason instanceof Error ? reason.message : String(reason);
    }
    render();
  };
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.show();
  windowDialog(dialog);
  render();
  window.addEventListener('mdre:settings-applied', render);
  void check();
}
