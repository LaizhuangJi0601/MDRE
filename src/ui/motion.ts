import { settings } from '../persistence/settings';

// 两端共用原生动画。正文只改变透明度，不给输入面叠加 transform/zoom。
const running = new Map<Element, Animation>();
export function motionEnabled() {
  const mode=settings().motion;
  return mode==='on' || mode!=='off' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}
export function applyMotion() {
  document.documentElement.dataset.motion=motionEnabled()?'on':'off';
  if(!motionEnabled()){for(const animation of running.values())animation.cancel();running.clear();}
}
export function fadeSurface(element: Element | null, duration=300) {
  if(!element || !motionEnabled() || !element.getClientRects().length || document.body.classList.contains('ime-active'))return;
  running.get(element)?.cancel();
  const animation=element.animate([{opacity:0},{opacity:1}],{duration,easing:'cubic-bezier(.2,.7,.2,1)'});
  running.set(element,animation);
  const done=()=>{if(running.get(element)===animation)running.delete(element);};
  animation.onfinish=done;animation.oncancel=done;
}
export function departSurface(element: HTMLElement) {
  if(!motionEnabled()||!element.getClientRects().length)return;
  const rect=element.getBoundingClientRect(), ghost=element.cloneNode(true) as HTMLElement;
  ghost.inert=true;ghost.setAttribute('aria-hidden','true');ghost.removeAttribute('id');ghost.removeAttribute('data-tab');
  Object.assign(ghost.style,{position:'fixed',left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,zIndex:'180',pointerEvents:'none',background:'var(--surface)'});
  document.body.append(ghost);
  const animation=ghost.animate([{opacity:1},{opacity:0}],{duration:200});running.set(ghost,animation);
  const done=()=>{ghost.remove();running.delete(ghost);};animation.onfinish=done;animation.oncancel=done;
}
export function highlightTarget(element: HTMLElement|null) {
  if(!element||!motionEnabled()||document.body.classList.contains('ime-active'))return;
  running.get(element)?.cancel();
  const animation=element.animate([{backgroundColor:getComputedStyle(document.documentElement).getPropertyValue('--hit')},{backgroundColor:'transparent'}],{duration:550});
  running.set(element,animation);const done=()=>{if(running.get(element)===animation)running.delete(element);};animation.onfinish=done;animation.oncancel=done;
}
export function setupMotion() {
  applyMotion();
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',applyMotion);
  window.addEventListener('mdre:settings-applied',applyMotion);
  window.addEventListener('mdre:document-motion',()=>fadeSurface(document.getElementById('render-pane')));
  window.addEventListener('mdre:layout-motion',()=>{
    for(const id of ['source-pane','render-pane','outline-panel','edit-bar'])fadeSurface(document.getElementById(id));
  });
  let composition=0;
  document.addEventListener('compositionstart',()=>{composition++;document.body.classList.add('ime-active');for(const animation of running.values())animation.cancel();running.clear();},true);
  document.addEventListener('compositionend',()=>{const epoch=composition;setTimeout(()=>{if(epoch===composition)document.body.classList.remove('ime-active');},0);},true);
  let layoutFrame=0;
  const layoutClasses=(value:string)=>value.split(/\s+/).filter(name=>['focus-mode','toolbar-hidden','sidebar-hidden','read-only','source-hidden','welcome-state','paper-mode','paper-paged','outline-collapsed'].includes(name)).sort().join(' ');
  for(const element of [document.body,document.getElementById('panes'),document.getElementById('outline-panel'),document.getElementById('render')]){
    if(!element)continue;
    new MutationObserver(records=>{if(!layoutFrame && records.some(record=>record.attributeName==='hidden'||record.attributeName==='class' && layoutClasses(record.oldValue??'')!==layoutClasses(element.className)))layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;window.dispatchEvent(new Event('mdre:layout-motion'));});}).observe(element,{attributes:true,attributeOldValue:true,attributeFilter:['hidden','class']});
  }
  // 状态反馈不观察正文树，避免长文档输入时产生额外布局扫描。
  for(const id of ['status-text','error','help-content','pandoc-status','settings-tool-status','settings-error']){
    const element=document.getElementById(id);if(!element)continue;
    new MutationObserver(()=>{if(element.textContent)fadeSurface(element,180);}).observe(element,{childList:true,characterData:true,subtree:true});
  }
  new MutationObserver(records=>{if(records.some(record=>record.attributeName==='data-theme'))fadeSurface(document.getElementById('titlebar')??document.getElementById('settings-form'));}).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
}
