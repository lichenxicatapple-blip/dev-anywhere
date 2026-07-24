export type CopyImageResult = "copied" | "not-ready" | "insecure" | "unsupported" | "failed";

export async function copyLoadedImageToClipboard(
  image: HTMLImageElement,
): Promise<CopyImageResult> {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return "not-ready";
  if (window.isSecureContext === false) return "insecure";

  const write = navigator.clipboard?.write?.bind(navigator.clipboard);
  if (!write || typeof ClipboardItem === "undefined") return "unsupported";

  try {
    const png = convertLoadedImageToPng(image);
    await write([new ClipboardItem({ "image/png": png })]);
    return "copied";
  } catch {
    return "failed";
  }
}

function convertLoadedImageToPng(image: HTMLImageElement): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");
  context.drawImage(image, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Image conversion failed"));
    }, "image/png");
  });
}
