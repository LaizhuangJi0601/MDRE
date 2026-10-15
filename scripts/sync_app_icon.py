"""将已选定的 MD Logo 转为桌面与插件图标；不修改文档关联图标。"""
from io import BytesIO
from pathlib import Path
import shutil
import struct

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'design' / 'branding' / 'mdre-app-logo-v3-md.png'
DESKTOP = ROOT / 'src-tauri' / 'icons'
EXTENSION = ROOT / 'VscodeExtension' / 'media'
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]


def main():
    with Image.open(SOURCE) as original:
        logo = original.convert('RGBA')
    if logo.width != logo.height:
        raise ValueError('应用 Logo 必须使用正方形透明 PNG。')
    if logo.getextrema()[3][0] != 0:
        raise ValueError('应用 Logo 必须保留透明背景。')
    DESKTOP.mkdir(parents=True, exist_ok=True)
    # 只做格式转换与尺寸适配，保留选定设计的形状、颜色和透明通道。
    logo.resize((512, 512), Image.Resampling.LANCZOS).save(DESKTOP / 'icon.png')
    frames = []
    for size in SIZES:
        output = BytesIO()
        logo.resize((size, size), Image.Resampling.LANCZOS).save(output, format='PNG')
        frames.append((size, output.getvalue()))
    offset = 6 + 16 * len(frames)
    directory = bytearray(struct.pack('<HHH', 0, 1, len(frames)))
    for size, data in frames:
        directory.extend(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    (DESKTOP / 'icon.ico').write_bytes(directory + b''.join(data for _, data in frames))
    # 独立桌面仓库不包含插件目录；只在双端工作区中同步插件资源。
    if (ROOT / 'VscodeExtension' / 'package.json').is_file():
        EXTENSION.mkdir(parents=True, exist_ok=True)
        for name in ['icon.png', 'icon.ico']:
            shutil.copyfile(DESKTOP / name, EXTENSION / name)
    print(f'应用图标已生成，ICO 包含 {len(frames)} 个尺寸。文档图标未改动。')


if __name__ == '__main__':
    main()
