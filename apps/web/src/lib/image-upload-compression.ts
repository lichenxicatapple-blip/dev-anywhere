const IMAGE_COMPRESSION_THRESHOLD_BYTES = 2 * 1024 * 1024;
const IMAGE_COMPRESSION_MAX_EDGE = 2560;
const IMAGE_COMPRESSION_QUALITY = 0.82;
const IMAGE_COMPRESSION_MAX_SIZE_RATIO = 0.9;

const COMPRESSIBLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const COMPRESSED_IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
] as const);

interface DecodedUploadImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
}

export interface ImageUploadCompressionRuntime {
  decode: (file: File) => Promise<DecodedUploadImage>;
  encode: (
    image: DecodedUploadImage,
    width: number,
    height: number,
    mimeType: "image/jpeg" | "image/webp",
    quality: number,
  ) => Promise<Blob | null>;
}

export function shouldCompressImageForUpload(file: File): boolean {
  return file.size > IMAGE_COMPRESSION_THRESHOLD_BYTES && COMPRESSIBLE_IMAGE_TYPES.has(file.type);
}

export function fitImageWithinMaxEdge(
  width: number,
  height: number,
  maxEdge = IMAGE_COMPRESSION_MAX_EDGE,
): { width: number; height: number } {
  const longestEdge = Math.max(width, height);
  if (!Number.isFinite(longestEdge) || longestEdge <= 0) {
    throw new Error("图片尺寸无效");
  }
  const scale = Math.min(1, maxEdge / longestEdge);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function compressedFileName(name: string, mimeType: string): string {
  const extension = COMPRESSED_IMAGE_EXTENSIONS.get(
    mimeType as "image/jpeg" | "image/png" | "image/webp",
  );
  if (!extension) return name;
  const base = name.replace(/\.(?:jpe?g|png|webp)$/iu, "") || "image";
  return `${base}.${extension}`;
}

function createBrowserRuntime(): ImageUploadCompressionRuntime | null {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;

  return {
    async decode(file) {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    },
    async encode(image, width, height, mimeType, quality) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法创建图片压缩画布");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image.source, 0, 0, width, height);
      return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
    },
  };
}

export async function compressLargeImageForUpload(
  file: File,
  runtime: ImageUploadCompressionRuntime | null = createBrowserRuntime(),
): Promise<File> {
  if (!shouldCompressImageForUpload(file) || !runtime) return file;

  let image: DecodedUploadImage | null = null;
  try {
    image = await runtime.decode(file);
    const size = fitImageWithinMaxEdge(image.width, image.height);
    let encoded = await runtime.encode(
      image,
      size.width,
      size.height,
      "image/webp",
      IMAGE_COMPRESSION_QUALITY,
    );
    // Safari can decode WebP but currently returns a PNG when canvas is asked to encode WebP.
    // JPEG inputs have no alpha channel, so a JPEG quality fallback keeps the intended savings.
    if (encoded?.type !== "image/webp" && file.type === "image/jpeg") {
      encoded = await runtime.encode(
        image,
        size.width,
        size.height,
        "image/jpeg",
        IMAGE_COMPRESSION_QUALITY,
      );
    }
    if (
      !encoded ||
      !COMPRESSED_IMAGE_EXTENSIONS.has(encoded.type as "image/jpeg" | "image/png" | "image/webp") ||
      encoded.size >= file.size * IMAGE_COMPRESSION_MAX_SIZE_RATIO
    ) {
      return file;
    }
    return new File([encoded], compressedFileName(file.name, encoded.type), {
      type: encoded.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    image?.close?.();
  }
}
