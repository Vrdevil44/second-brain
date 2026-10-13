# portal/vendor/ — vendored frontend libraries

No CDN. No third-party network requests. Everything here is same-origin,
so the portal's CSP (`script-src 'self'`) covers it with no changes.

## 3d-force-graph 1.73.3 (MIT)

- Package: `3d-force-graph@1.73.3` (vasturiano/3d-force-graph)
- Source: npm registry tarball
  `https://registry.npmjs.org/3d-force-graph/-/3d-force-graph-1.73.3.tgz`
- File: `3d-force-graph.min.js` (UMD build, `dist/3d-force-graph.min.js`)
- SHA-256: `19b3be27040fc894e56d684d53c5f62526c25e5d27f37e8fe91fafff605e4ef4`
- License: `LICENSE-3d-force-graph` (MIT, copied from the tarball)
- Global: `window.ForceGraph3D`

**Three.js bundling (verified 2026-10-08):** Three.js and the d3-force-3d
layout engine are bundled INSIDE `3d-force-graph.min.js`. Verified by
inspection: the bundle contains `WebGLRenderer` and `alphaDecay`, has zero
`require("…")` calls, and references no external `THREE` global. Do NOT add
a standalone `three.min.js` — two Three.js instances break rendering.

## Re-verification

If this file is ever replaced, re-run:
`sha256sum portal/vendor/3d-force-graph.min.js`
and confirm the hash matches the one above before committing.
