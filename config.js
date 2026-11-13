// Second Brain portal config — static, committed.
// LIVE_API_BASE is the local machine's Tailscale MagicDNS name (tailnet-only;
// unreachable off-tailnet by design — the portal silently falls back to the
// baked static files there). No modes, no toggles: the portal auto-detects
// reachability on every poll and uses whichever source answers.
window.BRAIN_CONFIG = {
  LIVE_API_BASE: "https://desktop-0p1q7t3.tail171c67.ts.net/api",
  LIVE_TIMEOUT_MS: 2500,
  // GATE_OFF (owner decision 2026-11-13, fixing window only): when true, the
  // publish workflow ships the baked payloads UNENCRYPTED and the portal's
  // frontend unlock gate (password + TOTP) does not engage — the payloads
  // load as plain objects, the mode app.js already supports for local
  // preview. Default is false (locked). No security code is removed: flip
  // this back to false and the next publish re-encrypts everything and the
  // gate returns. The box backend's server-side token auth is a separate
  // layer and is NOT affected by this flag.
  GATE_OFF: true
};
