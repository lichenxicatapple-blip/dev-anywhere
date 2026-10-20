# Image fixtures

`quadrants.heic` is a project-generated 96 × 64 image with four solid-color quadrants:
red `(230, 30, 30)`, green `(30, 210, 45)`, blue `(30, 60, 230)`, and yellow `(230, 210, 30)`.
It contains no third-party photograph or personal metadata.

The RGB PNG source was encoded using macOS `sips`:

```sh
sips -s format heic -s formatOptions 90 quadrants.png --out quadrants.heic
```

Browser tests use the actual HEIC bytes and check decoded dimensions and pixels, PNG clipboard output, and the original download path.

`quadrants.bmp` uses the same dimensions and colors, stored as an uncompressed 24-bit
Windows BMP: a 14-byte file header, a 40-byte BITMAPINFOHEADER, and bottom-up BGR
rows. It is generated directly from the four RGB colors above and has no external
image source. Browser tests verify native decoding, PNG clipboard output, and
unchanged original-file downloads.
