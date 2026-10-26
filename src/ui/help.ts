import {settings} from '../persistence/settings';
import {t} from '../i18n/ui';
import {invoke,isTauri} from '@tauri-apps/api/core';
import { windowDialog } from './window-dialog';
import MarkdownIt from 'markdown-it';
import { fadeSurface } from './motion';
import { positionDialog } from './dialogs';
import './help.css';

type HelpOptions = {
  documents: Record<string,string>;
  references: Record<string,string>;
  open(dialog: HTMLDialogElement): void;
  close(dialog: HTMLDialogElement): void;
  external(url: string): Promise<unknown>;
};
type Group = { root: HTMLElement; heading: HTMLHeadingElement|null; blocks: HTMLElement[]; children: Group[] };
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim();

// 帮助按当前功能组织；许可附件按需读取，原文不参与改写。
export function setupHelp(options: HelpOptions) {
  const {documents,references}=options;
  const definitions=[
    {label:'使用指南',description:'文件、编辑与导出',pattern:/(?:MDRE使用|usage)\.md$/},
    {label:'语法参考',description:'Markdown 与 HTML',pattern:/(?:MDRE语法|syntax)\.md$/},
    {label:'声明与许可',description:'组件、依赖与授权',pattern:/(?:MDRE声明|third-party-notices|notices)\.md$/},
  ];
  const entries=definitions.map(entry=>({...entry,path:Object.keys(documents).find(path=>!path.includes('/en/')&&entry.pattern.test(path))!})).filter(entry=>entry.path);
  const usagePath=entries.find(entry=>entry.label==='使用指南')?.path;
  if(!usagePath)throw new Error('使用指南资源缺失。');
  const usage:string=usagePath;
  const dialog=document.createElement('dialog');dialog.id='help-dialog';dialog.dataset.cancel='help-close';dialog.setAttribute('aria-labelledby','help-title');
  dialog.innerHTML=`<h3 id="help-title">MDRE 帮助</h3>
    <div class="help-search"><label for="help-filter">搜索文档</label><input id="help-filter" type="search" placeholder="搜索当前文档的功能、操作或语法" autocomplete="off"><span id="help-search-status" role="status" aria-live="polite"></span></div>
    <div class="help-layout"><aside class="help-sidebar"><nav class="help-documents" aria-label="帮助文档"></nav><div class="help-toc-label">本页目录</div><nav id="help-toc" aria-label="本页目录"></nav></aside>
    <article id="help-content" aria-label="帮助正文" tabindex="0"></article></div>
    <div id="help-link-status" role="status" aria-live="polite"></div>
    <div class="dialog-actions"><span class="help-offline">MDRE · 离线帮助</span></div>`;
  document.body.append(dialog);
  const navigation=dialog.querySelector<HTMLElement>('.help-documents')!,toc=dialog.querySelector<HTMLElement>('#help-toc')!;
  const content=dialog.querySelector<HTMLElement>('#help-content')!,filter=dialog.querySelector<HTMLInputElement>('#help-filter')!;
  const status=dialog.querySelector<HTMLElement>('#help-link-status')!,searchStatus=dialog.querySelector<HTMLElement>('#help-search-status')!;
  const renderer=new MarkdownIt({html:false,linkify:false});
  let currentPath=usage,request=0,tree:Group|null=null,opener:HTMLElement|null=null,scrollFrame=0;
  let headings:{heading:HTMLHeadingElement;group:Group;button:HTMLButtonElement}[]=[];

  function close(){options.close(dialog);opener?.focus({preventScroll:true});}

  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  document.addEventListener('keydown',event=>{if(dialog.open&&event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopPropagation();close();}},true);

  function markSection(){
    scrollFrame=0;const top=content.getBoundingClientRect().top;
    const visible=headings.filter(item=>!item.group.root.hidden&&!item.group.root.closest('[hidden]'));
    const active=visible.filter(item=>item.heading.getBoundingClientRect().top<=top+45).at(-1)??visible[0];
    for(const item of headings){if(item===active)item.button.setAttribute('aria-current','location');else item.button.removeAttribute('aria-current');}
  }
  content.addEventListener('scroll',()=>{if(!scrollFrame)scrollFrame=requestAnimationFrame(markSection);},{passive:true});
  function jump(id:string){
    const heading=[...content.querySelectorAll<HTMLElement>('[id]')].find(element=>element.id===id);
    if(!heading)throw new Error('未找到对应章节。');
    filter.value='';applyFilter();
    content.scrollTop+=heading.getBoundingClientRect().top-content.getBoundingClientRect().top-20;
    heading.focus({preventScroll:true});markSection();
  }

  function indexContent(){
    toc.replaceChildren();headings=[];
    const nodes=[...content.children] as HTMLElement[];content.replaceChildren();
    tree={root:content,heading:null,blocks:[],children:[]};const stack:{level:number;group:Group}[]=[{level:1,group:tree}];
    const ids=new Map<string,number>();
    for(const node of nodes){
      if(/^H[2-6]$/.test(node.tagName)){
        const level=Number(node.tagName.slice(1));while(stack.length>1&&stack.at(-1)!.level>=level)stack.pop();
        const base=normalize(node.textContent??'').replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'')||'section';
        const count=ids.get(base)??0;ids.set(base,count+1);node.id=count?`${base}-${count+1}`:base;node.tabIndex=-1;
        const section=document.createElement('section');section.className='help-section';section.setAttribute('aria-labelledby',node.id);section.append(node);
        const group:Group={root:section,heading:node as HTMLHeadingElement,blocks:[],children:[]};
        stack.at(-1)!.group.children.push(group);stack.at(-1)!.group.root.append(section);stack.push({level,group});
        if(level<=3){const button=document.createElement('button');button.type='button';button.textContent=node.textContent;button.dataset.level=String(level);button.onclick=()=>jump(node.id);toc.append(button);headings.push({heading:node as HTMLHeadingElement,group,button});}
      }else{stack.at(-1)!.group.root.append(node);stack.at(-1)!.group.blocks.push(node);}
    }
    const empty=document.createElement('p');empty.id='help-empty';empty.hidden=true;empty.textContent='未找到匹配内容，请尝试其他关键词。';content.append(empty);
    dialog.querySelector<HTMLElement>('.help-toc-label')!.hidden=headings.length===0;
  }

  function filterBlock(block:HTMLElement,query:string,all:boolean):number {
    if(block.tagName==='H1'){block.hidden=false;return 0;}
    if(block.tagName==='TABLE'){
      let found=0;
      const headerMatches=!!query&&normalize(block.querySelector('thead')?.textContent??'').includes(query);
      block.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach(row=>{row.hidden=!(all||headerMatches||normalize(row.textContent??'').includes(query));if(!row.hidden)found++;});
      block.hidden=found===0;return found;
    }
    if(block.matches('ul,ol')){
      let found=0;block.querySelectorAll<HTMLElement>(':scope > li').forEach(row=>{row.hidden=!(all||normalize(row.textContent??'').includes(query));if(!row.hidden)found++;});
      block.hidden=found===0;return found;
    }
    block.hidden=!(all||normalize(block.textContent??'').includes(query));return block.hidden?0:1;
  }
  function filterGroup(group:Group,query:string,inherited=false):number {
    const all=!query||inherited||!!group.heading&&normalize(group.heading.textContent??'').includes(query);
    let found=group.blocks.reduce((total,block)=>total+filterBlock(block,query,all),0);
    for(const child of group.children)found+=filterGroup(child,query,all);
    if(group!==tree)group.root.hidden=!all&&found===0;
    return found+(all&&query&&group.heading?1:0);
  }
  function applyFilter(){
    if(!tree)return;
    const query=normalize(filter.value),found=filterGroup(tree,query);
    content.querySelector<HTMLElement>('#help-empty')!.hidden=!query||found>0;
    searchStatus.textContent=query?t(`${found} 项匹配`):'';
    for(const item of headings)item.button.hidden=!!item.group.root.closest('[hidden]');
    content.scrollTop=0;markSection();
  }
  filter.addEventListener('input',event=>{if(!(event as InputEvent).isComposing)applyFilter();});
  filter.addEventListener('compositionend',applyFilter);

  function localized(path:string){
    if(/\/(?:依赖清单|dependency-inventory\.en)\.md$/.test(path))return settings().language==='en'?'../../docs/licenses/dependency-inventory.en.md':'../../docs/licenses/依赖清单.md';
    const entry=entries.find(entry=>entry.pattern.test(path));if(!entry)return path;
    if(settings().language!=='en')return entry.path;
    const name=entry.label==='使用指南'?'usage':entry.label==='语法参考'?'syntax':'notices';
    return Object.keys(documents).find(path=>path.endsWith(`/en/${name}.md`))??entry.path;
  }
  let helpLanguage=settings().language;
  window.addEventListener('mdre:settings-applied',()=>{
    if(helpLanguage===settings().language)return;
    helpLanguage=settings().language;
    if(dialog.open){filter.value='';void show(currentPath);}
  });
  async function show(path:string,hash=''){
    path=localized(path);
    // 原 Word 独立页的链接继续定位到使用指南中的同一内容。
    if(/(?:^|\/)Word转换\.md$/.test(path)){path=usage;hash='#word-转换';}
    const token=++request,restoreFocus=content.contains(document.activeElement);status.textContent='';
    const selected=entries.find(entry=>entry.pattern.test(path))??entries.find(entry=>entry.label==='声明与许可');
    navigation.querySelectorAll<HTMLButtonElement>('button').forEach(button=>{if(button.dataset.path===selected?.path)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
    let source=documents[path];
    if(path in references){
      tree=null;searchStatus.textContent='';content.textContent='正在加载文档…';toc.replaceChildren();headings=[];
      try{const response=await fetch(references[path]);if(!response.ok)throw new Error('帮助附件加载失败。');source=await response.text();}
      catch(reason){if(token===request){content.textContent='暂时无法打开此文档。';status.textContent=String(reason);}return;}
    }
    if(token!==request)return;
    if(source===undefined)throw new Error('帮助文档不存在。');
    currentPath=path;content.classList.toggle('help-license',path.endsWith('.txt'));content.classList.toggle('syntax-table',selected?.label==='语法参考');
    if(path.endsWith('.txt')){const title=document.createElement('h1');title.textContent='许可证原文';const pre=document.createElement('pre');pre.className='help-license-text';pre.textContent=source;content.replaceChildren(title,pre);}
    else content.innerHTML=renderer.render(source);
    indexContent();applyFilter();if(hash)jump(decodeURIComponent(hash.slice(1)));
    // 替换正文后，原链接已不在 DOM 中；保持 Webview 内的阅读焦点与 Esc 操作。
    if(restoreFocus&&document.activeElement===document.body)content.focus({preventScroll:true});
    fadeSurface(content);
  }
  for(const entry of entries){
    const button=document.createElement('button');button.type='button';button.dataset.path=entry.path;
    const title=document.createElement('strong');title.textContent=entry.label;const detail=document.createElement('span');detail.textContent=entry.description;button.append(title,detail);
    button.onclick=()=>{filter.value='';void show(entry.path).catch(reason=>status.textContent=String(reason));};navigation.append(button);
  }
  content.addEventListener('click',async event=>{
    const link=(event.target as Element).closest<HTMLAnchorElement>('a[href]');if(!link)return;event.preventDefault();
    status.textContent='';
    try{
      const address=new URL(link.getAttribute('href')!,`https://help.local/${currentPath.replace('../../','')}`);
      if(address.origin!=='https://help.local'){
        if(!/^https?:$/.test(address.protocol))throw new Error('此链接类型不受支持。');
        await options.external(address.href);return;
      }
      const target=`../../${decodeURIComponent(address.pathname.slice(1))}`;
      if(target===currentPath&&address.hash){jump(decodeURIComponent(address.hash.slice(1)));return;}
      if(!(target in documents)&&!(target in references)&&!target.endsWith('/Word转换.md'))throw new Error('帮助文档不存在。');
      filter.value='';await show(target,address.hash);
    }catch(reason){status.textContent=String(reason);}
  });
  document.getElementById('help-menu')!.onclick=()=>{
    if(isTauri() && document.body.dataset.auxWindow!=='help'){void invoke('open_aux_window',{kind:'help'});return;}
    opener=document.activeElement instanceof HTMLElement?document.activeElement:null;filter.value='';
    options.open(dialog);if(!dialog.querySelector(':scope > .dialog-content'))positionDialog(dialog);
    windowDialog(dialog);
    void show(usage).catch(reason=>status.textContent=String(reason));filter.focus({preventScroll:true});
  };
  document.getElementById('settings-help')!.onclick=()=>document.getElementById('help-menu')!.click();
}
