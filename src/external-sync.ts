import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Workspace, DocumentSession } from './session';
import { readTextFile, samePath } from './persistence/save';

type Options = {workspace:Workspace;folder():string|null;refreshFolder():Promise<void>;capture():void;show():void;status():void;saveCopy(doc:DocumentSession):Promise<boolean>;fail(reason:unknown):void};
export async function setupExternalSync(options: Options) {
  let key='', timer:ReturnType<typeof setTimeout>|undefined, refreshing=false, again=false;
  const conflicts=new Map<string,{text:string;fingerprint:string;encoding:string}>();
  const button=document.createElement('button');button.id='external-conflict';button.textContent='查看外部修改冲突';button.hidden=true;document.getElementById('status-text')!.after(button);
  const dialog=document.createElement('dialog');dialog.id='external-compare';dialog.innerHTML='<h3>外部修改：比较并选择保留方式</h3><p>左侧为 MDRE 未保存内容，右侧为磁盘最新内容；另存副本不会覆盖外部文件。</p><div class="external-columns"><label>MDRE 本地修改<textarea readonly></textarea></label><label>磁盘最新内容<textarea readonly></textarea></label></div><div class="dialog-actions"><button data-action="copy">另存本地副本</button><button data-action="reload">载入外部版本</button><button data-action="later">稍后处理</button></div>';document.body.append(dialog);
  let comparing:DocumentSession|undefined;
  button.onclick=()=>{const doc=options.workspace.active,external=doc&&conflicts.get(doc.id);if(!external)return;comparing=doc;const areas=dialog.querySelectorAll('textarea');areas[0].value=doc.source;areas[1].value=external.text;if(!dialog.open)dialog.show();};
  dialog.querySelector<HTMLButtonElement>('[data-action="later"]')!.onclick=()=>dialog.close();
  dialog.querySelector<HTMLButtonElement>('[data-action="copy"]')!.onclick=async()=>{try{if(comparing&&await options.saveCopy(comparing)){conflicts.delete(comparing.id);dialog.close();await refresh();}}catch(reason){options.fail(reason);}};
  dialog.querySelector<HTMLButtonElement>('[data-action="reload"]')!.onclick=async()=>{try{if(!comparing?.path)return;const file=await readTextFile(comparing.path);options.capture();comparing.reloadFrom(file.text,file.fingerprint,file.encoding);conflicts.delete(comparing.id);dialog.close();options.show();options.status();button.hidden=conflicts.size===0;}catch(reason){options.fail(reason);}};
  async function refresh() {
    if(refreshing){again=true;return;}refreshing=true;
    try {
      for(const doc of [...options.workspace.documents.values()]) {
        if(!doc.path||doc.welcome)continue;
        if(doc.composition||doc.saveStatus==='saving'||doc.fileOperation){again=true;continue;}
        try {
          const path=doc.path,file=await readTextFile(path);
          if(!options.workspace.documents.has(doc.id)||!samePath(doc.path,path))continue;
          if(file.fingerprint===doc.diskFingerprint){conflicts.delete(doc.id);continue;}
          if(doc.composition||(doc.saveStatus as string)==='saving'){again=true;continue;}
          if(doc.dirty||doc.saveStatus==='conflict') {
            // 保留原磁盘基准，后续保存仍由指纹检查阻止覆盖。
            doc.saveStatus='conflict';doc.saveError='文件已在外部修改，请比较、另存本地副本或载入外部版本';
            conflicts.set(doc.id,{text:file.text,fingerprint:file.fingerprint,encoding:file.encoding});
          } else {
            if(options.workspace.active===doc)options.capture();
            doc.reloadFrom(file.text,file.fingerprint,file.encoding);
            if(options.workspace.active===doc)options.show();
          }
        } catch(reason) {doc.saveError=`外部文件暂时不可读（可能已移动或删除）：${String(reason)}`;}
      }
      button.hidden=!options.workspace.active||!conflicts.has(options.workspace.active.id);options.status();
    } finally {refreshing=false;if(again){again=false;schedule();}}
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(()=>void refresh().catch(options.fail),350);}
  await listen<{paths:string[];structural:boolean}>('disk-changed',event=>{schedule();if(event.payload.structural&&options.folder()){clearTimeout(folderTimer);folderTimer=setTimeout(()=>void options.refreshFolder().catch(options.fail),450);}});
  let folderTimer:ReturnType<typeof setTimeout>|undefined;
  await listen<string>('disk-watch-error',event=>options.fail(`文件监测异常：${event.payload}；可返回窗口重新检查或手动刷新。`));
  window.addEventListener('focus',schedule);
  return {refresh,update:async()=>{
    const paths=[...options.workspace.documents.values()].filter(d=>d.path&&!d.welcome).map(d=>d.path!);const folder=options.folder(),next=JSON.stringify({paths,folder});
    if(next===key)return;await invoke('watch_files',{paths,folder});key=next;schedule();
  }};
}
