// MDRE 0.2.5：纯 TypeScript ZIP 写入（可分享副本用）。
// 优先 CompressionStream('deflate-raw') 压缩，不可用或压缩收益为负时使用 store（不压缩）。
// 文件名为 UTF-8 并置通用位 11；中央目录、CRC32 与本地头按 ZIP 规范写入。

export type ZipEntry = { name: string; data: Uint8Array };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

let compressionSupport: boolean | null = null;

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (compressionSupport === false) return null;
  if (bytes.length < 32) return null;
  try {
    const Constructor = (globalThis as unknown as { CompressionStream?: typeof CompressionStream }).CompressionStream;
    if (typeof Constructor !== 'function') { compressionSupport = false; return null; }
    const stream = new Constructor('deflate-raw');
    // 先开始读取可读端再写入：某些 Chromium 版本在无人读取时 write() 会因背压一直挂起。
    const read = new Response(stream.readable).arrayBuffer();
    const writer = stream.writable.getWriter();
    try {
      await writer.write(bytes as unknown as BufferSource);
      await writer.close();
    } catch (reason) {
      await writer.abort().catch(() => {});
      throw reason;
    }
    const buffer = await read;
    const compressed = new Uint8Array(buffer);
    compressionSupport = true;
    return compressed.length < bytes.length ? compressed : null;
  } catch {
    compressionSupport = false;
    return null;
  }
}

function sanitizeEntryName(name: string): string | null {
  const normalized = name.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\u0000')) return null;
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

function dosTimeDate(now = new Date()): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, now.getFullYear()));
  return {
    time: ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((Math.floor(now.getSeconds() / 2)) & 31),
    date: ((year - 1980) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31),
  };
}

type PreparedEntry = { name: Uint8Array; payload: Uint8Array; method: number; crc: number; size: number; offset: number };

/** 生成完整 zip 字节。同名条目只保留第一个；非法路径（绝对路径、含 `..`）跳过。 */
export async function buildZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const prepared: PreparedEntry[] = [];
  const names = new Set<string>();
  for (const entry of entries) {
    const name = sanitizeEntryName(entry.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (names.has(key)) continue;
    names.add(key);
    if (!(entry.data instanceof Uint8Array)) continue;
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 0xffff) throw new Error('可分享副本中的文件名过长。');
    if (entry.data.length > 0xffffffff) throw new Error('可分享副本中的单个文件超过 4 GB。');
    const compressed = await deflateRaw(entry.data);
    prepared.push({
      name: nameBytes,
      payload: compressed ?? entry.data,
      method: compressed ? 8 : 0,
      crc: crc32(entry.data),
      size: entry.data.length,
      offset: 0,
    });
  }
  const { time, date } = dosTimeDate();
  let localSize = 0;
  for (const item of prepared) {
    item.offset = localSize;
    localSize += 30 + item.name.length + item.payload.length;
  }
  const centralSize = prepared.reduce((total, item) => total + 46 + item.name.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let cursor = 0;
  const u16 = (value: number) => { view.setUint16(cursor, value, true); cursor += 2; };
  const u32 = (value: number) => { view.setUint32(cursor, value >>> 0, true); cursor += 4; };
  const raw = (value: Uint8Array) => { output.set(value, cursor); cursor += value.length; };
  const flags = 0x0800; // 通用位 11：UTF-8 文件名。
  for (const item of prepared) {
    u32(0x04034b50); u16(20); u16(flags); u16(item.method); u16(time); u16(date);
    u32(item.crc); u32(item.payload.length); u32(item.size); u16(item.name.length); u16(0);
    raw(item.name); raw(item.payload);
  }
  const centralOffset = cursor;
  for (const item of prepared) {
    u32(0x02014b50); u16(20); u16(20); u16(flags); u16(item.method); u16(time); u16(date);
    u32(item.crc); u32(item.payload.length); u32(item.size); u16(item.name.length);
    u16(0); u16(0); u16(0); u16(0); u32(0); u32(item.offset); raw(item.name);
  }
  const centralEnd = cursor;
  u32(0x06054b50); u16(0); u16(0); u16(prepared.length); u16(prepared.length);
  u32(centralEnd - centralOffset); u32(centralOffset); u16(0);
  if (cursor !== output.length) throw new Error('可分享副本 zip 结构写入长度不一致。');
  return output;
}
