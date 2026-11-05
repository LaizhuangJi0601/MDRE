import { icon } from './icons';
import './window-dialog.css';
import { toStylePixels, uiScale } from './ui-scale';

// v0.2.7 需求 5.2：记住帮助 / 快捷键等窗口式弹窗上次显示的位置与尺寸。
// v0.3.0：弹窗参与界面缩放（CSS zoom），外接矩形是视觉像素，而内联样式是缩放前单位；
// 记录与恢复都按视觉像素换算，保证不同缩放比例下仍在可视区域内。
const BOUNDS_KEY = 'mdre.window-dialog.bounds';
type DialogBounds = { left: number; top: number; width: number; height: number };
const rememberable = (dialog: HTMLDialogElement) => !!dialog.id && !document.body.dataset.auxWindow;
const storedBounds = (): Record<string, DialogBounds> => {
  try {
    const value = JSON.parse(localStorage.getItem(BOUNDS_KEY) || '{}');
    return value && typeof value === 'object' ? value as Record<string, DialogBounds> : {};
  } catch { return {}; }
};
const validBounds = (bounds: DialogBounds) => [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)
  && bounds.width >= 200 && bounds.height >= 160 && bounds.width <= 8000 && bounds.height <= 8000;
const measureBounds = (dialog: HTMLDialogElement): DialogBounds | null => {
  if (!dialog.open || !dialog.getClientRects().length) return null;
  const rect = dialog.getBoundingClientRect();
  const bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  return validBounds(bounds) ? bounds : null;
};
const writeBounds = (dialog: HTMLDialogElement, bounds: DialogBounds) => {
  if (!rememberable(dialog) || dialog.dataset.maximized === 'true') return;
  const all = storedBounds();
  all[dialog.id] = bounds;
  try { localStorage.setItem(BOUNDS_KEY, JSON.stringify(all)); } catch { /* 存储不可用时只保留本次会话内的位置 */ }
};
// 关闭后 rect 已不可见，保留最后一次测量结果用于落盘。
const lastBounds = new WeakMap<HTMLDialogElement, DialogBounds>();
const applyBounds = (dialog: HTMLDialogElement) => {
  if (!dialog.open || !rememberable(dialog)) return;
  const saved = storedBounds()[dialog.id];
  const scale = uiScale();
  if (!saved || !validBounds(saved)) {
    // 首次打开且没有记忆位置：按窗口可视区域铺满（考虑界面缩放），避免 150%/200% 时超出窗口。
    const width = (innerWidth - 24) / scale;
    const height = (innerHeight - 24) / scale;
    dialog.style.width = `${width}px`;
    dialog.style.height = `${height}px`;
    const rect = dialog.getBoundingClientRect();
    dialog.style.left = `${Math.max(12, (innerWidth - rect.width) / 2) / scale}px`;
    dialog.style.top = `${Math.max(12, (innerHeight - rect.height) / 2) / scale}px`;
    return;
  }
  const width = Math.max(320, Math.min(saved.width, innerWidth - 24));
  const height = Math.max(240, Math.min(saved.height, innerHeight - 24));
  dialog.dataset.moved = 'true';
  dialog.style.width = `${toStylePixels(width)}px`;
  dialog.style.height = `${toStylePixels(height)}px`;
  const rect = dialog.getBoundingClientRect();
  dialog.style.left = `${toStylePixels(Math.max(12, Math.min(saved.left, innerWidth - rect.width - 12)))}px`;
  dialog.style.top = `${toStylePixels(Math.max(12, Math.min(saved.top, innerHeight - rect.height - 12)))}px`;
};

// Webview 内窗口采用同一标题栏与八向缩放；独立桌面窗口由系统提供边框和控制按钮。
export function windowDialog(dialog: HTMLDialogElement) {
  if(dialog.dataset.windowChrome){applyBounds(dialog);return;}
  dialog.dataset.windowChrome='true';
  const title=dialog.querySelector<HTMLElement>(':scope > h3')!;
  const bar=document.createElement('header');bar.className='dialog-window-bar';
  title.before(bar);bar.append(title);
  const controls=document.createElement('div');controls.className='dialog-window-controls';bar.append(controls);
  let normal='';
  for(const [action,label,glyph] of [['minimize','最小化','minimize'],['maximize','最大化','maximize'],['close','关闭窗口','close']] as const){
    const button=document.createElement('button');button.type='button';button.dataset.windowAction=action;button.setAttribute('aria-label',label);button.title=label;button.innerHTML=icon(glyph);
    button.onclick=()=>{
      if(action==='close'){dialog.dispatchEvent(new Event('cancel',{cancelable:true}));return;}
      if(action==='minimize'){dialog.classList.toggle('dialog-collapsed');button.setAttribute('aria-label',dialog.classList.contains('dialog-collapsed')?'还原':'最小化');return;}
      dialog.classList.remove('dialog-collapsed');
      if(dialog.dataset.maximized==='true'){dialog.style.cssText=normal;dialog.dataset.maximized='false';button.setAttribute('aria-label','最大化');}
      else{normal=dialog.style.cssText;dialog.dataset.maximized='true';Object.assign(dialog.style,{
        left:`${toStylePixels(12)}px`,top:`${toStylePixels(12)}px`,
        width:'calc((100vw - 24px) / var(--ui-scale))',height:'calc((100vh - 24px) / var(--ui-scale))'});button.setAttribute('aria-label','还原');}
    };controls.append(button);
  }
  for(const direction of ['n','s','e','w','ne','nw','se','sw']){
    const handle=document.createElement('div');handle.className='window-edge';handle.dataset.edge=direction;handle.setAttribute('aria-hidden','true');dialog.append(handle);
    handle.onpointerdown=event=>{
      if(event.button!==0||dialog.dataset.maximized==='true')return;
      event.preventDefault();handle.setPointerCapture(event.pointerId);dialog.dataset.moved='true';
      const rect=dialog.getBoundingClientRect(),x=event.clientX,y=event.clientY;
      const move=(next:PointerEvent)=>{
        const minW=Math.min(440,innerWidth-24),minH=Math.min(280,innerHeight-24);
        const dx=next.clientX-x,dy=next.clientY-y;
        let left=rect.left,right=rect.right,top=rect.top,bottom=rect.bottom;
        if(direction.includes('w'))left=Math.max(12,Math.min(rect.left+dx,right-minW));
        if(direction.includes('e'))right=Math.min(innerWidth-12,Math.max(rect.right+dx,left+minW));
        if(direction.includes('n'))top=Math.max(12,Math.min(rect.top+dy,bottom-minH));
        if(direction.includes('s'))bottom=Math.min(innerHeight-12,Math.max(rect.bottom+dy,top+minH));
        Object.assign(dialog.style,{left:`${toStylePixels(left)}px`,top:`${toStylePixels(top)}px`,
          width:`${toStylePixels(right-left)}px`,height:`${toStylePixels(bottom-top)}px`});
      };
      const finish=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('lostpointercapture',finish);};
      handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('lostpointercapture',finish);
    };
  }
  // 拖动 / 缩放会改写内联样式：每次变化立即测量（此时仍可见），合并为 250ms 一次落盘；
  // 关闭时用最后一次测量值立即记录，随后打开时恢复。
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    const bounds = measureBounds(dialog);
    if (!bounds) return;
    lastBounds.set(dialog, bounds);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = undefined; writeBounds(dialog, bounds); }, 250);
  }).observe(dialog, { attributes: true, attributeFilter: ['style'] });
  dialog.addEventListener('close', () => {
    clearTimeout(saveTimer); saveTimer = undefined;
    const bounds = lastBounds.get(dialog);
    if (bounds) writeBounds(dialog, bounds);
  });
  // 记录的是视觉尺寸；恢复时按当前界面缩放换算。
  applyBounds(dialog);
}
