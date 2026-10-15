"""仅生成文件关联的折角文档图标；应用 Logo 由 sync_app_icon.py 同步。"""
from io import BytesIO
from pathlib import Path
import struct
from PIL import Image, ImageDraw

ICONS = Path(__file__).resolve().parents[1] / 'src-tauri' / 'icons'
ICONS.mkdir(parents=True, exist_ok=True)
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]


def document_icon(size):
    scale = size * 4 / 256
    image = Image.new('RGBA', (size * 4, size * 4))
    draw = ImageDraw.Draw(image)

    def points(values):
        return [(round(x * scale), round(y * scale)) for x, y in values]

    def line(values, color, width):
        draw.line(points(values), fill=color, width=max(1, round(width * scale)), joint='curve')

    # 透明边缘、白纸和蓝色描边兼顾深浅背景及资源管理器小尺寸列表。
    page = [(42, 18), (164, 18), (214, 68), (214, 234), (42, 234), (42, 18)]
    draw.polygon(points(page), fill='#fbfdff')
    line(page, '#326eaa', 8 if size >= 24 else 12)
    draw.polygon(points([(164, 18), (164, 68), (214, 68)]), fill='#d3e9fb')
    line([(164, 20), (164, 68), (212, 68)], '#326eaa', 7)
    if size >= 24:
        line([(70, 90), (145, 90)], '#a0bdd7', 9)
        line([(70, 111), (184, 111)], '#c0d3e5', 9)
    top, bottom = (139 if size >= 24 else 103), 199
    line([(66, bottom), (66, top), (97, top + 32), (128, top), (128, bottom)], '#255d9b', 14 if size >= 24 else 18)
    line([(172, top), (172, bottom - 6)], '#079b9c', 14 if size >= 24 else 18)
    draw.polygon(points([(148, bottom - 21), (196, bottom - 21), (172, bottom + 5)]), fill='#079b9c')
    return image.resize((size, size), Image.Resampling.LANCZOS)


frames = []
for size in SIZES:
    output = BytesIO()
    document_icon(size).save(output, format='PNG')
    frames.append((size, output.getvalue()))
offset = 6 + 16 * len(frames)
directory = bytearray(struct.pack('<HHH', 0, 1, len(frames)))
for size, data in frames:
    directory.extend(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset))
    offset += len(data)
(ICONS / 'document.ico').write_bytes(directory + b''.join(data for _, data in frames))
document_icon(256).save(ICONS / 'document.png')
(ICONS / 'document.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<path d="M42 18h122l50 50v166H42Z" fill="#fbfdff" stroke="#326eaa" stroke-width="8" stroke-linejoin="round"/>
<path d="M164 18v50h50" fill="#d3e9fb" stroke="#326eaa" stroke-width="7" stroke-linejoin="round"/>
<path d="M70 90h75M70 111h114" stroke="#a0bdd7" stroke-width="9"/>
<path d="M66 199v-60l31 32 31-32v60" fill="none" stroke="#255d9b" stroke-width="14" stroke-linejoin="round"/>
<path d="M172 139v54" stroke="#079b9c" stroke-width="14"/>
<path d="m148 178 24 26 24-26Z" fill="#079b9c"/>
</svg>''', encoding='utf-8')

# 实际尺寸预览供目视验收，不只检查 256px 大图。
preview = Image.new('RGB', (520, 180), '#f5f7fa')
draw = ImageDraw.Draw(preview)
x = 15
for size in [16, 20, 24, 32, 48, 64, 128]:
    frame = document_icon(size)
    preview.paste(frame, (x, 15), frame)
    draw.text((x, 151), str(size), fill='#255d9b')
    x += size + 20
preview.save(ICONS / 'document-preview.png')
print(f'已生成 {len(frames)} 个尺寸的文档图标：{ICONS / "document.ico"}')
