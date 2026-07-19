import { describeCurrentClientDevice } from "./client-device";

export interface UploadPickerPolicy {
  mediaAccept: string;
  fileAccept?: string;
}

export function getUploadPickerPolicy(
  osName = describeCurrentClientDevice().osName,
): UploadPickerPolicy {
  return {
    mediaAccept: "image/*,video/*",
    // An unrestricted input makes Android Chrome ask for camera permission on some devices.
    // Media already has its own picker, so keep the generic Android picker document-only.
    fileAccept: osName === "Android" ? "application/*,text/*" : undefined,
  };
}
