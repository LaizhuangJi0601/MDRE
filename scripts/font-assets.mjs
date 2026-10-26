// 两个运行环境均支持 WOFF2；移除同一字体的旧 WOFF/TTF 后备副本，不减少字形。
export function modernFonts() {
  return {name:'mdre-modern-fonts',enforce:'pre',transform(code,id){
    if(id.includes('katex') && /\.css(?:\?|$)/.test(id))return code.replace(/,\s*url\([^)]*\.(?:woff|ttf)[^)]*\)\s*format\([^)]*\)/g,'');
  }};
}
