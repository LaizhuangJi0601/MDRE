import {setupLanguage,t} from './i18n/ui';
import {openShortcuts} from './ui/shortcuts';
import {positionDialog} from './ui/dialogs';
import './style.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {setupMotion,applyMotion} from './ui/motion';
import {applyUiScale,setupUiScaleWheel} from './ui/ui-scale';
import { setupUpdateWindow } from './ui/update-window';
import { loadSettings, settings } from './persistence/settings';
import { setupPreferences } from './ui/preferences';
// 辅助窗口在定位完成前先隐藏，避免先在默认位置闪一下再跳到记忆位置。
document.body.classList.add('aux-booting');
await loadSettings();
setupLanguage();
function paint() {
  const title = document.body.dataset.auxWindow==='help' ? 'MDRE 帮助'
    : document.body.dataset.auxWindow==='shortcuts' ? 'MDRE 快捷键设置'
    : document.body.dataset.auxWindow==='update' ? (settings().language==='en' ? 'MDRE Check for Updates' : 'MDRE 检查更新')
    : 'MDRE 设置';
  void getCurrentWindow().setTitle(t(title));
  applyMotion();
  const value=settings();
  document.documentElement.dataset.theme=value.theme==='system' ? matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light' : value.theme;
  applyUiScale(value.ui_scale);
}
paint();
await listen('settings-changed',async()=>{await loadSettings();paint();window.dispatchEvent(new Event('mdre:settings-applied'));},{target:getCurrentWindow().label});
// v0.3.0：辅助窗口内也可用 Ctrl+滚轮调节界面缩放。
setupUiScaleWheel({ onChange: () => window.dispatchEvent(new Event('mdre:settings-applied')) });
const auxiliary=new URLSearchParams(location.search).get('view');
if(auxiliary==='update'){
  document.body.dataset.auxWindow='update';paint();
  setupUpdateWindow({ close: () => { void getCurrentWindow().close(); } });
}else{
  const preferences=setupPreferences({
    open: dialog => { if(!dialog.open) dialog.show(); },
    close: dialog => { if(dialog.id==='settings-dialog') void getCurrentWindow().close(); else if(document.body.dataset.auxWindow)void getCurrentWindow().close();else dialog.close(); },
    applied: paint,
    checkUpdates: () => { void invoke('open_aux_window',{kind:'update'}).catch(()=>{}); },
    fonts: mono => mono ? ['Consolas','Cascadia Mono','Courier New','monospace'] : ['Microsoft YaHei','Segoe UI','SimSun','KaiTi','sans-serif'],
  });
  if(!auxiliary)await listen<number>('settings-shutdown', async event=>{
    // v0.3.0 起设置即时生效并保存，退出主应用时没有待提交草稿。
    await invoke('settings_shutdown_result',{id:event.payload,error:null});
  },{target:'settings'});
  if(auxiliary==='help'||auxiliary==='shortcuts'){
    document.body.dataset.auxWindow=auxiliary;paint();
    if(auxiliary==='help')document.getElementById('help-menu')!.click();
    else openShortcuts(positionDialog,()=>{void getCurrentWindow().close();},()=>{},reason=>{console.error(reason);});
  }else document.getElementById('settings-open')!.click();
}
setupMotion();
// 定位完成后一次性显示辅助窗口内容。
requestAnimationFrame(()=>requestAnimationFrame(()=>document.body.classList.remove('aux-booting')));
