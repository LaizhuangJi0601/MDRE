import { icon } from './icons';
import './window-dialog.css';

// Webview 内窗口采用同一标题栏与八向缩放；独立桌面窗口由系统提供边框和控制按钮。
export function windowDialog(dialog: HTMLDialogElement) {
  if(dialog.dataset.windowChrome)return;
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
      else{normal=dialog.style.cssText;dialog.dataset.maximized='true';Object.assign(dialog.style,{left:'12px',top:'12px',width:'calc(100vw - 24px)',height:'calc(100vh - 24px)'});button.setAttribute('aria-label','还原');}
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
        Object.assign(dialog.style,{left:`${left}px`,top:`${top}px`,width:`${right-left}px`,height:`${bottom-top}px`});
      };
      const finish=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('lostpointercapture',finish);};
      handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('lostpointercapture',finish);
    };
  }
}
