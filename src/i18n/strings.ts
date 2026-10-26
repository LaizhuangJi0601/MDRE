import dictionary from './zh-en.json';
export type Language='zh-CN'|'en';
const entries=Object.entries(dictionary).sort((a,b)=>b[0].length-a[0].length);
const escaped=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const pattern=new RegExp(entries.map(([source])=>escaped(source)).join('|'),'g');
export function translate(text:string,language:Language|string='zh-CN'):string {
  if(language!=='en'||!/[\u3400-\u9fff]/.test(text))return text;
  text=text.replace(/第\s*(\d+)\s*\/\s*(\d+)\s*页/g,'Page $1 / $2').replace(/行\s*(\d+)，列\s*(\d+)/g,'Ln $1, Col $2').replace(/(\d+)\s*字符\s*·\s*(\d+)\s*词/g,'$1 characters · $2 words').replace(/(\d+)\s*项匹配/g,'$1 matches');
  const source=text.trim(),exact=(dictionary as Record<string,string>)[source];
  if(exact)return text.replace(source,exact);
  const protectedValues:string[]=[];
  const protect=(value:string)=>{const index=protectedValues.push(value)-1;return `\uE000${index}\uE001`;};
  // 模板中的路径与引号内文件名是用户数据，不能按界面词条替换。
  text=text.replace(/《([^》]+)》/g,(_,value:string)=>`《${protect(value)}》`)
    .replace(/(?:[A-Za-z]:[\\/]|file:\/\/\/|https?:\/\/)[^\n<>"'；]+/g,protect);
  return text.replace(pattern,part=>(dictionary as Record<string,string>)[part])
    .replace(/第\s*(\d+)\s*\/\s*(\d+)\s*页/g,'Page $1 / $2')
    .replace(/行\s*(\d+)，列\s*(\d+)/g,'Ln $1, Col $2')
    .replace(/(\d+)\s*项匹配/g,'$1 matches')
    .replace(/\uE000(\d+)\uE001/g,(_,index:string)=>protectedValues[Number(index)]);
}
