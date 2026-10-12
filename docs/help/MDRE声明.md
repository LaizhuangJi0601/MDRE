# MDRE声明

MDRE **v0.1**（程序版本号 `0.1.0`）的开发与实现得益于以下开源项目。感谢各项目作者、维护者及贡献者提供的代码、工具、文档和字体资源。本页列出 v0.1 使用的项目及引用地址。

## 开源项目致谢

| 项目 | 在 MDRE 中的使用 | GitHub / 官方地址 |
| --- | --- | --- |
| Tauri 2 | 桌面应用框架、窗口管理与前后端通信。 | [Tauri](https://github.com/tauri-apps/tauri) |
| Tauri Plugins | 单实例运行与文件打开转发。 | [Tauri Plugins](https://github.com/tauri-apps/plugins-workspace) |
| CodeMirror 6 | Markdown 源码编辑、选区与编辑辅助。 | [CodeMirror](https://codemirror.net/) |
| ProseMirror | 渲染栏富文本编辑、文档模型与编辑事务。 | [ProseMirror](https://prosemirror.net/) |
| markdown-it | Markdown 解析与语法扩展基础。 | [markdown-it](https://github.com/markdown-it/markdown-it) |
| KaTeX | 公式预览、导出排版及相关字体资源。 | [KaTeX](https://github.com/KaTeX/KaTeX) |
| MathLive | 公式可视化编辑、虚拟键盘与符号输入。 | [MathLive](https://github.com/arnog/mathlive) |
| Mermaid | 图表解析与渲染。 | [Mermaid](https://github.com/mermaid-js/mermaid) |
| highlight.js | 代码语法高亮。 | [highlight.js](https://github.com/highlightjs/highlight.js) |
| Lezer | 编辑器语法分析与高亮基础。 | [Lezer](https://lezer.codemirror.net/) |
| entities | HTML 实体解析与编码。 | [entities](https://github.com/fb55/entities) |
| Serde / serde_json | 后端数据序列化与 JSON 处理。 | [Serde](https://github.com/serde-rs/serde)、[serde_json](https://github.com/serde-rs/json) |
| Tokio | 后端异步运行与同步工具。 | [Tokio](https://github.com/tokio-rs/tokio) |
| windows-rs | Windows 系统 API 接口。 | [windows-rs](https://github.com/microsoft/windows-rs) |
| webview2-com | WebView2 接口与 PDF 输出支持。 | [webview2-com](https://github.com/wravery/webview2-rs) |

## 开发语言与工具致谢

| 项目 | 在 MDRE 中的使用 | GitHub / 官方地址 |
| --- | --- | --- |
| Rust | 桌面后端开发语言、编译器与标准库。 | [Rust](https://github.com/rust-lang/rust) |
| TypeScript | 前端开发语言与类型检查。 | [TypeScript](https://github.com/microsoft/TypeScript) |
| Vite | 前端开发与构建。 | [Vite](https://github.com/vitejs/vite) |
| Playwright | 界面自动化验证。 | [Playwright](https://github.com/microsoft/playwright) |
| tsx | TypeScript 脚本与测试运行。 | [tsx](https://github.com/privatenumber/tsx) |
| DefinitelyTyped | Node.js、markdown-it 等项目的类型声明。 | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |

## 相关依赖与资源

也感谢上述项目所依赖的其他开源组件及其贡献者。完整项目引用见 [第三方依赖清单](../licenses/依赖清单.md)，随包版权与授权文本见 [许可证与版权原文](../licenses/许可证文本.txt)。

MDRE 的 Windows 渲染环境使用 Microsoft Edge WebView2，感谢其提供的运行时与开发接口：[WebView2 官方地址](https://developer.microsoft.com/microsoft-edge/webview2/)。
