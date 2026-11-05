// mammoth 只发布 Node 入口的类型；浏览器构建是 UMD bundle，这里声明本模块用到的最小接口。
// 该文件不参与运行时，仅用于 `tsc --noEmit` 类型检查。
declare module 'mammoth/mammoth.browser.min.js' {
  export interface MammothMessage {
    type: string;
    message: string;
  }

  export interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }

  export interface MammothImage {
    readonly contentType: string;
    readAsBase64String(): Promise<string>;
    read(encoding?: string): Promise<string>;
    readAsArrayBuffer(): Promise<ArrayBuffer>;
  }

  export interface Mammoth {
    convertToHtml(input: { arrayBuffer: ArrayBuffer }, options?: Record<string, unknown>): Promise<MammothResult>;
    images: {
      inline(convert: (image: MammothImage) => { src: string } | Promise<{ src: string }>): Record<string, unknown>;
    };
  }

  const mammoth: Mammoth;
  export default mammoth;
}
