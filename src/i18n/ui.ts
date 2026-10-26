import {settings} from '../persistence/settings';
import {translate} from './strings';
export const t=(text:string)=>translate(text,settings().language);
const attributes=['title','aria-label','placeholder','data-tooltip','label'];
const originalText=new WeakMap<Text,{source:string;painted:string}>();
const originalAttributes=new WeakMap<Element,Map<string,{source:string;painted:string}>>();
const ownedUi=new WeakSet<Element>(),uiReferences=new Set<WeakRef<HTMLElement>>();
const attributePainters=new Map<WeakRef<HTMLElement>,(element:HTMLElement)=>void>();
const attributeReferences=new WeakMap<HTMLElement,WeakRef<HTMLElement>>();
// 节点视图显式登记自己的按钮和标签；正文及用户 HTML 不参与界面翻译。
export function markUi(element:HTMLElement){if(ownedUi.has(element))return;ownedUi.add(element);uiReferences.add(new WeakRef(element));queueMicrotask(()=>localize(element));}
export function languageAttributes(element:HTMLElement,paint:(element:HTMLElement)=>void){let ref=attributeReferences.get(element);if(!ref){ref=new WeakRef(element);attributeReferences.set(element,ref);}attributePainters.set(ref,paint);paint(element);if(attributePainters.size%64===0)for(const [key] of attributePainters){const node=key.deref();if(!node||node!==element&&!node.isConnected)attributePainters.delete(key);}}
// 只翻译应用界面。文档、路径、文件名、用户草稿与授权原文始终保持原样。
const protectedText='#source,#draft-highlight,textarea,math-field,#help-content,#help-toc,.tab-label,.file-name,.file-row,.image-row,#recent-list,#recent-folder-list,[data-tab],.outline-item,#folder-path,#status-path,#window-title,.image-manager-name,.image-manager-path,.image-name,.image-path,.help-license-text,[data-i18n-skip],script,style';
function protectedElement(element:Element){
  if(!element.matches('textarea,math-field'))for(let current:Element|null=element;current;current=current.parentElement){if(ownedUi.has(current))return false;}
  if(element.closest(protectedText))return true;
  if(element.closest('#render .ProseMirror')&&!element.closest('.code-header,.front-matter-toggle,.inline-editor-actions,.diagram-actions'))return true;
  return false;
}
export function localize(root:Node=document.body){
  if(root instanceof Text){const parent=root.parentElement;if(!parent||protectedElement(parent))return;const old=originalText.get(root),source=old?.painted===root.data?old.source:root.data,painted=t(source);originalText.set(root,{source,painted});if(root.data!==painted)root.data=painted;return;}
  if(!(root instanceof Element))return;
  const protectedRoot=protectedElement(root);
  if(protectedRoot&&!root.matches('textarea,math-field,#help-content'))return;
  let saved=originalAttributes.get(root);if(!saved){saved=new Map();originalAttributes.set(root,saved);}
  for(const key of attributes){const value=root.getAttribute(key);if(value===null)continue;const old=saved.get(key),source=old?.painted===value?old.source:value,painted=t(source);saved.set(key,{source,painted});if(value!==painted)root.setAttribute(key,painted);}
  if(!protectedRoot)for(const child of root.childNodes)localize(child);
}
export function setupLanguage(){
  const paint=()=>{document.documentElement.lang=settings().language;localize();
    for(const ref of uiReferences){const element=ref.deref();if(element?.isConnected)localize(element);else uiReferences.delete(ref);}
    for(const [ref,painter] of attributePainters){const element=ref.deref();if(element?.isConnected)painter(element);else attributePainters.delete(ref);}
  };paint();
  // 合并同一任务中的更新，不观察正文编辑，避免长文档输入时扫描正文。
  const pending=new Set<Node>();let scheduled=false;
  const observer=new MutationObserver(records=>{
    for(const record of records){const element=record.target instanceof Element?record.target:record.target.parentElement;if(!element||protectedElement(element))continue;
      if(record.type==='childList')for(const child of record.addedNodes)pending.add(child);else pending.add(record.target);
    }
    if(!pending.size||scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;const batch=[...pending];pending.clear();for(const node of batch)if(node.isConnected)localize(node);});
  });observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:attributes});
  window.addEventListener('mdre:settings-applied',paint);
}
