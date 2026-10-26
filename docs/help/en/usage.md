# User guide

MDRE combines Markdown source editing, rich text and reading in one workspace. See the [syntax reference](syntax.md) for supported markup and [notices and licenses](notices.md) for licensing.

## Getting started

| Action | Method |
| --- | --- |
| Create or open | Welcome page or File menu. Ctrl+N creates a document; Ctrl+O opens a file. |
| Save or save as | File menu, Ctrl+S or Ctrl+Shift+S. |
| Tabs | Ctrl+Tab switches tabs, Ctrl+W closes one, and dragging reorders them. The plus button opens a welcome tab. Closing the last file returns to the welcome page. |
| Recent items | The File menu retains five recent files and folders. Opening the same path reuses its tab; identical names in different folders remain separate. |
| File association | Register the .md association in Settings to open Markdown files with a double click. |

The sidebar switches between Files, Images and Outline. Expand or refresh folders; the sidebar New button creates a file in the open folder without overwriting another file. Drag the sidebar edge to resize it and the horizontal divider to resize its file lists. Reopening the sidebar restores its selected category.

Startup restores the workspace, open files, active tab and sidebar. Named files load their latest disk contents; recovery snapshots handle unsaved text. Unavailable paths are reported and skipped.

## Editing and formatting

Source and rich text stay synchronized and share undo history. Toolbar groups cover history, fonts, colors, paragraphs, insertion and structure. Scroll the toolbar horizontally in narrow windows. Reading mode supports selection, copying, search and export, while editing commands are disabled.

| Content | Operation |
| --- | --- |
| Text and paragraphs | Select text to apply bold, italic, underline, strikethrough, size, superscript, subscript or color. Heading and paragraph commands can apply to multiple selected lines or paragraphs. |
| Color and highlight | Apply a preset or choose a palette color. Use the context menu to reset text color or clear highlights. |
| Lists and structure | Insert lists, quotes, links and rules. Block actions move, delete, convert or edit source fragments. Enter or Backspace on an empty list item exits the list. |
| Equations | Double-click an equation to edit it visually with a virtual keyboard and display-equation numbering. OK writes source; Cancel or Esc discards changes. |
| Mermaid | Insert a diagram, then double-click it or choose Edit diagram to edit its source. Delete or Backspace removes it. |
| Code blocks | Edit code directly, select a language or collapse the block. Line numbers remain fixed; blocks taller than about 20 lines scroll internally. Light and dark code themes are available. |
| HTML and metadata | Original tags and attributes are retained. Edit simple inline text directly; use source or Block actions → Edit source fragment for complex structures. |

Underline is stored as `<u>text</u>`. Text sizes accept px and em; switching units uses 16px = 1em. Pixel presets range from 8 to 24px in 2px steps.

## Tables and cells

Edit cells directly; Enter inserts a line break. The Table context menu groups structural actions, alignment and widths. Each operation is one undo step.

| Action | Method |
| --- | --- |
| Selection | Drag across cells; Ctrl/Cmd+click toggles selection and Shift+click selects a rectangle. Select entire table selects all cells. |
| Insert and delete | Manage rows and columns through the context menu. Widths and merged spans adjust together; unsafe operations leave the original intact and report the problem. |
| Column widths | Drag a border to preview and release to commit; double-click to fit contents. Commands distribute columns, fit contents or restore automatic widths. Minimum width is 4% per column; total width stays within 100%. |
| Horizontal alignment | Left, center and right are exclusive. Markdown tables apply alignment by selected columns; HTML tables apply it by cell. |
| Vertical centering | Independent of horizontal alignment. First use converts the table to HTML. |
| Merge and split | Merge rectangular selections only. Contents join in reading order with line breaks; splitting retains the contents in the top-left cell. |
| Convert to Markdown | Available for HTML tables without merged or vertically centered cells. A warning describes information loss. Widths remain; column alignment follows the first row, with mixed alignment becoming left alignment. |

Manual widths are HTML comments after the table. Merging or vertical centering converts the whole table to HTML; other readers may show source or ignore styling. HTML/PDF export retains widths, merges and alignment. Merged cells are not split across pages.

## Images and resources

Inserting, dropping or pasting an original image file references its absolute path when available. Screenshots and images without an original file are stored in the persistent image library, with an `assets` fallback. Relative paths resolve from the Markdown directory. Unsaved documents also support images.

Default image display applies to **both A4 and non-A4 views**. Fit body width fills the content width proportionally. Natural size respects the source width and shrinks oversized images. Hover for a preview, open the viewer to rotate, or resize to update source.

Images lists names and paths in reference order. Click to locate a reference; double-click its name to open the local directory. Remote URLs and data URIs have no local folder. Moving original images can break absolute references; use a shareable copy when moving or sharing a document.

## Views and reading

The view menu provides four presets; manual changes display Custom view. The last combination is restored on reopening.

| View | A4 | Source | Sidebar | Toolbar |
| --- | --- | --- | --- | --- |
| Full editing | Off | Shown | Shown | Shown |
| Focus mode | On | Hidden | Shown | Hidden |
| Immersive focus | On | Hidden | Hidden | Hidden |
| A4 view | On | Hidden | Shown | Shown |

F11 switches between Focus mode and Full editing. Sidebar and toolbar visibility are independent. Reading mode temporarily hides source and disables editing; returning to editing restores the previous source preference.

- **Non-A4 width:** the status slider ranges from 60% to 100%, initially 80% for new configurations. It remembers changes and affects screen reading only. Text defaults to justified alignment; choose justified, left, center or right under Settings → Paper & images.
- **A4 layout:** 210 × 297mm paper, continuous or paged, with independent left, center, right or justified body alignment.
- **Zoom and pages:** Ctrl+wheel in the preview zooms from 25% to 250%. Paged layout calculates paper first, then scales it. One to three pages fit per row; page numbers follow reading order.
- **Reading position:** reopening restores the reading anchor and source scroll. Visible text coordinates scrolling across continuous, paged and zoomed layouts.

Page numbers, gaps and paper decorations do not change Markdown or create undo steps. Oversized indivisible blocks and cells scroll internally.

## Saving and recovery

- **Autosave:** modified documents with a file path save every 60 seconds. Composition, recovery copies, conflicts and file operations defer saving. Save unnamed documents manually first.
- **Snapshots:** independent recovery copies protect edits after an unexpected exit and do not replace saving. Configure pre-save backups; zero disables them.
- **External changes:** clean documents reload automatically. With local edits, both versions remain available for comparison, saving a local copy or loading the external version. File lists refresh while retaining expansion state.
- **Encoding:** UTF-8, UTF-16LE/BE and GBK are supported; encoding, BOM and line endings are preserved. If text cannot be saved in the original encoding, use UTF-8.
- **Closing:** unsaved changes offer Save, Discard or Cancel. Cancel retains the workspace.

At 1MiB of UTF-8 source, preview updates become manual to keep typing responsive. Refresh or Ctrl+Shift+R updates rendering.

## Search and navigation

Ctrl+F opens Find; Ctrl+H opens Replace. Case matching, whole words and regular expressions are supported. Enter selects the next result and Shift+Enter the previous result. Replacement can be undone.

The outline follows heading hierarchy and reading position. Clicking a heading positions it near the top. Document TOCs and internal links use heading anchors; explicit IDs provide stable addresses. Go to line is available through the menu and shortcut.

## Copying and pasting

Copy as rich text (Ctrl+Shift+C) copies the selection, or the whole rendered document when nothing is selected, as both HTML and plain text. Common text formatting, lists, tables, links and images remain; page numbers and line numbers are excluded. Source-pane copying always produces Markdown.

MDRE text colors fall back to underline; highlights and sizes fall back to bold. Unsupported mappings are reported. Ctrl+V converts clipboard HTML to Markdown, falling back to plain text if conversion fails.

| Clipboard content | Handling |
| --- | --- |
| Headings, paragraphs, lists, quotes, code, links and plain tables | Convert to Markdown, including common Word headings/lists and Excel or web tables. |
| Colors, fonts, sizes, spacing and alignment | Ignore formatting Markdown cannot express and report its count. |
| Merged tables or complex cell contents | Simplify to paragraphs or text and report the change. |
| Embedded data URI images | Store in the persistent library with content-based deduplication. |
| HTTPS images | Retain URLs; offline availability depends on the source. |
| Unreadable temporary images | Skip and report the count. |

Scripts, iframes and event attributes are removed. HTML above 5MB or more than 20 images falls back to plain text. Code always pastes as plain text. Finish IME composition before pasting. One paste creates one undo step.

## Export and sharing

Export uses a content snapshot without changing source Markdown or images. It does not mark unsaved edits as saved. Word and shareable-copy actions are disabled when no document is open.

| Format | Purpose and scope |
| --- | --- |
| HTML | Embeds local images and retains equations, diagrams and common formatting for offline reading. |
| PDF | A4 pages or a vertical long page. Exceeding the print engine limit requires paged export. Desktop printing uses system WebView2. |
| Shareable copy | ZIP containing Markdown and readable local images with relative references. Remote images and data URIs are not collected; missing files are skipped and reported. |
| Word (.docx) | Local Pandoc conversion; see Word conversion below. |

Shareable copies retain existing relative paths within the document directory. Absolute image references are collected under `images/` using content hashes. The status bar reports the output path, size and warnings.

## Word conversion

Convert between `.docx` and Markdown using an external Pandoc installation. MDRE does not bundle, download or upgrade Pandoc. Word and TeX installations are unnecessary. Legacy `.doc` and TeX conversion are outside the supported scope.

### Configure Pandoc

Settings → Word conversion displays the current executable. Automatic detection checks PATH and common installation folders; showing a result does not pin the path. Selecting or entering a path overrides detection; clearing it restores automatic detection.

On Windows, specify the **full path to `pandoc.exe`**, such as `D:\Tools\Pandoc\pandoc.exe`, not its folder or extra command arguments. On macOS/Linux, specify the `pandoc` executable. Install it from the [Pandoc website](https://pandoc.org/installing.html), then use Detect Pandoc to check its path and version.

### Import and export

| Action | Method |
| --- | --- |
| Import Word | File → Import Word (.docx), then choose a new `.md` path. Existing Markdown files are never overwritten. The new document opens after conversion; the Word original stays intact. |
| Export Word | Export → Export Word (.docx). An optional reference `.docx` controls styles; leaving it empty uses Pandoc defaults. |
| Images | Import extracts embedded images to a sibling `name.assets-unique-id` folder with relative references. Keep the folder when moving or sharing. Missing images stop Word export and are reported. |
| Equations and structure | Common text, lists, code, links, plain tables and equations are supported. Equations become native Word equations and can return to Markdown. |

Complex headers/footers, sections, revisions, comments, floating objects, fields and page layouts may simplify. Colors, sizes and complex tables are not guaranteed to round-trip exactly. Review important equations, references and tables. Canceling, failure or timeout preserves the original.

## Settings and shortcuts

Settings opens a separate desktop window with remembered geometry and support for moving between displays. Categories cover Appearance & reading, Paper & images, Sidebar navigation, Editing & files, Word conversion and Keyboard shortcuts. Search finds options; the reading preview appears only in Appearance.

| Action | Effect |
| --- | --- |
| Apply | Save and keep the page open. |
| OK | Save and close. |
| Cancel or close Settings | Discard unapplied changes. |
| Reset this category | Reset only the current category; Apply or OK saves it. |
| Exit the application | After documents are handled, validate and save the settings draft, then close Settings. Invalid settings or write failures keep the window available for correction. |

Language offers Simplified Chinese and English and applies to menus, tooltips, welcome, settings and offline help. Documents, file paths and original license texts are preserved. Startup mode applies at the next launch. Animations offer System, On and Off; System follows reduced-motion preferences. Transitions use readable fades without moving the text input surface.

Help and Keyboard shortcuts use title-bar controls. Desktop auxiliary windows use native minimize, maximize, close and edge resizing. Embedded windows provide equivalent controls and resizing at all edges; minimize collapses the content, and maximize toggles the available viewport. Help has no bottom Close button. Esc closes help.

| Default shortcut | Action |
| --- | --- |
| Ctrl+S / Ctrl+Shift+S | Save / Save as |
| Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z | Undo / Redo |
| Ctrl+F / Ctrl+H | Find / Replace |
| Ctrl+Shift+V | Editing / reading mode |
| Ctrl+Shift+O | Toggle sidebar |
| Ctrl+G | Go to line |
| Ctrl+Shift+R | Refresh preview |
| Ctrl+U / Ctrl+Shift+C | Underline / Copy as rich text |
| F11 | Focus mode / Full editing |

Focus a shortcut field and press a combination; Esc restores its default. Help and equation resources work offline. External links open through the host only when clicked. Help search filters the current document; chapter navigation jumps within it.
