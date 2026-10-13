# Third-Party Notices

These notices and license texts are distributed with the DEV Anywhere web app
under `/licenses/`.

## HEIC image decoding

DEV Anywhere uses `heic-to` 1.6.6 to decode HEIC images in the browser. Its bundled
decoder contains `libheif` 1.23.6 and `libde265` 1.0.16. These libraries and their
use are covered by the GNU Lesser General Public License, version 3 or later.
DEV Anywhere does not modify their source code.

### heic-to 1.6.6

- Author: Hopper Gee.
- License: LGPL-3.0-or-later; the complete upstream notice and license are in
  [heic-to-LGPL-3.0.txt](./heic-to-LGPL-3.0.txt).
- [Source code and build instructions](https://github.com/hoppergee/heic-to/tree/4045b8d7607e326c2b479cc424c7a60519b42dae).
- [Source archive](https://github.com/hoppergee/heic-to/archive/4045b8d7607e326c2b479cc424c7a60519b42dae.tar.gz).
- [Published package, including the JavaScript source and build script](https://registry.npmjs.org/heic-to/-/heic-to-1.6.6.tgz).

### libheif 1.23.6

- Copyright (c) 2017-2025 Dirk Farin and other libheif contributors, as identified
  in the source files.
- License: LGPL-3.0-or-later for the library; the complete upstream license texts,
  including GNU LGPL 3.0 and GNU GPL 3.0, are in
  [libheif-COPYING.txt](./libheif-COPYING.txt).
- [Source code](https://github.com/strukturag/libheif/tree/v1.23.6).
- [Source archive](https://github.com/strukturag/libheif/archive/refs/tags/v1.23.6.tar.gz).
- [Emscripten build script](https://github.com/strukturag/libheif/blob/v1.23.6/build-emscripten.sh).

### libde265 1.0.16

- Copyright (c) 2013-2014 struktur AG, Dirk Farin and other libde265 contributors,
  as identified in the source files.
- License: LGPL-3.0-or-later for the library; the complete upstream license texts,
  including GNU LGPL 3.0 and GNU GPL 3.0, are in
  [libde265-COPYING.txt](./libde265-COPYING.txt).
- [Source code](https://github.com/strukturag/libde265/tree/v1.0.16).
- [Source archive](https://github.com/strukturag/libde265/releases/download/v1.0.16/libde265-1.0.16.tar.gz).

The linked `heic-to` build instructions describe how to rebuild its decoder from
these library sources with `LIBDE265_VERSION=1.0.16` and `USE_WASM=0`. They also
document the `USE_UNSAFE_EVAL=0` variant. The GNU GPL 3.0 text incorporated by
the LGPL is included in both `COPYING` files above.

DEV Anywhere's application source and build instructions are available in the
[DEV Anywhere repository](https://github.com/lichenxicatapple-blip/dev-anywhere).
To use a modified decoder, replace the corresponding sources in `heic-to`, rebuild
that package using its `esbuild.mjs` script, and rebuild the DEV Anywhere web app.

## Windows shell icons

PowerShell and Command Prompt icons come from
[Microsoft Windows Terminal](https://github.com/microsoft/terminal/tree/7d06b26f73ef4bcb78b56647c395251eeee4c2bc/src/cascadia/CascadiaPackage/ProfileIcons).
Copyright (c) Microsoft Corporation. All rights reserved.
See [microsoft-terminal-MIT.txt](./microsoft-terminal-MIT.txt).

These licenses apply to their respective components. DEV Anywhere's own source
code remains available under the MIT license.
