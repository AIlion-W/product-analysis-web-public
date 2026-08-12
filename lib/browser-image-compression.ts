import { fitMainImageFilesToUploadBudget } from "./main-image";

type ImageProgress = (completed: number, total: number) => void;

type DrawableImage = {
  height: number;
  release: () => void;
  source: CanvasImageSource;
  width: number;
};

function canvasToBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error("MAIN_IMAGE_COMPRESSION_FAILED"));
      },
      "image/webp",
      quality,
    );
  });
}

async function loadDrawableImage(file: File): Promise<DrawableImage> {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file);
    return {
      height: bitmap.height,
      release: () => bitmap.close(),
      source: bitmap,
      width: bitmap.width,
    };
  }

  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();

  return {
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
    source: image,
    width: image.naturalWidth,
  };
}

function optimizedFilename(filename: string) {
  const base = filename.replace(/\.[^.]+$/, "");
  return `${base}.webp`;
}

async function compressBrowserImage(file: File, targetBytes: number) {
  const drawable = await loadDrawableImage(file);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    drawable.release();
    throw new Error("MAIN_IMAGE_COMPRESSION_FAILED");
  }

  const dimensionSteps = [1600, 1400, 1200, 1000, 850, 720, 600, 480, 360];
  const qualitySteps = [0.82, 0.72, 0.62, 0.52, 0.42, 0.32];
  let smallestBlob: Blob | null = null;

  try {
    for (const maxDimension of dimensionSteps) {
      const scale = Math.min(
        1,
        maxDimension / Math.max(drawable.width, drawable.height),
      );
      canvas.width = Math.max(1, Math.round(drawable.width * scale));
      canvas.height = Math.max(1, Math.round(drawable.height * scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(drawable.source, 0, 0, canvas.width, canvas.height);

      for (const quality of qualitySteps) {
        const blob = await canvasToBlob(canvas, quality);
        if (!smallestBlob || blob.size < smallestBlob.size) {
          smallestBlob = blob;
        }
        if (blob.size <= targetBytes) {
          return new File([blob], optimizedFilename(file.name), {
            lastModified: file.lastModified,
            type: "image/webp",
          });
        }
      }
    }
  } finally {
    drawable.release();
  }

  if (!smallestBlob || smallestBlob.size > targetBytes) {
    throw new Error("MAIN_IMAGE_TRANSPORT_LIMIT");
  }

  return new File([smallestBlob], optimizedFilename(file.name), {
    lastModified: file.lastModified,
    type: "image/webp",
  });
}

export async function prepareMainImageUploads(
  ownFiles: File[],
  competitorFiles: File[],
  onProgress?: ImageProgress,
) {
  const allFiles = [...ownFiles, ...competitorFiles];
  let completed = 0;
  const prepared = await fitMainImageFilesToUploadBudget(
    allFiles,
    async (file, targetBytes) => {
      const output = await compressBrowserImage(file, targetBytes);
      completed += 1;
      onProgress?.(completed, allFiles.length);
      return output;
    },
  );

  return {
    competitorFiles: prepared.slice(ownFiles.length),
    ownFiles: prepared.slice(0, ownFiles.length),
  };
}
