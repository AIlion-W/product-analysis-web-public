export type MainImageFile = {
  name: string;
  size: number;
  type: string;
};

export type MainImageValidation =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };

export const MAX_MAIN_IMAGE_FILES = 5;
export const MAX_MAIN_IMAGE_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_MAIN_IMAGE_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_MAIN_IMAGE_UPLOAD_BYTES = 850 * 1024;

export type MainImageUploadPlan = {
  maxUploadBytes: number;
  needsCompression: boolean;
  targetBytesPerFile: number;
  totalSourceBytes: number;
};

const SUPPORTED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

function isSupportedImage(file: MainImageFile) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return (
    file.type.startsWith("image/") &&
    SUPPORTED_IMAGE_EXTENSIONS.has(extension)
  );
}

export function createMainImageUploadPlan(
  files: MainImageFile[],
): MainImageUploadPlan {
  const totalSourceBytes = files.reduce((sum, file) => sum + file.size, 0);
  const targetBytesPerFile = files.length
    ? Math.floor(MAX_MAIN_IMAGE_UPLOAD_BYTES / files.length)
    : MAX_MAIN_IMAGE_UPLOAD_BYTES;

  return {
    maxUploadBytes: MAX_MAIN_IMAGE_UPLOAD_BYTES,
    needsCompression: totalSourceBytes > MAX_MAIN_IMAGE_UPLOAD_BYTES,
    targetBytesPerFile,
    totalSourceBytes,
  };
}

export async function fitMainImageFilesToUploadBudget<T extends MainImageFile>(
  files: T[],
  compressFile: (file: T, targetBytes: number) => Promise<T>,
): Promise<T[]> {
  const plan = createMainImageUploadPlan(files);
  if (!plan.needsCompression) return files;

  const preparedFiles: T[] = [];
  for (const file of files) {
    preparedFiles.push(
      file.size <= plan.targetBytesPerFile
        ? file
        : await compressFile(file, plan.targetBytesPerFile),
    );
  }
  const preparedBytes = preparedFiles.reduce(
    (sum, file) => sum + file.size,
    0,
  );

  if (preparedBytes > plan.maxUploadBytes) {
    throw new Error("MAIN_IMAGE_TRANSPORT_LIMIT");
  }

  return preparedFiles;
}

export function validateMainImageFiles(
  ownFiles: MainImageFile[],
  competitorFiles: MainImageFile[],
): MainImageValidation {
  if (!ownFiles.length) {
    return { ok: false, error: "请上传我方主副图。" };
  }

  if (!competitorFiles.length) {
    return { ok: false, error: "请上传竞品主副图。" };
  }

  if (ownFiles.length > MAX_MAIN_IMAGE_FILES) {
    return {
      ok: false,
      error: `我方主副图最多上传 ${MAX_MAIN_IMAGE_FILES} 张。`,
    };
  }

  if (competitorFiles.length > MAX_MAIN_IMAGE_FILES) {
    return {
      ok: false,
      error: `竞品主副图最多上传 ${MAX_MAIN_IMAGE_FILES} 张。`,
    };
  }

  const unsupportedFile = [...ownFiles, ...competitorFiles].find(
    (file) => !isSupportedImage(file),
  );
  if (unsupportedFile) {
    return {
      ok: false,
      error: `「${unsupportedFile.name}」不是支持的图片格式，请上传 JPG、PNG 或 WebP。`,
    };
  }

  const oversizedFile = [...ownFiles, ...competitorFiles].find(
    (file) => file.size > MAX_MAIN_IMAGE_FILE_BYTES,
  );
  if (oversizedFile) {
    return {
      ok: false,
      error: `「${oversizedFile.name}」超过 12MB，请压缩后重新上传。`,
    };
  }

  const totalBytes = [...ownFiles, ...competitorFiles].reduce(
    (sum, file) => sum + file.size,
    0,
  );
  if (totalBytes > MAX_MAIN_IMAGE_TOTAL_BYTES) {
    return {
      ok: false,
      error: "双方图片总大小超过 40MB，请压缩后重新上传。",
    };
  }

  return { ok: true };
}
