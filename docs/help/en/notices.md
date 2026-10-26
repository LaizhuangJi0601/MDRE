# Notices and licenses

MDRE is licensed under MIT. Third-party copyright and usage terms are governed by each component's original license. This page identifies the main components, runtime tools and offline licensing materials.

## Main components

| Component | Purpose | Project |
| --- | --- | --- |
| Tauri 2 / Tauri Plugins | Desktop windows, system communication and single-instance operation | [Tauri](https://github.com/tauri-apps/tauri) · [Plugins](https://github.com/tauri-apps/plugins-workspace) |
| CodeMirror 6 / Lezer | Source editing, parsing and highlighting | [CodeMirror](https://codemirror.net/) · [Lezer](https://lezer.codemirror.net/) |
| ProseMirror | Rich-text editing and document transactions | [ProseMirror](https://prosemirror.net/) |
| markdown-it / entities | Markdown and HTML entity processing | [markdown-it](https://github.com/markdown-it/markdown-it) · [entities](https://github.com/fb55/entities) |
| KaTeX / MathLive | Equation rendering, fonts and visual editing | [KaTeX](https://github.com/KaTeX/KaTeX) · [MathLive](https://github.com/arnog/mathlive) |
| Mermaid / highlight.js | Diagrams and code highlighting | [Mermaid](https://github.com/mermaid-js/mermaid) · [highlight.js](https://github.com/highlightjs/highlight.js) |
| Serde / serde_json / Tokio | Serialization and async runtime | [Serde](https://github.com/serde-rs/serde) · [serde_json](https://github.com/serde-rs/json) · [Tokio](https://github.com/tokio-rs/tokio) |
| windows-rs / webview2-com | Windows and WebView2 interfaces | [windows-rs](https://github.com/microsoft/windows-rs) · [webview2-com](https://github.com/wravery/webview2-rs) |

## Runtime and external tools

The Windows interface and PDF output use [Microsoft Edge WebView2](https://developer.microsoft.com/microsoft-edge/webview2/). Word conversion invokes a user-installed [Pandoc](https://pandoc.org/), distributed separately from MDRE.

## Development tools

The project uses [Rust](https://github.com/rust-lang/rust), [TypeScript](https://github.com/microsoft/TypeScript), [Vite](https://github.com/vitejs/vite), [Playwright](https://github.com/microsoft/playwright), [tsx](https://github.com/privatenumber/tsx) and [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped). We acknowledge their authors, maintainers and contributors.

## Licensing materials

- [Dependency inventory](../../licenses/dependency-inventory.en.md): build-time dependencies and license information.
- [Original license and copyright texts](../../licenses/许可证文本.txt): complete offline texts, preserved in their original languages.

Development and test dependencies in the inventory are not all product runtime dependencies. In license expressions, OR permits choosing a license and AND requires compliance with both. The original terms take precedence.
