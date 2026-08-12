export const MAX_SCREENSHOT_BYTES = 560 * 1024;

export interface PreparedReviewScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

type DrawableImage = {
  width: number;
  height: number;
  source: CanvasImageSource;
  release: () => void;
};

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DIMENSION_STEPS = [1800, 1500, 1200, 900, 720] as const;
const QUALITY_STEPS = [0.82, 0.68, 0.54, 0.42] as const;

function canvasToWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.type === "image/webp") {
        resolve(blob);
        return;
      }
      reject(new Error("SCREENSHOT_TRANSPORT_LIMIT"));
    }, "image/webp", quality);
  });
}

async function loadDrawableImage(file: File): Promise<DrawableImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      release: () => bitmap.close(),
    };
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      source: image,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return `data:image/webp;base64,${btoa(chunks.join(""))}`;
}

export async function prepareReviewScreenshot(file: File): Promise<PreparedReviewScreenshot> {
  if (!ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase())) {
    throw new Error("SCREENSHOT_TRANSPORT_LIMIT");
  }

  let drawable: DrawableImage | undefined;
  try {
    drawable = await loadDrawableImage(file);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("SCREENSHOT_TRANSPORT_LIMIT");

    for (const maxDimension of DIMENSION_STEPS) {
      const scale = Math.min(1, maxDimension / Math.max(drawable.width, drawable.height));
      canvas.width = Math.max(1, Math.round(drawable.width * scale));
      canvas.height = Math.max(1, Math.round(drawable.height * scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(drawable.source, 0, 0, canvas.width, canvas.height);

      for (const quality of QUALITY_STEPS) {
        const blob = await canvasToWebp(canvas, quality);
        if (blob.size <= MAX_SCREENSHOT_BYTES) {
          return {
            dataUrl: await blobToDataUrl(blob),
            width: canvas.width,
            height: canvas.height,
            bytes: blob.size,
          };
        }
      }
    }
  } catch {
    throw new Error("SCREENSHOT_TRANSPORT_LIMIT");
  } finally {
    drawable?.release();
  }

  throw new Error("SCREENSHOT_TRANSPORT_LIMIT");
}
