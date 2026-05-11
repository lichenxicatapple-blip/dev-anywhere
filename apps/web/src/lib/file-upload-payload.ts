// 任意文件 → base64 payload, 与 file_upload_request schema 对齐。size cap 100MB 与 proxy 对齐。
// 大文件 base64 会让消息膨胀 ~33%, 但当前 IPC 链路接受 (proxy 那边 schema 也是 base64 string)。

const MAX_FILE_UPLOAD_BYTES = 100 * 1024 * 1024;

export type FileUploadPayload = {
  fileName: string;
  mimeType: string;
  dataBase64: string;
};

export async function fileToUploadPayload(file: File): Promise<FileUploadPayload> {
  if (file.size > MAX_FILE_UPLOAD_BYTES) {
    throw new Error("文件超过 100MB 限制");
  }
  const bytes = await readFileBytes(file);
  return {
    fileName: file.name || "upload",
    mimeType: file.type || "application/octet-stream",
    dataBase64: bytesToBase64(bytes),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error("读取文件失败"));
        return;
      }
      resolve(new Uint8Array(reader.result));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("读取文件失败"));
    });
    reader.readAsArrayBuffer(file);
  });
}
