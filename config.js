// Second Brain portal config — static, committed.
// LIVE_API_BASE is the local machine's Tailscale MagicDNS name (tailnet-only;
// unreachable off-tailnet by design — the portal silently falls back to the
// baked static files there). No modes, no toggles: the portal auto-detects
// reachability on every poll and uses whichever source answers.
window.BRAIN_CONFIG = {
  LIVE_API_BASE: "https://desktop-0p1q7t3.tail171c67.ts.net/api",
  LIVE_TIMEOUT_MS: 2500
};
