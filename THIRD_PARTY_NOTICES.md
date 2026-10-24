# Third-party notices

Revqora itself is licensed under the MIT License (see `LICENSE`). It includes or ships
with the following third-party components, each under its own license.

Revqora does not ship Git. It runs the Git installed on the user's computer as a separate
process.

## Fonts (embedded in the application)

| Font | License |
| --- | --- |
| Inter (via @fontsource-variable/inter) | SIL Open Font License 1.1 |
| JetBrains Mono (via @fontsource-variable/jetbrains-mono) | SIL Open Font License 1.1 |

The OFL texts are included in `node_modules/@fontsource-variable/*/LICENSE` of the source
tree and at https://openfontlicense.org.

## Libraries

- JavaScript (React, CodeMirror, Lezer, zustand, lucide-react, Tauri API and their
  dependencies): MIT or ISC.
- Rust (Tauri, serde, notify, ureq, parking_lot and their dependencies): mostly MIT and/or
  Apache-2.0; some BSD-3-Clause, Zlib, ISC, Unlicense, CC0-1.0. Notable others:
  - MPL-2.0 (used unmodified): cssparser, cssparser-macros, selectors, dtoa-short, option-ext
  - Unicode-3.0: ICU4X data crates (icu_*, zerovec, yoke, tinystr, litemap, writeable, …)
  - CDLA-Permissive-2.0: webpki-roots

Exact versions are recorded in `package-lock.json` and `src-tauri/Cargo.lock`.
