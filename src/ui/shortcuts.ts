import {settings,saveSettings,shortcutCommands} from '../persistence/settings';
import {windowDialog} from './window-dialog';
export function openShortcuts(open:(dialog:HTMLDialogElement)=>void,close:(dialog:HTMLDialogElement)=>void,applied:()=>void,fail:(reason:unknown)=>void) {
  let dialog=document.getElementById('shortcut-dialog') as HTMLDialogElement|null;
  if(!dialog){dialog=document.createElement('dialog');dialog.id='shortcut-dialog';dialog.innerHTML='<h3>快捷键设置</h3><p class="dialog-hint">点入输入框后按组合键即可重绑；Esc 恢复该项默认值。修改保存到配置文件。</p><div id="shortcut-list"></div><div class="dialog-actions"><button id="shortcut-cancel">取消</button><button id="shortcut-save" class="primary-button">保存</button></div>';document.body.append(dialog);}
  dialog.dataset.cancel='shortcut-cancel';dialog.oncancel=event=>{event.preventDefault();close(dialog!);};
  document.getElementById('shortcut-cancel')!.onclick=()=>close(dialog!);
  const current=settings();document.getElementById('shortcut-list')!.replaceChildren(...shortcutCommands.map(command=>{
    const row=document.createElement('div');row.className='shortcut-row';const label=document.createElement('label');label.textContent=command.label;label.htmlFor=`shortcut-key-${command.id}`;
    const input=document.createElement('input');input.id=label.htmlFor;input.value=current.shortcuts[command.id]??command.fallback;input.placeholder=command.fallback||'未绑定';input.setAttribute('aria-label',`${command.label} 快捷键`);
    input.onkeydown=event=>{if(event.isComposing||event.key==='Tab')return;event.preventDefault();event.stopPropagation();if(event.key==='Escape'){input.value='';return;}if(['Control','Shift','Alt','Meta'].includes(event.key))return;input.value=[...(event.ctrlKey?['Ctrl']:[]),...(event.shiftKey?['Shift']:[]),...(event.altKey?['Alt']:[]),...(event.metaKey?['Meta']:[]),event.key.length===1?event.key.toUpperCase():event.key].join('+');};row.append(label,input);return row;
  }));
  document.getElementById('shortcut-save')!.onclick=()=>{const shortcuts:Record<string,string>={};for(const command of shortcutCommands){const value=(document.getElementById(`shortcut-key-${command.id}`) as HTMLInputElement).value.trim();if(value&&value!==command.fallback)shortcuts[command.id]=value;}void saveSettings({shortcuts}).then(()=>{applied();close(dialog!);}).catch(fail);};
  open(dialog);windowDialog(dialog);
}
