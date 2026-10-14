import { settings, saveSettings } from '../persistence/settings';
import { icon } from './icons';

export function setupSidebar(fail: (reason: unknown) => void) {
  const panel = document.getElementById('outline-panel')!, handle = document.getElementById('sidebar-resizer')!;
  const collapseButton = document.getElementById('outline-collapse')!;
  let width = settings().sidebar_width, ratio = settings().file_list_ratio;
  const applyWidth = (value: number) => {
    width = Math.max(180, Math.min(420, value));
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
  };
  const applyRatio = (value: number) => {
    ratio = Math.max(20, Math.min(80, value));
    panel.style.setProperty('--files-fr', `${ratio}fr`); panel.style.setProperty('--opened-fr', `${100 - ratio}fr`);
    document.getElementById('file-list-divider')?.setAttribute('aria-valuenow', String(Math.round(ratio)));
  };
  const collapsed = () => {
    const on = settings().outline_collapsed;
    panel.classList.toggle('outline-collapsed', on);
    collapseButton.innerHTML = icon(on ? 'chevronDown' : 'chevronUp');
    collapseButton.setAttribute('aria-expanded', String(!on));
    collapseButton.setAttribute('aria-label', on ? '展开大纲' : '折叠大纲');
    collapseButton.dataset.tooltip = on ? '展开大纲' : '折叠大纲';
  };
  handle.onpointerdown = event => { event.preventDefault(); handle.setPointerCapture(event.pointerId); };
  handle.onpointermove = event => { if (handle.hasPointerCapture(event.pointerId)) applyWidth(event.clientX - panel.getBoundingClientRect().left); };
  handle.onpointerup = event => { handle.releasePointerCapture(event.pointerId); void saveSettings({ sidebar_width: Math.round(width) }).catch(fail); };
  handle.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault(); applyWidth(event.key === 'Home' ? 216 : width + (event.key === 'ArrowRight' ? 10 : -10));
    void saveSettings({ sidebar_width: Math.round(width) }).catch(fail);
  };
  const divider = document.getElementById('file-list-divider');
  if (divider) {
    divider.onpointerdown = event => { event.preventDefault(); divider.setPointerCapture(event.pointerId); };
    divider.onpointermove = event => {
      if (!divider.hasPointerCapture(event.pointerId)) return;
      const rect = document.getElementById('files-view')!.getBoundingClientRect();
      applyRatio((event.clientY - rect.top) / rect.height * 100);
    };
    divider.onpointerup = event => { divider.releasePointerCapture(event.pointerId); void saveSettings({ file_list_ratio: Math.round(ratio) }).catch(fail); };
    divider.onkeydown = event => {
      if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
      event.preventDefault(); applyRatio(event.key === 'Home' ? 60 : ratio + (event.key === 'ArrowDown' ? 5 : -5));
      void saveSettings({ file_list_ratio: Math.round(ratio) }).catch(fail);
    };
  }
  const visibility = () => document.body.classList.toggle('sidebar-hidden', panel.hidden);
  new MutationObserver(visibility).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  visibility(); applyWidth(width); applyRatio(ratio); collapsed();
  return { refresh() { applyWidth(settings().sidebar_width); applyRatio(settings().file_list_ratio); collapsed(); }, collapse() {
    void saveSettings({ outline_collapsed: !settings().outline_collapsed }).then(collapsed).catch(fail);
  } };
}
