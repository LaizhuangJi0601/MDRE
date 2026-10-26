<p align="center"><img src="src-tauri/icons/icon.png" alt="MDRE" width="104"></p>

<h1 align="center">MDRE</h1>

<p align="center"><strong>One Markdown document. Two ways to edit.</strong><br>A Windows workspace for Markdown editing, layout, and reading.<br><sub>Windows 10 / 11 · x64 · English / 简体中文</sub></p>

<p align="center">
  <a href="https://github.com/LaizhuangJi0601/MDRE/blob/main/CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.6-2878d5" alt="Version 0.2.6"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-5b8c70" alt="MIT license"></a>
  <a href="https://developer.microsoft.com/microsoft-edge/webview2/"><img src="https://img.shields.io/badge/platform-Windows_x64-667085" alt="Windows 10 / 11 · x64"></a>
</p>

<p align="center"><a href="#features">Features</a> · <a href="#download-and-installation">Download and installation</a> · <a href="#development">Development</a> · <a href="#contributing">Contributing</a> · <a href="#license">License</a></p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

## Screenshot

![MDRE with synchronized Markdown source and rich-text views](docs/assets/editor.png)

## Features

- **Edit source and rich text together.** Keep both panes synchronized, or work in rich text alone. Format headings, lists, links, and text through the toolbar and context menus.
- **Write equations, diagrams, and code.** Render math with KaTeX, edit equations visually with MathLive, and use Mermaid diagrams, syntax highlighting, and code block themes.
- **Choose a reading layout.** Use continuous or paged A4 views with 25%–250% zoom. Outside A4, adjust reading width from 60% to 100% and choose one of four text alignments.
- **Work with tables and images.** Resize columns, align or merge cells, and split merged cells. Browse image references in document order and jump to their locations.
- **Export and exchange content.** Export HTML, PDF, or a ZIP containing Markdown and local images. Copy rich text and convert pasted HTML into Markdown.
- **Convert Word documents.** Import and export `.docx` through a separately installed Pandoc, including common document structures and equations.
- **Set up your workspace.** Choose light or dark themes, English or Simplified Chinese, view presets, categorized settings, and searchable offline help with chapter navigation.

The desktop workspace includes files, tabs, and recent items, with autosave, recovery snapshots, external file change detection, and remembered reading positions.

Editing and preview run locally. Editor resources, equation fonts, and help are bundled; remote images and external links depend on network access. See the [user guide](docs/help/en/usage.md) and [syntax reference](docs/help/en/syntax.md) for supported behavior.

## Download and installation

Current build: **0.2.6 · updata2**. See the [changelog](CHANGELOG.md) for version notes.

| Edition | Download | Requirements |
| --- | --- | --- |
| Windows desktop | [Download mdre.exe](https://github.com/LaizhuangJi0601/MDRE/raw/refs/heads/main/mdre.exe) · [SHA-256](SHA256SUMS.txt) | Windows 10 / 11 · x64 |

Download and run `mdre.exe`. Windows requires the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). Use the welcome page to create a document or open an existing Markdown file.

Preferences, stored images, and recovery data are kept in your user application-data directory. Open Settings to choose a language, theme, default view, and keyboard shortcuts.

Word conversion is optional. Install [Pandoc](https://pandoc.org/installing.html), then use Settings → Word conversion to detect it or select its executable. On Windows, specify the full path to **`pandoc.exe`**, not its folder. Complex Word layouts may simplify; review important converted documents.

Looking for the other edition? See the [VS Code extension](https://github.com/LaizhuangJi0601/MDRE-for-VS-Code).

## Development

Build on Windows 10/11 x64 with Node.js 24 LTS, pnpm 12.x, Rust stable for MSVC, and Visual Studio Build Tools with Desktop development with C++ and the Windows SDK. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows).

```powershell
git clone https://github.com/LaizhuangJi0601/MDRE.git
cd MDRE
pnpm install --frozen-lockfile
pnpm app:build
```

Run `src-tauri/target/release/mdre.exe` after the build. Use `pnpm dev` for the frontend development server and `pnpm app` for the desktop development instance.

## Contributing

Bug reports, suggestions, and pull requests are welcome. Use [Issues](https://github.com/LaizhuangJi0601/MDRE/issues) with the app version, reproduction steps, and a small Markdown example; include a screenshot for visual issues. Keep the English and Chinese documentation aligned when changing user-facing behavior.

## License

MDRE is released under the [MIT License](LICENSE). It builds on projects including [Tauri](https://tauri.app/), [CodeMirror](https://codemirror.net/), [ProseMirror](https://prosemirror.net/), [markdown-it](https://github.com/markdown-it/markdown-it), [KaTeX](https://katex.org/), [MathLive](https://mathlive.io/), [Mermaid](https://mermaid.js.org/), and [highlight.js](https://highlightjs.org/).

Third-party copyright and usage terms remain governed by their original licenses. See [notices and licenses](docs/help/en/notices.md).
