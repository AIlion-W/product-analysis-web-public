import { Inflate, strFromU8 } from "fflate";

export const MAX_XLSX_COMPRESSED_BYTES = 10 * 1024 * 1024;
export const MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
export const MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES = 60 * 1024 * 1024;
export const MAX_XLSX_COMPRESSION_RATIO = 200;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;
const INFLATE_INPUT_CHUNK_BYTES = 1024;

type ArchiveEntry = {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataStart: number;
  dataEnd: number;
};

export type ValidatedXlsxArchive = Readonly<Record<string, Uint8Array>>;

export class XlsxArchiveError extends Error {
  readonly code: "XLSX_ARCHIVE_LIMIT" | "UNSAFE_XLSX_ARCHIVE";

  constructor(code: XlsxArchiveError["code"], message: string) {
    super(message);
    this.name = "XlsxArchiveError";
    this.code = code;
  }
}

function unsafe(message: string): never {
  throw new XlsxArchiveError("UNSAFE_XLSX_ARCHIVE", message);
}

function limited(message: string): never {
  throw new XlsxArchiveError("XLSX_ARCHIVE_LIMIT", message);
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = 22;
  if (view.byteLength < minimum) unsafe("文件过短，缺少 ZIP 中央目录。");
  const lowerBound = Math.max(0, view.byteLength - MAX_EOCD_SEARCH);
  for (let offset = view.byteLength - minimum; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  unsafe("未找到 ZIP 中央目录结束记录。");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function checkedRangeEnd(start: number, length: number, limit: number, message: string): number {
  const end = start + length;
  if (!Number.isSafeInteger(end) || start < 0 || length < 0 || end > limit) unsafe(message);
  return end;
}

function parseArchiveEntries(buffer: ArrayBuffer): { bytes: Uint8Array; entries: ArchiveEntry[] } {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd + 22 > view.byteLength) unsafe("ZIP 中央目录结束记录被截断。");
  const commentLength = view.getUint16(eocd + 20, true);
  if (eocd + 22 + commentLength !== view.byteLength) unsafe("ZIP 中央目录结束位置不一致。");

  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) unsafe("不支持多磁盘 ZIP。");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) unsafe("不支持 ZIP64。");
  if (centralOffset + centralSize !== eocd || centralOffset > view.byteLength) unsafe("ZIP 中央目录范围无效。");

  const entries: ArchiveEntry[] = [];
  const names = new Set<string>();
  const localOffsets = new Set<number>();
  let cursor = centralOffset;
  let declaredTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      unsafe(`ZIP 中央目录第 ${index + 1} 项损坏。`);
    }
    const flags = view.getUint16(cursor + 8, true);
    const rawMethod = view.getUint16(cursor + 10, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const entryCommentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const nameEnd = checkedRangeEnd(nameStart, nameLength, eocd, `ZIP 中央目录第 ${index + 1} 项名称越界。`);
    const next = checkedRangeEnd(nameEnd, extraLength + entryCommentLength, eocd, `ZIP 中央目录第 ${index + 1} 项范围无效。`);
    if (diskStart !== 0 || localOffset >= centralOffset) unsafe(`ZIP 中央目录第 ${index + 1} 项范围无效。`);
    if ((flags & 0x1) !== 0) unsafe("不支持加密 XLSX。");
    if ((flags & 0x8) !== 0) unsafe("不支持使用 data descriptor 的 XLSX。");
    if (rawMethod !== 0 && rawMethod !== 8) unsafe(`ZIP entry 使用不支持的压缩方法 ${rawMethod}。`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) unsafe("不支持 ZIP64 entry。");
    if (uncompressedSize > MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES) limited(`单个 ZIP entry 展开后超过 ${MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES} bytes。`);
    declaredTotal += uncompressedSize;
    if (declaredTotal > MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES) limited(`ZIP 总展开大小超过 ${MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES} bytes。`);
    if (uncompressedSize > 0 && uncompressedSize / Math.max(compressedSize, 1) > MAX_XLSX_COMPRESSION_RATIO) {
      limited(`ZIP entry 压缩比超过 ${MAX_XLSX_COMPRESSION_RATIO}:1。`);
    }

    const centralNameBytes = bytes.subarray(nameStart, nameEnd);
    const name = strFromU8(centralNameBytes, (flags & 0x800) === 0);
    if (!name || names.has(name)) unsafe("ZIP entry 名称为空或重复。");
    names.add(name);
    if (localOffsets.has(localOffset)) unsafe("多个 ZIP entry 指向同一 local header。");
    localOffsets.add(localOffset);

    entries.push({
      name,
      nameBytes: centralNameBytes.slice(),
      flags,
      method: rawMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataStart: 0,
      dataEnd: 0,
    });
    cursor = next;
  }
  if (cursor !== eocd) unsafe("ZIP 中央目录条目数量或长度不一致。");

  for (const entry of entries) {
    if (entry.localOffset + 30 > centralOffset || view.getUint32(entry.localOffset, true) !== LOCAL_FILE_SIGNATURE) {
      unsafe(`ZIP entry「${entry.name}」的 local header 无效。`);
    }
    const localFlags = view.getUint16(entry.localOffset + 6, true);
    const localMethod = view.getUint16(entry.localOffset + 8, true);
    const localCrc32 = view.getUint32(entry.localOffset + 14, true);
    const localCompressedSize = view.getUint32(entry.localOffset + 18, true);
    const localUncompressedSize = view.getUint32(entry.localOffset + 22, true);
    const localNameLength = view.getUint16(entry.localOffset + 26, true);
    const localExtraLength = view.getUint16(entry.localOffset + 28, true);
    const localNameStart = entry.localOffset + 30;
    const localNameEnd = checkedRangeEnd(localNameStart, localNameLength, centralOffset, `ZIP entry「${entry.name}」的 local 名称越界。`);
    entry.dataStart = checkedRangeEnd(localNameEnd, localExtraLength, centralOffset, `ZIP entry「${entry.name}」的 local extra 越界。`);
    entry.dataEnd = checkedRangeEnd(entry.dataStart, entry.compressedSize, centralOffset, `ZIP entry「${entry.name}」的数据范围越过中央目录。`);
    if (
      localFlags !== entry.flags
      || localMethod !== entry.method
      || localCrc32 !== entry.crc32
      || localCompressedSize !== entry.compressedSize
      || localUncompressedSize !== entry.uncompressedSize
      || !sameBytes(bytes.subarray(localNameStart, localNameEnd), entry.nameBytes)
    ) unsafe(`ZIP entry「${entry.name}」的中央目录与 local header 不一致。`);
    if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) {
      unsafe(`stored ZIP entry「${entry.name}」的压缩与展开大小不一致。`);
    }
  }

  const spans = entries
    .map((entry) => ({ start: entry.localOffset, end: entry.dataEnd, name: entry.name }))
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index].start < spans[index - 1].end) {
      unsafe(`ZIP entry「${spans[index].name}」与其他 local entry 范围重叠。`);
    }
  }
  return { bytes, entries };
}

function concatenateChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function extractValidatedXlsxArchive(buffer: ArrayBuffer): ValidatedXlsxArchive {
  if (buffer.byteLength > MAX_XLSX_COMPRESSED_BYTES) {
    limited(`XLSX 压缩文件超过 ${MAX_XLSX_COMPRESSED_BYTES} bytes。`);
  }
  const { bytes, entries } = parseArchiveEntries(buffer);
  const archive: Record<string, Uint8Array> = {};
  let actualTotal = 0;

  for (const entry of entries) {
    const compressed = bytes.subarray(entry.dataStart, entry.dataEnd);
    const chunks: Uint8Array[] = [];
    let actualSize = 0;
    const acceptChunk = (chunk: Uint8Array) => {
      const nextEntrySize = actualSize + chunk.byteLength;
      const nextTotal = actualTotal + chunk.byteLength;
      if (nextEntrySize > MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES) {
        limited(`ZIP entry「${entry.name}」实际展开超过 ${MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES} bytes。`);
      }
      if (nextTotal > MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES) {
        limited(`ZIP 实际总展开大小超过 ${MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES} bytes。`);
      }
      if (nextEntrySize > 0 && nextEntrySize / Math.max(entry.compressedSize, 1) > MAX_XLSX_COMPRESSION_RATIO) {
        limited(`ZIP entry「${entry.name}」实际压缩比超过 ${MAX_XLSX_COMPRESSION_RATIO}:1。`);
      }
      actualSize = nextEntrySize;
      actualTotal = nextTotal;
      chunks.push(chunk.slice());
    };

    if (entry.method === 0) {
      acceptChunk(compressed);
    } else {
      let completed = false;
      const inflater = new Inflate((chunk, final) => {
        acceptChunk(chunk);
        if (final) completed = true;
      });
      try {
        if (compressed.byteLength === 0) {
          inflater.push(new Uint8Array(), true);
        } else {
          for (let offset = 0; offset < compressed.byteLength; offset += INFLATE_INPUT_CHUNK_BYTES) {
            const end = Math.min(offset + INFLATE_INPUT_CHUNK_BYTES, compressed.byteLength);
            inflater.push(compressed.subarray(offset, end), end === compressed.byteLength);
          }
        }
      } catch (error) {
        if (error instanceof XlsxArchiveError) throw error;
        unsafe(`ZIP entry「${entry.name}」无法安全解压。`);
      }
      if (!completed) unsafe(`ZIP entry「${entry.name}」解压未完整结束。`);
    }

    if (actualSize !== entry.uncompressedSize) {
      unsafe(`ZIP entry「${entry.name}」实际展开大小与声明不一致。`);
    }
    archive[entry.name] = concatenateChunks(chunks, actualSize);
  }
  return archive;
}
