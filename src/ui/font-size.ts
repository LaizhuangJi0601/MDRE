export const fontSizes = (unit: 'px' | 'em') => unit === 'px' ? Array.from({ length: 9 }, (_, i) => `${8 + i * 2}px`) : ['0.5em','0.625em','0.75em','0.85em','1em','1.25em','1.5em','2em'];
// em 在正文容器上以浏览器默认的 16px 为基准；切换单位不改变实际字形大小。
export const convertFontSize = (value: number, from: 'px' | 'em', to: 'px' | 'em') => from === to ? value : from === 'px' ? value / 16 : value * 16;
