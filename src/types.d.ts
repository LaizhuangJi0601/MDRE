// 构建期以字符串内联 KaTeX 样式，导出时统一内嵌字体（见 src/render/katex.ts）。
declare module 'katex/dist/katex.min.css?raw' {
  const content: string;
  export default content;
}
