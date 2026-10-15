# 应用与文档图标

- `icon.png` / `icon.ico`：已选定的透明 MD Logo，用于桌面程序、应用界面和插件品牌展示。
- `document.png` / `document.ico` / `document.svg`：保留原有折角纸张设计，用于 Markdown 文件关联。
- `document-preview.png`：文档图标多尺寸预览。

在项目根目录运行 `python scripts/sync_app_icon.py`，从 `design/branding/mdre-app-logo-v3-md.png` 同步两端应用 Logo。运行 `python scripts/make_icon.py` 仅生成文档图标。两项操作互不覆盖。

文件关联代码必须引用 `document.ico`。不得让关联的 Markdown 文档复用应用 Logo。
