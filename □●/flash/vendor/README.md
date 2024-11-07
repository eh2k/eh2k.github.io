# vendor/

What the web app used to load from cdn.jsdelivr.net and Google Fonts, here so that the page loads nothing from third
parties (no IP address to them, no CDN that has to be up). The files are as the CDN gave them on 2026-10-07; to update
one, download the new version and change the name in the page that loads it.

| File | From | License |
|---|---|---|
| `halfmoon-2.0.2.min.css` | `npm/halfmoon@2.0.2/css/halfmoon.min.css` | MIT |
| `bootstrap-5.3.3.bundle.min.js` | `npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js` (sha256-CDOy6cOibCWEdsRiZuaHf8dSGGJRYuBGC+mjoJimHGw=) | MIT |
| `intel-hex-1.4.0.js` | `npm/nrf-intel-hex@1.4.0/intel-hex.js` | BSD-3-Clause |
| `webmidi-3.1.14.esm.min.js` | `npm/webmidi@3.1.14/dist/esm/webmidi.esm.min.js` (before: the unminified webmidi.esm.js in web-app/) | Apache-2.0 |
| `fonts.css`, `fonts/*.woff2` | Google Fonts: DM Mono 400/500, DM Sans 400–700 (latin, latin-ext) | SIL OFL 1.1 (`fonts/OFL-*.txt`) |
