import { describe, expect, it } from "vitest";
import { getUploadPickerPolicy } from "./upload-picker-policy";

describe("upload picker policy", () => {
  it("lets Safari and desktop file pickers select every file type", () => {
    expect(getUploadPickerPolicy("iPad")).toEqual({
      mediaAccept: "image/*,video/*",
      fileAccept: undefined,
    });
    expect(getUploadPickerPolicy("macOS").fileAccept).toBeUndefined();
  });

  it("keeps Android camera capture out of the generic file picker", () => {
    expect(getUploadPickerPolicy("Android")).toEqual({
      mediaAccept: "image/*,video/*",
      fileAccept: "application/*,text/*",
    });
  });
});
