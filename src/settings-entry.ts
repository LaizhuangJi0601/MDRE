import {setupLanguage,t} from './i18n/ui';
import {openShortcuts} from './ui/shortcuts';
import {positionDialog} from './ui/dialogs';
import './style.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {setupMotion,applyMotion} from './ui/motion';
import { loadSettings, settings } from './persistence/settings';
import { setupPreferences } from './ui/preferences';
await loadSettings();
setupLanguage();
function paint() { void getCurrentWindow().setTitle(t(document.body.dataset.auxWindow==='help'?'MDRE 帮助':document.body.dataset.auxWindow==='shortcuts'?'MDRE 快捷键设置':'MDRE 设置')); applyMotion(); const value=settings(); document.documentElement.dataset.theme=value.theme==='system' ? matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light' : value.theme; }
paint();
await listen('settings-changed',async()=>{await loadSettings();paint();window.dispatchEvent(new Event('mdre:settings-applied'));},{target:getCurrentWindow().label});
const preferences=setupPreferences({
  open: dialog => { if(!dialog.open) dialog.show(); },
  close: dialog => { if(dialog.id==='settings-dialog') void getCurrentWindow().close(); else if(document.body.dataset.auxWindow)void getCurrentWindow().close();else dialog.close(); },
  applied: paint,
  fonts: mono => mono ? ['Consolas','Cascadia Mono','Courier New','monospace'] : ['Microsoft YaHei','Segoe UI','SimSun','KaiTi','sans-serif'],
});
if(!new URLSearchParams(location.search).has('view'))await listen<number>('settings-shutdown', async event=>{
  let error: string|null=null;
  try { if(!await preferences.saveDraft())error='设置未保存，请修正设置页中的错误后再退出。'; }
  catch(reason){error=String(reason);}
  await invoke('settings_shutdown_result',{id:event.payload,error});
},{target:'settings'});
const auxiliary=new URLSearchParams(location.search).get('view');
if(auxiliary==='help'||auxiliary==='shortcuts'){
 document.body.dataset.auxWindow=auxiliary;paint();
 if(auxiliary==='help')document.getElementById('help-menu')!.click();
 else openShortcuts(positionDialog,()=>{void getCurrentWindow().close();},()=>{},reason=>{console.error(reason);});
}else document.getElementById('settings-open')!.click();
setupMotion();
