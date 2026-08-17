const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** General purpose bit 11: entry names are UTF-8. */
const ZIP_UTF8_NAME_FLAG = 0x800;
const MAX_ZIP_ENTRIES = 120;
const MAX_ZIP_ENTRY_BYTES = 15 * 1024 * 1024;
const MAX_ZIP_EXPANDED_BYTES = 60 * 1024 * 1024;

const GENERIC_COMPETITOR_FOLDERS = [
  /^竞品$/,
  /^竞品资料$/,
  /^竞品分析$/,
  /^多竞品$/,
  /^多竞品资料$/,
  /^待分析资料$/,
  /^competitors?$/i,
  /^competition$/i,
  /^uploads?$/i,
];

const CONTENT_FOLDER_PATTERN =
  /^(主图|副图|主副图|详情页|评价区|评论区|买家秀|营销文案|视觉|页面框架|图片|文档|素材|images?|documents?|detail|reviews?)$/i;
const GENERIC_FILENAME_PREFIX =
  /^(页面|图片|主图|副图|详情|评价|评论|买家秀|截图|文件|素材|image|img|page|screen)/i;

export type CompetitorUploadEntry = {
  id: string;
  path: string;
  source: string;
  size: number;
  detectedGroup: string | null;
};

export type CompetitorGroup = {
  name: string;
  entries: CompetitorUploadEntry[];
  imageCount: number;
  documentCount: number;
  spreadsheetCount: number;
  otherCount: number;
};

export type CompetitorRecognition = {
  groups: CompetitorGroup[];
  unclassified: CompetitorUploadEntry[];
  totalEntries: number;
};

function normalizePath(path: string) {
  return path
    .normalize("NFKC")
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
}

function isGenericCompetitorFolder(value: string) {
  return GENERIC_COMPETITOR_FOLDERS.some((pattern) => pattern.test(value));
}

function cleanGroupName(value: string) {
  return value.replace(/^\d+[_\-\s]*/, "").trim().slice(0, 40);
}

function isUsableGroupName(value: string | undefined) {
  if (!value) return false;
  return (
    !isGenericCompetitorFolder(value) &&
    !CONTENT_FOLDER_PATTERN.test(value) &&
    !value.startsWith(".")
  );
}

export function inferCompetitorName(path: string) {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return null;

  const filename = parts.at(-1) ?? "";
  const directories = parts.slice(0, -1);
  const genericFolderIndex = directories.findIndex((part) =>
    isGenericCompetitorFolder(part),
  );

  if (genericFolderIndex >= 0) {
    const candidate = directories[genericFolderIndex + 1];
    if (isUsableGroupName(candidate)) return cleanGroupName(candidate);
  }

  if (directories.length === 1 && isUsableGroupName(directories[0])) {
    return cleanGroupName(directories[0]);
  }

  if (directories.length >= 2) {
    const candidate = directories[1];
    if (isUsableGroupName(candidate)) return cleanGroupName(candidate);
    if (isUsableGroupName(directories[0])) {
      return cleanGroupName(directories[0]);
    }
  }

  const stem = filename.replace(/\.[^.]+$/, "");
  const prefix = stem.split(/[_\-\s]+/)[0]?.trim();
  if (
    prefix &&
    prefix.length >= 2 &&
    prefix.length <= 24 &&
    !GENERIC_FILENAME_PREFIX.test(prefix)
  ) {
    return cleanGroupName(prefix);
  }

  return null;
}

export function createCompetitorEntry({
  id,
  path,
  source,
  size = 0,
}: {
  id?: string;
  path: string;
  source?: string;
  size?: number;
}): CompetitorUploadEntry {
  const normalizedPath = normalizePath(path);
  return {
    id: id ?? `${source ?? "upload"}:${normalizedPath}`,
    path: normalizedPath,
    source: source ?? "直接上传",
    size,
    detectedGroup: inferCompetitorName(normalizedPath),
  };
}

function countFileTypes(entries: CompetitorUploadEntry[]) {
  const counts = {
    imageCount: 0,
    documentCount: 0,
    spreadsheetCount: 0,
    otherCount: 0,
  };

  for (const entry of entries) {
    const extension = entry.path.split(".").pop()?.toLowerCase() ?? "";
    if (["jpg", "jpeg", "png", "gif", "webp"].includes(extension)) {
      counts.imageCount += 1;
    } else if (["pdf", "doc", "docx", "ppt", "pptx", "txt", "md"].includes(extension)) {
      counts.documentCount += 1;
    } else if (["xls", "xlsx", "csv"].includes(extension)) {
      counts.spreadsheetCount += 1;
    } else {
      counts.otherCount += 1;
    }
  }

  return counts;
}

export function buildCompetitorRecognition(
  entries: CompetitorUploadEntry[],
  assignments: Record<string, string> = {},
  additionalGroupNames: string[] = [],
): CompetitorRecognition {
  const groupOrder: string[] = [];
  const grouped = new Map<string, CompetitorUploadEntry[]>();
  const unclassified: CompetitorUploadEntry[] = [];

  const ensureGroup = (name: string) => {
    const cleaned = cleanGroupName(name);
    if (!cleaned || grouped.has(cleaned)) return cleaned;
    grouped.set(cleaned, []);
    groupOrder.push(cleaned);
    return cleaned;
  };

  additionalGroupNames.forEach(ensureGroup);

  for (const entry of entries) {
    const assignment = assignments[entry.id]?.trim();
    const groupName = assignment || entry.detectedGroup;
    if (!groupName) {
      unclassified.push(entry);
      continue;
    }
    const cleaned = ensureGroup(groupName);
    grouped.get(cleaned)?.push(entry);
  }

  return {
    groups: groupOrder.map((name) => {
      const groupEntries = grouped.get(name) ?? [];
      return {
        name,
        entries: groupEntries,
        ...countFileTypes(groupEntries),
      };
    }),
    unclassified,
    totalEntries: entries.length,
  };
}

export function buildCompetitorManifest(recognition: CompetitorRecognition) {
  return {
    groups: recognition.groups
      .filter((group) => group.entries.length > 0)
      .map((group) => ({
        name: group.name,
        files: group.entries.map((entry) => entry.path),
      })),
    unclassified: recognition.unclassified.map((entry) => entry.path),
  };
}

/**
 * Decodes a ZIP entry name. Windows 简体中文 built-in compression stores names in
 * GBK and leaves the UTF-8 flag clear, so decoding everything as UTF-8 turns
 * competitor folder names into replacement characters and breaks grouping.
 */
function createArchiveNameDecoder() {
  const utf8 = new TextDecoder("utf-8");
  const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
  let legacy: TextDecoder | null | undefined;

  return (nameBytes: Uint8Array, flags: number): string => {
    if (flags & ZIP_UTF8_NAME_FLAG) return utf8.decode(nameBytes);
    // Many tools write UTF-8 names without setting the flag, so try UTF-8 first
    // and only fall back to GBK when the bytes are not valid UTF-8.
    try {
      return strictUtf8.decode(nameBytes);
    } catch {
      if (legacy === undefined) {
        try {
          legacy = new TextDecoder("gbk");
        } catch {
          legacy = null;
        }
      }
      return legacy ? legacy.decode(nameBytes) : utf8.decode(nameBytes);
    }
  };
}

export function listZipCompetitorEntries(
  bytes: Uint8Array,
  archiveName: string,
) {
  if (bytes.length < 22) throw new Error("ZIP_INVALID");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.length - 65557);
  let endOffset = -1;

  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      endOffset = offset;
      break;
    }
  }

  if (endOffset < 0) throw new Error("ZIP_INVALID");

  const entryCount = view.getUint16(endOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);
  if (
    entryCount === 0xffff ||
    centralDirectoryOffset === 0xffffffff ||
    entryCount > MAX_ZIP_ENTRIES
  ) {
    throw new Error("ZIP_LIMIT");
  }

  const decodeArchiveName = createArchiveNameDecoder();
  const entries: CompetitorUploadEntry[] = [];
  let cursor = centralDirectoryOffset;
  let expandedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > bytes.length ||
      view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY_HEADER
    ) {
      throw new Error("ZIP_INVALID");
    }

    const flags = view.getUint16(cursor + 8, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;

    if (nameEnd > bytes.length) throw new Error("ZIP_INVALID");
    if (flags & 0x1) throw new Error("ZIP_ENCRYPTED");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("ZIP_LIMIT");
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw new Error("ZIP_ENTRY_LIMIT");
    }

    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_ZIP_EXPANDED_BYTES) {
      throw new Error("ZIP_EXPANDED_LIMIT");
    }

    const rawName = decodeArchiveName(bytes.subarray(nameStart, nameEnd), flags);
    const name = normalizePath(rawName);
    if (
      name &&
      !rawName.replaceAll("\\", "/").endsWith("/") &&
      !name.startsWith("__MACOSX/") &&
      !name.endsWith("/.DS_Store") &&
      name !== ".DS_Store"
    ) {
      entries.push(
        createCompetitorEntry({
          id: `${archiveName}:${name}`,
          path: name,
          source: archiveName,
          size: uncompressedSize,
        }),
      );
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
