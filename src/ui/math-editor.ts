import { MathfieldElement, validateLatex } from 'mathlive';
import 'mathlive/fonts.css';
import katex from 'katex';
import { mathUnsupported } from '../math-edit';
import { splitFormulaTag, joinFormulaTag, plainFormulaNumber } from '../math-tag';

// 字体由 Vite 随应用打包；禁用库的动态字体、声音、计算引擎下载。
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;
MathfieldElement.computeEngine = null;
MathfieldElement.locale = 'zh-cn';

export function validateFormula(latex: string, display: boolean) {
  try {
    const { body } = splitFormulaTag(latex, display);
    if (validateLatex(body).length || /\\(?:placeholder|html\w*|href|url|includegraphics)\b/.test(latex)) throw new Error(mathUnsupported);
    katex.renderToString(latex, { displayMode: display, throwOnError: true, strict: 'ignore', trust: false });
  } catch (cause) { throw new Error(mathUnsupported, { cause }); }
}

// 用仍负责渲染的 KaTeX 检查往返转换，防止 MathLive 静默丢失命令。
function representation(latex: string, display: boolean): string {
  const markup = katex.renderToString(latex, { output: 'mathml', displayMode: display, throwOnError: true, strict: 'ignore', trust: false });
  const root = new DOMParser().parseFromString(markup, 'text/html').querySelector('math')!;
  root.querySelectorAll('annotation').forEach(node => node.remove());
  // 单子节点的 mrow 只用于分组，不改变公式；其它结构、文字与样式全部保留。
  for (const row of [...root.querySelectorAll('mrow')].reverse()) if (row.childNodes.length === 1) row.replaceWith(row.firstChild!);
  return root.outerHTML;
}

export function createMathEditor(host: HTMLElement, keyboardHost: HTMLElement, latex: string, display: boolean) {
  validateFormula(latex, display);
  const formula = splitFormulaTag(latex, display);
  const field = new MathfieldElement();
  field.id = 'math-field';
  field.setAttribute('aria-label', '可视化公式草稿');
  field.mathVirtualKeyboardPolicy = 'manual';
  field.defaultMode = display ? 'math' : 'inline-math';
  field.smartMode = false;
  host.replaceChildren(field);
  field.menuItems = [];
  field.keybindings = field.keybindings.filter(binding => {
    const command = binding.command;
    return binding.ifMode !== 'latex' && !(Array.isArray(command) && command[0] === 'switchMode' && command[1] === 'latex') && !binding.key.includes('Escape');
  });
  // 反斜杠通常会触发 MathLive 源码模式，当前窗口只提供可视化编辑。
  field.addEventListener('keydown', event => { if (event.key === '\\') { event.preventDefault(); event.stopPropagation(); } });
  field.addEventListener('mode-change', () => { if (field.mode === 'latex') field.mode = 'math'; });
  field.setValue(formula.body, { silenceNotifications: true });
  validateFormula(field.getValue(), display);
  if (field.errors.length) { field.remove(); throw new Error(mathUnsupported); }
  const initial = field.getValue();
  if (representation(formula.body, display) !== representation(initial, display)) { field.remove(); throw new Error(mathUnsupported); }
  const numbering = document.createElement('div');
  numbering.className = 'math-numbering';
  numbering.hidden = !display;
  numbering.innerHTML = '<label><input id="math-number-enabled" type="checkbox">公式编号</label><input id="math-number" type="text" aria-label="公式编号" placeholder="例如 1、3a、A.1" maxlength="120"><label><input id="math-number-parentheses" type="checkbox">显示括号</label><span id="math-number-preview" aria-label="编号预览"></span><small id="math-number-hint"></small>';
  host.append(numbering);
  const enabled = numbering.querySelector<HTMLInputElement>('#math-number-enabled')!;
  const number = numbering.querySelector<HTMLInputElement>('#math-number')!;
  const parentheses = numbering.querySelector<HTMLInputElement>('#math-number-parentheses')!;
  const preview = numbering.querySelector<HTMLElement>('#math-number-preview')!;
  const complex = !!formula.tag && !plainFormulaNumber(formula.tag.argument);
  enabled.checked = !!formula.tag;
  number.value = complex ? '' : formula.tag?.argument ?? '';
  number.hidden = complex;
  parentheses.checked = !formula.tag?.starred;
  numbering.querySelector<HTMLElement>('#math-number-hint')!.textContent = complex ? '复杂编号保留原格式；可继续编辑公式主体。修改编号内容请使用源码栏。' : '手动编号，不自动重排；取消勾选可移除编号。';
  const numberValue = () => complex ? formula.tag!.argument : number.value;
  const updateNumber = () => {
    number.disabled = !enabled.checked;
    parentheses.disabled = !enabled.checked;
    preview.replaceChildren();
    if (enabled.checked) {
      try {
        const combined = joinFormulaTag(formula, formula.body, true, numberValue(), !parentheses.checked);
        const tag = splitFormulaTag(combined, true).tag!;
        preview.innerHTML = katex.renderToString(`\\text{${tag.starred ? tag.argument : `(${tag.argument})`}}`, { throwOnError: true, strict: 'ignore', trust: false });
      } catch { preview.textContent = '请输入有效编号'; }
    }
  };
  enabled.onchange = parentheses.onchange = number.oninput = updateNumber;
  updateNumber();
  const keyboard = window.mathVirtualKeyboard;
  keyboard.container = keyboardHost;
  keyboard.layouts = ['numeric', 'symbols', 'greek', 'alphabetic', {
    label: '结构',
    rows: [
      ['\\frac{#0}{#0}', '\\sqrt{#0}', '#@^{#0}', '#@_{#0}', '\\left(#0\\right)', '\\left|#0\\right|'],
      ['\\sum_{#0}^{#0}', '\\prod_{#0}^{#0}', '\\int_{#0}^{#0}', '\\lim_{#0}', '\\sin', '\\cos'],
      ['\\begin{pmatrix}#0&#0\\\\#0&#0\\end{pmatrix}', '\\begin{cases}#0&#0\\\\#0&#0\\end{cases}', '\\hat{#0}', '\\vec{#0}', '\\overline{#0}', '\\log'],
      ['[left]', '[right]', '[up]', '[down]', '[backspace]'],
    ].map(row => row.map(key => key.startsWith('[') ? key : { latex: key, class: 'small' })),
  }];
  keyboard.editToolbar = 'none';
  const sizeKeyboard = () => {
    const height = keyboard.boundingRect.height;
    if (height > 0) keyboardHost.style.height = `${Math.ceil(height)}px`;
  };
  keyboard.addEventListener('geometrychange', sizeKeyboard);
  field.focus();
  keyboard.show();
  sizeKeyboard();
  return {
    field,
    value() {
      const value = field.getValue();
      if (field.errors.length) throw new Error(mathUnsupported);
      validateFormula(value, display);
      // 未修改或局部撤销回初始值时，避免库规范化导致原公式被重写。
      const combined = joinFormulaTag(formula, value === initial ? formula.body : value, display && enabled.checked, numberValue(), !parentheses.checked);
      validateFormula(combined, display);
      return combined;
    },
    dispose() { keyboard.removeEventListener('geometrychange', sizeKeyboard); keyboard.hide(); field.remove(); numbering.remove(); keyboard.container = null; keyboardHost.style.removeProperty('height'); },
  };
}
