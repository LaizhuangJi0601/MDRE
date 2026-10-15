# MDRE

## 关于MDRE

MDRE（Markdown Rendering Editor）是 Windows 本地 Markdown 编辑器，当前版本为 **0.2.1**。

支持 Markdown 源码与富文本同步编辑、数学公式可视化编辑、Mermaid 图表、代码语法高亮，以及 HTML / PDF 导出。A4 纸张模式支持连续或分页排版，以及 25%–250% 缩放；分页模式每行最多显示 3 页，并提供页码与正文对齐设置。文件列表与大纲位于可调整宽度的侧栏中，大纲内容超出可用区域时可滚动查看。启动时恢复上次打开的文件夹与未关闭的文档；最近打开的文件与文件夹各保留最多 5 项。编辑与渲染资源随程序提供，可离线使用。

版本变更见 [更新记录](CHANGELOG.md)。

界面采用按类别分组的单行工具栏，支持下划线、颜色、高亮、图片宽度和代码块主题设置。欢迎页提供新建和打开文件入口。操作方法见 [MDRE使用](docs/help/MDRE使用.md)。

从 [Releases](https://github.com/LaizhuangJi0601/MDRE/releases) 下载 Windows 版本，解压 ZIP 后运行 `mdre.exe`，或直接下载单独的 EXE。运行需要 Microsoft Edge WebView2 Runtime。

## 编译环境依赖

当前项目使用 Windows 系统接口，请在 Windows 10 / 11 x64 环境中编译。

| 依赖 | 要求 |
| --- | --- |
| [Git](https://git-scm.com/) | 用于克隆仓库。 |
| [Node.js](https://nodejs.org/) | 建议使用 24 LTS。 |
| [pnpm](https://pnpm.io/installation) | 建议使用 12.x。 |
| [Rust / Cargo](https://rustup.rs/) | 使用 stable 的 `x86_64-pc-windows-msvc` 工具链。 |
| [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) | 安装“使用 C++ 的桌面开发”工作负载，其中应包含 MSVC 和 Windows SDK。 |
| [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) | Windows 界面渲染与 PDF 导出所需运行时。 |

首次安装依赖需要联网。环境说明见 [Tauri Windows 编译依赖](https://v2.tauri.app/start/prerequisites/#windows)。

## 编译命令

在 PowerShell 中执行：

```powershell
git clone https://github.com/LaizhuangJi0601/MDRE.git
cd MDRE
pnpm install --frozen-lockfile
pnpm app:build
```

`pnpm app:build` 依次构建前端和 Rust 后端，生成 `src-tauri\target\release\mdre.exe`。

编译完成后运行：

```powershell
.\src-tauri\target\release\mdre.exe
```

## 引用与感谢

感谢以下开源项目的作者、维护者和贡献者：

| 项目 | 用途 |
| --- | --- |
| [Tauri 2](https://github.com/tauri-apps/tauri) / [Tauri Plugins](https://github.com/tauri-apps/plugins-workspace) | 桌面框架、窗口管理与单实例运行。 |
| [Rust](https://github.com/rust-lang/rust) / [TypeScript](https://github.com/microsoft/TypeScript) / [Vite](https://github.com/vitejs/vite) | 开发语言与构建工具。 |
| [CodeMirror 6](https://codemirror.net/) | Markdown 源码编辑。 |
| [ProseMirror](https://github.com/ProseMirror) | 富文本编辑与文档事务。 |
| [markdown-it](https://github.com/markdown-it/markdown-it) | Markdown 解析。 |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 数学公式渲染与导出。 |
| [MathLive](https://github.com/arnog/mathlive) | 数学公式可视化编辑。 |
| [Mermaid](https://github.com/mermaid-js/mermaid) | 图表渲染。 |
| [highlight.js](https://github.com/highlightjs/highlight.js) | 代码语法高亮。 |

第三方组件及授权说明见 [MDRE声明](docs/help/MDRE声明.md) 和 [第三方依赖清单](docs/licenses/依赖清单.md)，授权原文见 [许可证文本](docs/licenses/许可证文本.txt)。
