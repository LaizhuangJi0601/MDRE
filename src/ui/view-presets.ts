import { settings, saveSettings, type ViewState } from '../persistence/settings';

export const viewPresets = [
  { name: '全量编辑', paper: false, source: true, sidebar: true, toolbar: true },
  { name: '专注模式', paper: true, source: false, sidebar: true, toolbar: false },
  { name: '沉浸专注', paper: true, source: false, sidebar: false, toolbar: false },
  { name: 'A4视图', paper: true, source: false, sidebar: true, toolbar: true },
];
const same = (a: ViewState, b: ViewState) => (['paper','source','sidebar','toolbar'] as const).every(key => a[key] === b[key]);
export function setupViewPresets(options: { read: () => Omit<ViewState, 'name'>; apply: (state: ViewState) => void; fail: (reason: unknown) => void }) {
  const picker = document.createElement('div'); picker.id = 'view-picker'; picker.className = 'dropdown';
  picker.innerHTML = '<button id="view-mode" class="mode-button" aria-haspopup="menu" aria-expanded="false" data-tooltip="选择视图模式" aria-label="选择视图模式"><span id="view-label"></span><span class="caret"></span></button><div class="dropdown-popup" role="menu" aria-label="视图模式" hidden></div>';
  document.getElementById('mode-picker')!.before(picker);
  const popup = picker.querySelector<HTMLElement>('.dropdown-popup')!, button = picker.querySelector<HTMLButtonElement>('button')!;
  let name = settings().last_view?.name ?? '全量编辑', suspended = false;
  const sync = () => {
    if (suspended) return;
    const state = { ...options.read(), name };
    const match = viewPresets.find(preset => preset.name === name && same(preset, state)) ?? viewPresets.find(preset => same(preset, state));
    name = match?.name ?? '自由模式'; state.name = name;
    document.getElementById('view-label')!.textContent = name;
    popup.querySelectorAll<HTMLElement>('[data-view]').forEach(item => item.setAttribute('aria-checked', String(item.dataset.view === name)));
    if (JSON.stringify(settings().last_view) !== JSON.stringify(state)) void saveSettings({ last_view: state }).catch(options.fail);
  };
  const apply = (state: ViewState) => {
    suspended = true;
    try { options.apply(state); name = state.name; }
    catch (reason) { options.fail(reason); }
    finally { suspended = false; sync(); }
  };
  for (const preset of viewPresets) {
    const item = document.createElement('button'); item.dataset.view = preset.name; item.role = 'menuitemradio'; item.textContent = preset.name;
    item.onclick = () => { popup.hidden = true; button.setAttribute('aria-expanded', 'false'); apply(preset); }; popup.append(item);
  }
  const free = document.createElement('button'); free.dataset.view = '自由模式'; free.role = 'menuitemradio'; free.textContent = '自由模式（按当前组合）';
  free.onclick = () => { popup.hidden = true; button.setAttribute('aria-expanded', 'false'); }; popup.append(free);
  button.onclick = () => { const rect = button.getBoundingClientRect(); popup.style.left = Math.max(4, Math.min(rect.left, innerWidth - 220)) + 'px'; popup.style.top = 'auto'; popup.style.bottom = (innerHeight - rect.top + 4) + 'px'; popup.hidden = !popup.hidden; button.setAttribute('aria-expanded', String(!popup.hidden)); };
  picker.addEventListener('mousedown', event => event.preventDefault());
  document.addEventListener('pointerdown', event => { if (!picker.contains(event.target as Node)) { popup.hidden = true; button.setAttribute('aria-expanded', 'false'); } });
  const observer = new MutationObserver(sync);
  for (const [element, attributes] of [[document.body, ['class']], [document.getElementById('panes')!, ['class']], [document.getElementById('outline-panel')!, ['hidden']], [document.getElementById('render')!, ['class']]] as const) observer.observe(element, { attributes: true, attributeFilter: [...attributes] });
  const defaults = () => apply({ name: '自由模式', paper: settings().paper_enabled, source: settings().show_source, sidebar: settings().sidebar_visible, toolbar: settings().toolbar_visible });
  if (settings().last_view) apply(settings().last_view!); else defaults();
  return {
    defaults,
    restore: () => settings().last_view ? apply(settings().last_view!) : defaults(),
    select: (name: string) => { const preset = viewPresets.find(view => view.name === name); if (preset) apply(preset); },
    focus: () => {
      const target = name === '专注模式' || name === '沉浸专注' ? '全量编辑' : '专注模式';
      apply(viewPresets.find(preset => preset.name === target)!);
    },
  };
}
