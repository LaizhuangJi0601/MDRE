import { settings } from '../persistence/settings';

// v0.2.7 动画引擎：界面切换统一为“原位交叉淡入淡出”。
//
// 旧实现用 `display … allow-discrete` + `@starting-style` 做透明度过渡：隐藏的元素在整个过渡期间
// 仍占用布局（flex/grid 兄弟节点），新旧视图同时参与排版 —— 新视图被挤到下方、过渡结束时再跳回原位，
// 用户看到的就是“内容从下方飞上来”；同时 `fadeSurface` 会对“正在隐藏”的元素再做一次淡入，
// 造成淡出过程中闪一下。这里改为“快照覆盖层”方案：
//
// 1. 切换前把旧界面克隆成 position:fixed 的覆盖层（ghost），按原位置、原滚动位置盖住旧像素；
// 2. 同步应用新界面（新内容立即出现在最终位置，不参与任何布局动画）；
// 3. ghost 在 400ms 内 opacity 1 → 0：旧内容在原位置由深变浅消失，新内容在应显示位置由浅变深显现。
//
// 全程同步执行、不改动新界面的布局，因此不会出现位移动画、不会白屏闪烁；ghost 用 pointer-events:none，
// 新界面在过渡期间即可点击/输入。任何时候用户开始交互（点击、滚轮、按键）或进入输入法组合输入，
// 立即结束过渡，保证输入响应。正文输入面只允许透明度动画，不叠加 transform/zoom。
// 系统“减少动态效果”或设置里关闭动画时直接切换，不做任何过渡。

export const MOTION_SWAP = 400;
const EASE = 'cubic-bezier(.33,0,.25,1)';
// ghost 层级：盖住正文/侧栏，但低于弹窗（100）、菜单（100）与提示（200）。
const GHOST_Z = 60;
const DIALOG_Z = 250;
// 只有大区域（长文档）才冻结离屏内容；小区域整树克隆本身足够快。
const FREEZE_LIMIT = 600;
const FREEZE_MARGIN = 240;

type Ghost = { wrapper: HTMLElement; animation: Animation; source: Element };
const ghosts = new Map<Element, Ghost>();
let crossfading = false;
let patched = false;

export function motionEnabled() {
  const mode = settings().motion;
  return mode === 'on' || mode !== 'off' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function applyMotion() {
  document.documentElement.dataset.motion = motionEnabled() ? 'on' : 'off';
  if (!motionEnabled()) finishMotions();
}

function imeActive() { return document.body.classList.contains('ime-active'); }
function canAnimate() { return motionEnabled() && !imeActive(); }

// 结束全部进行中的过渡（设置变更、输入法组合、用户交互时调用）。
export function finishMotions() {
  for (const ghost of [...ghosts.values()]) ghost.animation.cancel();
  ghosts.clear();
}

// 快照克隆会把原界面的 id 一起复制进文档；若保留原 id，`getElementById`/`querySelector('dialog[open]')`
// 与 Playwright 严格定位器都会命中克隆，导致遮罩判断、Esc 选择、脚本定位出错。
// 这里给克隆里的 id 统一加前缀，并把样式表里含 id 的选择器复制一份带前缀的版本，
// 保证快照外观不变（类选择器在文档树里照常命中）。
const GHOST_ID_PREFIX = 'mdre-ghost-id-';
let ghostStyleSheet: HTMLStyleElement | null = null;
let ghostStyleSheetCount = -1;

function collectGhostRules(rules: CSSRuleList, output: string[]) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const selector = rule.selectorText;
      if (!selector.includes('#')) continue;
      const rewritten = selector.replace(/#([A-Za-z_][\w-]*)/g, (_match, id: string) => `#${GHOST_ID_PREFIX}${id}`);
      output.push(`${rewritten}{${rule.style.cssText}}`);
    } else if (rule instanceof CSSMediaRule) {
      const inner: string[] = []; collectGhostRules(rule.cssRules, inner);
      if (inner.length) output.push(`@media ${rule.conditionText}{${inner.join('')}}`);
    } else if (rule instanceof CSSSupportsRule) {
      const inner: string[] = []; collectGhostRules(rule.cssRules, inner);
      if (inner.length) output.push(`@supports ${rule.conditionText}{${inner.join('')}}`);
    }
  }
}
function ensureGhostStyles() {
  const count = document.styleSheets.length;
  if (ghostStyleSheet && ghostStyleSheetCount === count) return;
  const pieces: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try { collectGhostRules(sheet.cssRules, pieces); } catch { /* 跨域样式表跳过。 */ }
  }
  if (!ghostStyleSheet) {
    ghostStyleSheet = document.createElement('style');
    ghostStyleSheet.id = 'mdre-ghost-style';
    document.head.append(ghostStyleSheet);
  }
  ghostStyleSheet.textContent = pieces.join('');
  ghostStyleSheetCount = count;
}
function isolateGhostIds(clone: HTMLElement) {
  const renamed = new Map<string, string>();
  const stack: Element[] = [clone];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.id) { const next = `${GHOST_ID_PREFIX}${node.id}`; renamed.set(node.id, next); node.id = next; }
    for (const child of Array.from(node.children)) stack.push(child);
  }
  if (!renamed.size) return;
  // 只在克隆含 SVG 时才需要同步 url(#id)/href="#id" 引用，避免大文档快照的额外遍历开销。
  if (!clone.querySelector('svg')) return;
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    for (const attribute of Array.from(node.attributes)) {
      if (!/href|url|fill|stroke|clip|mask|filter|style/i.test(attribute.name)) continue;
      let value = attribute.value;
      if (!value.includes('#')) continue;
      let changed = false;
      for (const [original, replacement] of renamed) {
        if (value.includes(`#${original}`)) { value = value.split(`#${original}`).join(`#${replacement}`); changed = true; }
      }
      if (changed) node.setAttribute(attribute.name, value);
    }
  }
}

// 把区域“冻结”成固定定位的覆盖层：布局、滚动位置、离屏占位都与切换前一致。
function createGhost(source: Element | null | undefined, zIndex = GHOST_Z): HTMLElement | null {
  if (!(source instanceof HTMLElement) || !source.isConnected) return null;
  if (!source.getClientRects().length) return null;
  const rect = source.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  let clone: HTMLElement;
  try { clone = source.cloneNode(true) as HTMLElement; } catch { return null; }
  const computed = getComputedStyle(source);
  ensureGhostStyles();
  isolateGhostIds(clone);
  const background = computed.backgroundColor === 'rgba(0, 0, 0, 0)' || computed.backgroundColor === 'transparent' ? 'var(--surface, #fafafa)' : computed.backgroundColor;
  // 对话框默认 display:none；克隆不写 open 属性（否则 document.querySelector('dialog[open]')
  // 会把快照当成真实弹窗，导致遮罩/焦点/Esc 判断出错），改用内联 display 强制按打开状态绘制。
  const dialogClone = source instanceof HTMLDialogElement;
  if (dialogClone) clone.style.display = 'flex';
  // 区域根节点铺满覆盖层：位置、尺寸、边距全部对齐切换前的外接矩形。
  const style = clone.style;
  const positioned = computed.position === 'fixed' || computed.position === 'absolute';
  style.position = positioned ? computed.position : 'relative';
  style.inset = 'auto';
  style.left = '0px';
  style.top = '0px';
  style.right = 'auto';
  style.bottom = 'auto';
  style.width = `${rect.width}px`;
  style.height = `${rect.height}px`;
  style.minWidth = '0px';
  style.minHeight = '0px';
  style.maxWidth = 'none';
  style.maxHeight = 'none';
  style.margin = '0';
  style.transform = 'none';
  style.transformOrigin = 'top left';
  style.flex = '0 0 auto';
  style.pointerEvents = 'none';
  style.animation = 'none';
  style.transition = 'none';
  if (dialogClone) { style.display = 'flex'; style.inset = 'auto'; style.left = '0px'; style.top = '0px'; }
  // 长文档只绘制可视区附近的块，其余用 content-visibility 占位，避免快照时整篇重排。
  try { if (source.querySelectorAll('*').length > FREEZE_LIMIT) freezeOffscreen(source, clone, rect); } catch { /* 冻结失败不影响正确性。 */ }
  const wrapper = document.createElement('div');
  wrapper.className = 'mdre-ghost';
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.setAttribute('inert', '');
  wrapper.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;overflow:hidden;pointer-events:none;z-index:${zIndex};background:${background};will-change:opacity;`;
  // 把切换前的 :root 变量冻结到快照上：主题切换时旧界面必须按旧配色淡出，而不是跟着新变量变色。
  try {
    const rootStyle = getComputedStyle(document.documentElement);
    const names: string[] = [];
    for (const property of Array.from(rootStyle)) if (property.startsWith('--')) names.push(property);
    for (const name of names) { const value = rootStyle.getPropertyValue(name).trim(); if (value) wrapper.style.setProperty(name, value); }
  } catch { /* 变量冻结失败只影响主题快照的色彩，不影响动画与布局。 */ }
  wrapper.append(clone);
  document.body.append(wrapper);
  try { copyScroll(source, clone); } catch { /* 滚动位置复制失败时按顶部绘制。 */ }
  return wrapper;
}
function activateGhost(source: Element, wrapper: HTMLElement) {
  const animation = wrapper.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MOTION_SWAP, easing: EASE });
  const ghost: Ghost = { wrapper, animation, source };
  ghosts.set(source, ghost);
  const done = () => { if (ghosts.get(source) === ghost) ghosts.delete(source); wrapper.remove(); };
  animation.onfinish = done;
  animation.oncancel = done;
}

// 切换区域前调用：先拍旧界面快照，再同步执行 mutate，最后让快照原位淡出。
// regions 为空时只执行 mutate（不需要视觉过渡的场景）。
export function crossfade(regions: Array<Element | null | undefined>, mutate: () => void): void {
  if (crossfading || !canAnimate()) { mutate(); return; }
  const targets: Element[] = [];
  for (const region of regions) if (region && !targets.includes(region)) targets.push(region);
  const created: Array<[Element, HTMLElement]> = [];
  for (const target of targets) {
    // 同一区域已有快照在淡出：继续用它，避免 400ms 内连续切换时重复克隆。
    if (ghosts.has(target)) continue;
    const wrapper = createGhost(target);
    if (wrapper) created.push([target, wrapper]);
  }
  crossfading = true;
  try { mutate(); }
  catch (reason) { for (const [, wrapper] of created) wrapper.remove(); throw reason; }
  finally { crossfading = false; }
  for (const [target, wrapper] of created) activateGhost(target, wrapper);
}

// 元素在原位置由浅变深出现（用于弹窗、状态提示等没有旧界面的场景）。
export function revealSurface(element: Element | null | undefined, duration = MOTION_SWAP) {
  if (!element || !canAnimate() || !element.getClientRects().length) return;
  element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASE });
}

// 兼容既有调用点（帮助正文、状态栏等）：新内容在原位淡入。
export function fadeSurface(element: Element | null, duration = MOTION_SWAP) { revealSurface(element, duration); }

// 元素被移除前留一张原位快照并淡出（标签页关闭等）。
export function departSurface(element: HTMLElement) {
  if (!canAnimate() || !element || ghosts.has(element)) return;
  const wrapper = createGhost(element);
  if (wrapper) activateGhost(element, wrapper);
}

export function highlightTarget(element: HTMLElement | null) {
  if (!element || !canAnimate()) return;
  const animation = element.animate([{ backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--hit') }, { backgroundColor: 'transparent' }], { duration: 550 });
  animation.onfinish = () => { try { animation.cancel(); } catch { /* 已结束。 */ } };
}

// 大区域快照：滚动容器的离屏子项只保留占位高度（content-visibility 跳过绘制与内部布局），
// 使整篇长文档的克隆成本与可视区大小相关，而不是与文档长度相关。
function freezeOffscreen(source: Element, clone: Element, clip: DOMRect) {
  const stack: Array<[Element, Element]> = [[source, clone]];
  const left = clip.left - FREEZE_MARGIN, right = clip.right + FREEZE_MARGIN;
  const top = clip.top - FREEZE_MARGIN, bottom = clip.bottom + FREEZE_MARGIN;
  while (stack.length) {
    const [original, duplicate] = stack.pop()!;
    const children = original.children, clones = duplicate.children;
    if (!children.length) continue;
    let scrollable = false;
    try { scrollable = original.scrollHeight - original.clientHeight > 2 || original.scrollWidth - original.clientWidth > 2; } catch { scrollable = false; }
    // 普通容器：只递归，不做冻结。
    if (!scrollable) {
      for (let index = 0; index < children.length; index++) {
        const next = clones[index];
        if (next) stack.push([children[index], next]);
      }
      continue;
    }
    for (let index = 0; index < children.length; index++) {
      const child = children[index] as HTMLElement;
      const duplicateChild = clones[index] as HTMLElement | undefined;
      if (!duplicateChild) continue;
      let rect: DOMRect;
      try { rect = child.getBoundingClientRect(); } catch { continue; }
      if (rect.height <= 0) continue;
      if (rect.bottom < top || rect.top > bottom || rect.right < left || rect.left > right) {
        duplicateChild.style.contentVisibility = 'hidden';
        duplicateChild.style.height = `${rect.height}px`;
        duplicateChild.style.overflow = 'hidden';
        continue;
      }
      stack.push([child, duplicateChild]);
    }
  }
}

// 把原区域的滚动位置与表单当前值复制到快照，保证长文档、长列表与输入框都从同一状态开始淡出。
function copyScroll(source: Element, clone: Element) {
  const stack: Array<[Element, Element]> = [[source, clone]];
  while (stack.length) {
    const [original, duplicate] = stack.pop()!;
    if (original.scrollTop || original.scrollLeft) {
      duplicate.scrollTop = original.scrollTop;
      duplicate.scrollLeft = original.scrollLeft;
    }
    // cloneNode 不会复制用户输入后的 value/checked，弹窗快照需要补一份，否则淡出时会闪回默认值。
    if (original instanceof HTMLInputElement && duplicate instanceof HTMLInputElement) {
      try { duplicate.value = original.value; duplicate.checked = original.checked; } catch { /* 部分 input 类型只读。 */ }
    } else if (original instanceof HTMLTextAreaElement && duplicate instanceof HTMLTextAreaElement) {
      duplicate.value = original.value;
    } else if (original instanceof HTMLSelectElement && duplicate instanceof HTMLSelectElement) {
      duplicate.selectedIndex = original.selectedIndex;
    }
    const children = original.children, clones = duplicate.children;
    for (let index = 0; index < children.length; index++) {
      const next = clones[index];
      if (next) stack.push([children[index], next]);
    }
  }
}

// 弹窗的显示/关闭统一走原位淡入淡出；不改变各弹窗的打开逻辑与焦点行为。
function patchDialogs() {
  if (patched) return;
  patched = true;
  const prototype = HTMLDialogElement.prototype as HTMLDialogElement;
  const originalShow = prototype.show, originalShowModal = prototype.showModal, originalClose = prototype.close;
  prototype.show = function show() {
    originalShow.call(this);
    revealSurface(this);
  };
  prototype.showModal = function showModal() {
    originalShowModal.call(this);
    revealSurface(this);
  };
  prototype.close = function close(returnValue?: string) {
    if (canAnimate() && this.open && this.isConnected && this.getClientRects().length && !ghosts.has(this)) {
      const wrapper = createGhost(this, DIALOG_Z);
      originalClose.call(this, returnValue);
      if (wrapper) activateGhost(this, wrapper);
      return;
    }
    originalClose.call(this, returnValue);
  };
}

export function setupMotion() {
  applyMotion();
  patchDialogs();
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyMotion);
  window.addEventListener('mdre:settings-applied', applyMotion);
  // 输入法组合期间不得动画：立即收尾，并抑制新的过渡。
  let composition = 0;
  document.addEventListener('compositionstart', () => {
    composition++;
    document.body.classList.add('ime-active');
    finishMotions();
  }, true);
  document.addEventListener('compositionend', () => {
    const epoch = composition;
    setTimeout(() => { if (epoch === composition) document.body.classList.remove('ime-active'); }, 0);
  }, true);
  // 用户一开始交互就让旧快照退场：过渡只用于“看”，不阻塞点击、滚轮与键盘。
  const finishOnInteraction = () => { if (ghosts.size) finishMotions(); };
  document.addEventListener('pointerdown', finishOnInteraction, true);
  document.addEventListener('wheel', finishOnInteraction, { capture: true, passive: true });
  document.addEventListener('keydown', finishOnInteraction, true);
  // 窗口尺寸变化时快照位置会失效，直接收尾避免错位。
  window.addEventListener('resize', finishOnInteraction);
  // 状态栏等短文本变化只做轻量淡入，避免频繁过渡干扰阅读。
  for (const id of ['status-text', 'error', 'pandoc-status', 'settings-tool-status', 'settings-error', 'help-content']) {
    const element = document.getElementById(id);
    if (!element) continue;
    const duration = id === 'help-content' ? MOTION_SWAP : 220;
    new MutationObserver(() => { if (element.textContent) fadeSurface(element, duration); }).observe(element, { childList: true, characterData: true, subtree: true });
  }
}
