// MDRE 0.2.5：可分享副本用到的字节工具（base64、内容哈希、图片类型嗅探）。

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replace(/[\s]/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch { return null; }
}

/** read_binary / read_image 返回 `data:image/...;base64,...`；只接受 base64 data URL。 */
export function dataUrlToBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  const match = /^data:[^,]*?;base64,([\s\S]+)$/i.exec(value.trim());
  return match ? base64ToBytes(match[1]) : null;
}

function toHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

// 快速兜底哈希：两路 FNV-1a 32 位拼成 16 位十六进制，仅在 crypto.subtle 不可用时使用。
function fallbackHash(bytes: Uint8Array): string {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ (byte + index), 0x85ebca6b) >>> 0;
  }
  first = Math.imul(first ^ bytes.length, 0x01000193) >>> 0;
  second = Math.imul(second ^ (bytes.length >>> 0), 0xc2b2ae35) >>> 0;
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

/** 内容哈希（16 位十六进制）；用于把绝对路径/全局图片库图片命名进 images/。 */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
      return toHex(new Uint8Array(digest).subarray(0, 8));
    }
  } catch { /* 非安全上下文退回快速哈希。 */ }
  return fallbackHash(bytes);
}

/** 按文件头嗅探图片扩展名，供没有扩展名的图片兜底命名。 */
export function sniffImageExtension(bytes: Uint8Array): string {
  const starts = (signature: number[]) => signature.length <= bytes.length && signature.every((value, index) => bytes[index] === value);
  if (starts([0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (starts([0xff, 0xd8, 0xff])) return 'jpg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (starts([0x42, 0x4d])) return 'bmp';
  if (bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  if (/^\s*<(?:\?xml|svg)/i.test(new TextDecoder().decode(bytes.subarray(0, 256)))) return 'svg';
  return 'png';
}
