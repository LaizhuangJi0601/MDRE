import type {HLJSApi} from 'highlight.js';
let engine:HLJSApi|undefined,loading:Promise<HLJSApi>|undefined;
const escape=(text:string)=>text.replace(/[&<>]/g,char=>char==='&'?'&amp;':char==='<'?'&lt;':'&gt;');
// 欢迎页不加载全部语言规则；首次代码块使用时加载完整语言集，保留原有语言支持。
export function loadHighlighter(){return loading??=import('highlight.js').then(module=>{engine=module.default;window.dispatchEvent(new Event('mdre:highlight-ready'));return engine;});}
export default {
  getLanguage(language:string){if(engine)return engine.getLanguage(language);if(!language||language==='text')return undefined;void loadHighlighter().catch(console.error);return true;},
  highlight(text:string,options:{language:string}){return engine?.getLanguage(options.language)?engine.highlight(text,options):{value:escape(text)};},
};
