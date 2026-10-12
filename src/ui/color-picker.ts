import { icon, type Icon } from './icons';

const textColors = [['#424242', '深灰'], ['#000000', '黑色'], ['#ffffff', '白色'], ['#e5484d', '红色'], ['#d97706', '橙色'], ['#ca8a04', '金色'], ['#16a34a', '绿色'], ['#0d9488', '青色'], ['#0078d4', '蓝色'], ['#7c3aed', '紫色'], ['#db2777', '粉色'], ['#858585', '灰色']];
const highlightColors = [['#fff3b0', '浅黄'], ['#ffff00', '黄色'], ['#dcfce7', '浅绿'], ['#bbf7d0', '绿色'], ['#cffafe', '浅青'], ['#bae6fd', '浅蓝'], ['#ddd6fe', '淡紫'], ['#f5d0fe', '浅粉'], ['#fecdd3', '粉红'], ['#fed7aa', '浅橙'], ['#e5e7eb', '浅灰'], ['#ffffff', '白色']];

export function colorPicker(kind: 'color' | 'bg'): string {
  const text = kind === 'color', prefix = text ? 'color' : 'highlight', label = text ? '文字颜色' : '高亮颜色';
  const initial = text ? '#e5484d' : '#fff3b0', glyph: Icon = text ? 'color' : 'highlight';
  const colors = text ? textColors : highlightColors;
  return `<div id="${prefix}-picker" class="dropdown color-picker" style="--picked-color:${initial}">
    <button id="${text ? 'color-apply' : 'highlight'}" class="icon-button color-apply" aria-label="应用${label}" data-tooltip="应用${label} ${initial}">${icon(glyph)}</button>
    <button id="${prefix}-preview" class="color-current" aria-label="应用${label} ${initial}" data-tooltip="应用${label} ${initial}"><span class="color-chip"></span></button>
    <button id="${prefix}-menu" class="color-menu" data-dropdown-trigger aria-label="选择${label}" data-tooltip="选择${label}" aria-haspopup="menu" aria-expanded="false"><span class="caret"></span></button>
    <div class="dropdown-popup color-palette" role="menu" aria-label="${label}" hidden>
      <div class="palette-heading">${label}</div><div class="palette-grid">${colors.map(([value, name]) => `<button class="palette-swatch" data-color-preset="${value}" role="menuitemradio" aria-checked="${value === initial}" aria-label="${name} ${value}" title="${name} ${value}" style="--swatch:${value}"></button>`).join('')}</div>
      <div class="palette-custom"><label class="custom-color" title="自定义${label}"><input id="${text ? 'color' : 'bg-color'}" type="color" value="${initial}" aria-label="自定义${label}"></label><input class="color-hex" value="${initial}" maxlength="7" aria-label="${label}十六进制值" spellcheck="false"></div>
      <p class="palette-hint">选色后点击工具栏色块应用</p><button class="color-clear" role="menuitem">${text ? '恢复默认文字颜色' : '清除高亮'}</button>
    </div></div>`;
}

export function setupColorPicker(root: HTMLElement, options: { apply: (value: string | null) => void; dropdown: (open: boolean) => void; run: (operation: () => void) => void }) {
  const native = root.querySelector<HTMLInputElement>('input[type="color"]')!, hex = root.querySelector<HTMLInputElement>('.color-hex')!;
  const label = root.id === 'color-picker' ? '文字颜色' : '高亮颜色';
  function update(value: string) {
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('颜色需为 #RRGGBB 格式，例如 #0078d4。');
    value = value.toLowerCase(); native.value = value; hex.value = value; root.style.setProperty('--picked-color', value);
    for (const button of root.querySelectorAll<HTMLElement>('.color-apply,.color-current')) {
      button.dataset.tooltip = `应用${label} ${value}`; button.setAttribute('aria-label', button.dataset.tooltip);
    }
    root.querySelectorAll<HTMLElement>('[data-color-preset]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.colorPreset === value)));
  }
  const apply = () => options.run(() => { update(hex.value.trim()); options.dropdown(false); options.apply(native.value); });
  root.querySelector<HTMLButtonElement>('.color-apply')!.onclick = apply;
  root.querySelector<HTMLButtonElement>('.color-current')!.onclick = apply;
  root.querySelector<HTMLButtonElement>('.color-menu')!.onclick = () => options.dropdown(root.querySelector<HTMLElement>('.dropdown-popup')!.hidden);
  root.querySelectorAll<HTMLButtonElement>('[data-color-preset]').forEach(button => { button.onclick = () => options.run(() => { update(button.dataset.colorPreset!); options.dropdown(false); }); });
  native.oninput = () => options.run(() => update(native.value));
  native.onchange = () => options.run(() => update(native.value));
  hex.onchange = () => options.run(() => update(hex.value.trim()));
  hex.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(hex.value.trim())) update(hex.value.trim()); };
  hex.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); options.run(() => update(hex.value.trim())); } };
  root.querySelector<HTMLButtonElement>('.color-clear')!.onclick = () => options.run(() => { options.dropdown(false); options.apply(null); });
  return { update, value: () => native.value };
}
