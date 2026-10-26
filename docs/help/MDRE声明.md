# 声明与许可

MDRE 采用 MIT 许可证。第三方组件的版权与使用条件以各自原始许可证为准；本页说明主要组件、运行环境与授权资料的位置。

## 主要组件

| 组件 | 用途 | 项目地址 |
| --- | --- | --- |
| Tauri 2／Tauri Plugins | 桌面窗口、系统通信与单实例运行 | [Tauri](https://github.com/tauri-apps/tauri) · [Plugins](https://github.com/tauri-apps/plugins-workspace) |
| CodeMirror 6／Lezer | 源码编辑、语法分析与高亮 | [CodeMirror](https://codemirror.net/) · [Lezer](https://lezer.codemirror.net/) |
| ProseMirror | 富文本编辑与文档事务 | [ProseMirror](https://prosemirror.net/) |
| markdown-it／entities | Markdown 与 HTML 实体处理 | [markdown-it](https://github.com/markdown-it/markdown-it) · [entities](https://github.com/fb55/entities) |
| KaTeX／MathLive | 公式排版、字体与可视化编辑 | [KaTeX](https://github.com/KaTeX/KaTeX) · [MathLive](https://github.com/arnog/mathlive) |
| Mermaid／highlight.js | 图表与代码高亮 | [Mermaid](https://github.com/mermaid-js/mermaid) · [highlight.js](https://github.com/highlightjs/highlight.js) |
| Serde／serde_json／Tokio | 数据序列化与异步运行 | [Serde](https://github.com/serde-rs/serde) · [serde_json](https://github.com/serde-rs/json) · [Tokio](https://github.com/tokio-rs/tokio) |
| windows-rs／webview2-com | Windows 与 WebView2 接口 | [windows-rs](https://github.com/microsoft/windows-rs) · [webview2-com](https://github.com/wravery/webview2-rs) |

## 运行环境与外部工具

Windows 界面与 PDF 输出使用 [Microsoft Edge WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)。Word 转换调用用户安装的 [Pandoc](https://pandoc.org/)，Pandoc 不随 MDRE 分发。

## 开发工具

项目使用 [Rust](https://github.com/rust-lang/rust)、[TypeScript](https://github.com/microsoft/TypeScript)、[Vite](https://github.com/vitejs/vite)、[Playwright](https://github.com/microsoft/playwright)、[tsx](https://github.com/privatenumber/tsx) 及 [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped)。感谢各项目及其依赖的作者、维护者与贡献者。

## 授权资料

- [第三方依赖清单](../licenses/依赖清单.md)：记录构建时的依赖及许可证信息。
- [许可证与版权原文](../licenses/许可证文本.txt)：随程序离线提供的授权文本。

清单中的开发、测试依赖不等同于产品运行依赖。许可证表达式中的 `OR` 表示可选择一种许可证，`AND` 表示需同时遵守；具体条款以对应原文为准。
