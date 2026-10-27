/*
 * Second Brain portal
 *
 * ============================================================================
 * HARD PRIVACY RULE
 * This page must NEVER fetch, list, or display raw content from `daily-dump/`
 * or `organized/`. The ONLY data it may load is `graph.json`, which holds
 * sanitized cluster data (labels, types, sizes and links, no raw notes).
 *
 * The published graph.json is AES-256-GCM encrypted (see encrypt-graph.mjs).
 * It is decrypted in the visitor's browser with a password that is typed in,
 * used once, and never stored or transmitted anywhere. Optionally ("remember
 * this device") a NON-EXTRACTABLE derived key is kept in IndexedDB for 24 h.
 *
 * The only network requests this page is allowed to make are:
 *   1. GET  graph.json                         (same origin, sanitized data)
 *   2. GET  https://api.github.com/user        (settings: test connection)
 *   3. PUT  https://api.github.com/repos/Vrdevil44/about-vibhu/contents/daily-dump/...
 *                                              (write-only dump uploads)
 *   4. GET  aliases.json                       (same origin, public alias subset:
 *                                              generic family words only)
 * Every request goes through `guardedRequest()`, which rejects anything else.
 * The Content-Security-Policy in index.html enforces the same limits in the
 * browser. Do not add reads of the private repo here, ever.
 * ============================================================================
 *
 * No build step, no dependencies. Vanilla JS only.
 */
/**
 * Search rank class (A4). Demotion, never removal: 0 = current, 1 = brain echo
 * entry (label starts with "[total-echo"), 2 = superseded (or lifecycle-dimmed).
 * Superseded outranks echo. Reads name OR label so it fits both the universe
 * node objects (name) and raw graph nodes (label).
 */
function searchRankOf(node) {
  if (!node) return 0;
  if (node.status === 'superseded' || node.life) return 2;
  const t = String(node.name || node.label || '');
  return t.startsWith('[total-echo') ? 1 : 0;
}
/**
 * Pure query expansion for search (R3). Finds the first whitespace token of q
 * that belongs to an alias group and returns q followed by q with that token
 * swapped for each other group member, in group order. Capped at 6.
 */
function expandQueryVariants(q, groups) {
  const out = [q];
  if (!q || !Array.isArray(groups) || !groups.length) return out;
  const tokens = q.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const group = groups.find((g) => Array.isArray(g) && g.includes(tokens[i]));
    if (!group) continue;
    for (const member of group) {
      if (member === tokens[i]) continue;
      const t = tokens.slice();
      t[i] = member;
      out.push(t.join(' '));
    }
    break;
  }
  return out.slice(0, 6);
}

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const CONFIG = {
    owner: 'Vrdevil44',
    repo: 'dream-brain',
    dumpDir: 'daily-dump',
    graphUrl: 'graph.json',
    apiBase: 'https://api.github.com',
    tokenKey: 'secondBrain.githubToken',
  };

  const MAX_TEXT = 50000;
  const MAX_FILES = 5;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_NAME_LEN = 80;

  const ALLOWED = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'],
    video: ['mp4', 'webm', 'mov'],
    audio: ['mp3', 'wav', 'm4a', 'ogg'],
    document: ['pdf', 'txt', 'md', 'markdown', 'doc', 'docx', 'csv'],
    archive: ['zip'],
  };
  const EXT_KIND = Object.fromEntries(
    Object.entries(ALLOWED).flatMap(([kind, exts]) => exts.map((e) => [e, kind]))
  );
  const BLOCKED = new Set(['exe', 'sh', 'bat', 'dmg', 'app', 'msi']);

  const TYPE_COLORS = {
    cluster: '#8b7cff',
    idea: '#38d6c4',
    target: '#ffb547',
    person: '#ff7eb6',
    project: '#6aa7ff',
    topic: '#9be564',
    unknown: '#888888',
  };
  // Node types the renderer knows. Anything else renders as 'unknown'.
  const NODE_TYPES = Object.keys(TYPE_COLORS);
  const UNKNOWN_COLOR = '#8a8ea3';

  const $ = (sel) => document.querySelector(sel);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------------------
  // Privacy guard: the single choke point for all network traffic
  // ---------------------------------------------------------------------------
  const DUMP_PATH_PREFIX = `/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.dumpDir}/`;

  function assertAllowedRequest(url, method) {
    const u = new URL(url, window.location.href);
    const m = method.toUpperCase();

    if (u.origin === window.location.origin) {
      // Same origin: only graph.json, mfa.json, live-state.json and knowledge-base.json, only GET.
      const isGraph = u.pathname.endsWith('/' + CONFIG.graphUrl) || u.pathname === '/' + CONFIG.graphUrl;
      const isMfa = u.pathname.endsWith('/mfa.json') || u.pathname === '/mfa.json';
      const isLive = u.pathname.endsWith('/live-state.json') || u.pathname === '/live-state.json';
      const isKb = u.pathname.endsWith('/knowledge-base.json') || u.pathname === '/knowledge-base.json';
      if (m === 'GET' && (isGraph || isMfa || isLive || isKb) && !/\/(daily-dump|organized)\//.test(u.pathname)) return;
      // R3: aliases.json (public subset) is also readable, GET only.
      const isAliases = u.pathname.endsWith('/aliases.json') || u.pathname === '/aliases.json';
      if (m === 'GET' && isAliases) return;
      throw new Error('Blocked by privacy rule: ' + m + ' ' + u.pathname);
    }

    if (u.origin === CONFIG.apiBase) {
      if (m === 'GET' && u.pathname === '/user') return;
      if (m === 'PUT' && u.pathname.startsWith(DUMP_PATH_PREFIX) && !u.pathname.includes('..')) return;
      // Updates log: recent commits (private repo, needs token).
      if (m === 'GET' && /^\/repos\/[^/]+\/dream-brain\/commits/.test(u.pathname)) return;
      // Sync-now: dispatch the workflow and poll its status.
      const wf = `/repos/${CONFIG.owner}/dream-brain/actions/`;
      if (m === 'POST' && u.pathname === wf + 'workflows/sync.yml/dispatches') return;
      if (m === 'GET' && u.pathname === wf + 'workflows/sync.yml/runs') return;
      if (m === 'GET' && /^\/repos\/[^/]+\/dream-brain\/actions\/runs\/\d+$/.test(u.pathname)) return;
      if (m === 'GET' && /^\/repos\/[^/]+\/dream-brain\/actions\/runs\/\d+\/jobs$/.test(u.pathname)) return;
    }
    throw new Error('Blocked by privacy rule: ' + m + ' ' + u.origin + u.pathname);
  }

  function guardedFetch(url, options = {}) {
    assertAllowedRequest(url, options.method || 'GET');
    return fetch(url, options);
  }

  // The token is only ever attached to requests for api.github.com.
  function githubHeaders(token) {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  // ---------------------------------------------------------------------------
  // Token storage (localStorage only)
  // Optional hardening NOT done: wrapping the PAT with the session key. getToken()
  // is read synchronously in several places and the session key only exists for
  // remembered devices, so it isn't trivial. The CSP + no-innerHTML rule is the
  // XSS defence instead.
  // ---------------------------------------------------------------------------
  const TOKEN_RE = /^(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/;

  function getToken() {
    try { return localStorage.getItem(CONFIG.tokenKey) || ''; } catch { return ''; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(CONFIG.tokenKey, t);
      else localStorage.removeItem(CONFIG.tokenKey);
      return true;
    } catch { return false; }
  }
  function tokenFormatError(t) {
    if (!t) return 'Paste a token first.';
    if (!t.startsWith('ghp_') && !t.startsWith('github_pat_')) {
      return 'That doesn\'t look like a GitHub token. It must start with ghp_ or github_pat_.';
    }
    if (/\s/.test(t)) return 'The token contains spaces. Copy it again without extra characters.';
    if (!TOKEN_RE.test(t)) return 'The token looks incomplete or has unexpected characters.';
    return '';
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function svgIcon(path) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);
    svg.append(p);
    return svg;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  const nf = new Intl.NumberFormat('en-US');

  function toast(msg, kind = '') {
    const t = el('div', { class: 'toast ' + kind, text: msg });
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 3800);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ===========================================================================
  // GRAPH
  // ===========================================================================
  const canvas = $('#graph');
  const ctx = canvas.getContext('2d');

  const graph = {
    nodes: [],
    edges: [],
    byId: new Map(),
    adj: new Map(), // id -> [{node, strength}]
  };

  const view = { k: 1, tx: 0, ty: 0, w: 0, h: 0, dpr: 1 };
  const sim = { alpha: 1, alphaTarget: 0, running: false };
  let hovered = null;
  let selected = null;
  let needsDraw = true;
  let viewAnim = null;

  // ---- Encrypted graph loading ------------------------------------------------
  // The published graph.json is an AES-256-GCM envelope:
  //   {"v":1,"salt":<b64>,"iv":<b64>,"data":<b64>}   (GCM auth tag appended)
  // Key derivation: PBKDF2-SHA256(password, salt, 200000) -> 256-bit key.
  // The password is typed by the visitor, used once, and never stored.
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function isEnvelope(o) {
    return !!o && o.v === 1 &&
      typeof o.salt === 'string' && typeof o.iv === 'string' && typeof o.data === 'string';
  }

  // ---- TOTP (RFC 6238, SHA-1, 30s step, 6 digits) -----------------------------
  // The second factor. The TOTP secret is published only inside mfa.json,
  // AES-256-GCM encrypted with the password (see encrypt-mfa.mjs), so the
  // page learns it only after a correct password, keeps it in memory for the
  // code check, then drops it. The owner scans the matching QR code into
  // their authenticator app once at setup.
  function base32ToBytes(s) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = String(s).replace(/=+$/, '').toUpperCase();
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
      const idx = alphabet.indexOf(ch);
      if (idx < 0) throw new Error('bad base32');
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return new Uint8Array(out);
  }

  async function totpCode(secretBytes, counter) {
    const key = await crypto.subtle.importKey(
      'raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const msg = new ArrayBuffer(8);
    const view = new DataView(msg);
    view.setUint32(0, Math.floor(counter / 0x100000000));
    view.setUint32(4, counter >>> 0);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
    const offset = mac[mac.length - 1] & 0x0f;
    const bin = ((mac[offset] & 0x7f) << 24) |
      (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
    return String(bin % 1000000).padStart(6, '0');
  }

  // Accepts the previous, current, or next 30s window to tolerate clock skew.
  async function verifyTotp(secretB32, code) {
    let secretBytes;
    try { secretBytes = base32ToBytes(secretB32); } catch (e) { return false; }
    const counter = Math.floor(Date.now() / 30000);
    for (const c of [counter - 1, counter, counter + 1]) {
      if (await totpCode(secretBytes, c) === code) return true;
    }
    return false;
  }

  // Returns the TOTP secret when mfa.json is published and decrypts with the
  // password; null when MFA is not configured (mfa.json missing). Throws on a
  // wrong password exactly like a graph decrypt failure, so the caller can
  // show the same "wrong password" message.
  async function loadMfaSecret(password) {
    let res;
    try {
      res = await guardedFetch('mfa.json', { cache: 'no-store' });
    } catch (e) {
      return null;
    }
    if (!res.ok) return null;
    const menv = await res.json();
    if (!isEnvelope(menv)) throw new Error('bad mfa envelope');
    const mobj = await decryptEnvelope(menv, password);
    if (!mobj || typeof mobj.secret !== 'string') throw new Error('bad mfa payload');
    return mobj.secret;
  }

  // Derives the envelope's data key. Same PBKDF2-SHA256 / 200k / salt as ever,
  // so the envelope format is unchanged and old clients still decrypt it. The
  // key is NON-EXTRACTABLE: page JS can use it but can never read its bytes.
  // 'encrypt' is only used to seal the remembered-device record (see below).
  async function deriveDataKey(env, password) {
    const subtle = crypto.subtle;
    const base = await subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt: b64ToBytes(env.salt), iterations: 200000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt', 'encrypt']);
  }

  async function decryptWithKey(env, key) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.data));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  async function decryptEnvelope(env, password) {
    return decryptWithKey(env, await deriveDataKey(env, password));
  }

  // ---- Remember this device (24 h) ------------------------------------------
  // After a FULL unlock (password + TOTP when MFA is on) and only if the box is
  // ticked, the non-extractable data key is stored in IndexedDB (structured
  // clone) with a deviceId, a fingerprint and a fixed expiry. The record is
  // sealed with that key (AES-GCM, expiry in the authenticated data), so edits
  // are detected. The 24 h is a page policy plus tamper detection, NOT a hard
  // cryptographic expiry: there is no server to enforce one. The fingerprint is
  // a convenience tripwire, not a security control. Nothing here is ever
  // logged, put in a URL, or kept in localStorage except the random deviceId.
  const SESSION_MS = 24 * 60 * 60 * 1000;
  const IDB_NAME = 'secondBrain';
  const IDB_STORE = 'session';
  const DEVICE_KEY = 'secondBrain.deviceId';
  const IDLE_KEY = 'secondBrain.idleMinutes';
  const DEFAULT_IDLE_MIN = 30;
  const MISMATCH_LIMIT = 2; // this many stable factors differing => wipe

  function idb() {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(IDB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  async function idbRun(mode, fn) {
    const db = await idb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, mode);
        const req = fn(tx.objectStore(IDB_STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  const idbGet = () => idbRun('readonly', (st) => st.get('current'));
  const idbPut = (rec) => idbRun('readwrite', (st) => st.put(rec, 'current'));
  const idbDelete = () => idbRun('readwrite', (st) => st.delete('current'));

  function getDeviceId() { try { return localStorage.getItem(DEVICE_KEY) || ''; } catch { return ''; } }

  async function wipeSession() {
    try { localStorage.removeItem(DEVICE_KEY); } catch { /* storage blocked */ }
    try { await idbDelete(); } catch { /* nothing stored / IDB blocked */ }
    sessionExpiresAt = 0;
    sessionDataKey = null;
    kbReset();
  }

  async function sha256Hex(text) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function canvasHash() {
    const c = document.createElement('canvas');
    c.width = 220; c.height = 40;
    const g = c.getContext('2d');
    g.textBaseline = 'top';
    g.font = '16px sans-serif';
    g.fillStyle = '#8b7cff'; g.fillRect(4, 4, 90, 24);
    g.fillStyle = '#222'; g.fillText('Second Brain ✓ fp', 8, 8);
    return sha256Hex(c.toDataURL());
  }

  // Stable factors only (no UA minor version, timezone or dpr: those change on
  // browser updates, monitor changes, travel and display scaling).
  // canvas === null means "unstable in this browser": excluded for good.
  async function computeFingerprint(allowCanvas = true) {
    const nav = navigator;
    const fp = {
      platform: String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || ''),
      language: String(nav.language || ''),
      cores: Number(nav.hardwareConcurrency) || 0,
      screen: [Math.max(screen.width, screen.height), Math.min(screen.width, screen.height)].join('x'),
      canvas: null,
    };
    if (allowCanvas) fp.canvas = await canvasHash();
    return fp;
  }

  async function createFingerprint() {
    const fp = await computeFingerprint(true);
    // Privacy modes randomize canvas output per call; if two runs differ, drop it.
    if (fp.canvas !== await canvasHash()) fp.canvas = null;
    return fp;
  }

  // Throws on any failure: callers treat a throw as a mismatch (fail closed).
  async function fingerprintMismatches(stored) {
    const now = await computeFingerprint(stored.canvas !== null);
    let n = 0;
    for (const f of ['platform', 'language', 'cores', 'screen']) if (now[f] !== stored[f]) n++;
    if (stored.canvas !== null && now.canvas !== stored.canvas) n++;
    return n;
  }

  const sealAad = (deviceId, createdAt, expiresAt) =>
    new TextEncoder().encode(deviceId + '|' + createdAt + '|' + expiresAt);

  async function createSession(key) {
    const deviceId = crypto.randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + SESSION_MS;
    const fingerprint = await createFingerprint();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = new TextEncoder().encode(JSON.stringify({ deviceId, createdAt, expiresAt, fingerprint }));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: sealAad(deviceId, createdAt, expiresAt) }, key, body);
    localStorage.setItem(DEVICE_KEY, deviceId);
    try {
      await idbPut({ v: 1, deviceId, createdAt, expiresAt, key, seal: { iv, ct } });
    } catch (e) {
      try { localStorage.removeItem(DEVICE_KEY); } catch { /* ignore */ }
      throw e;
    }
    sessionExpiresAt = expiresAt;
  }

  // Returns { data } on success, or { notice } (and the session is wiped).
  async function tryRememberedUnlock(envelope) {
    let rec;
    try { rec = await idbGet(); } catch { return { notice: '' }; }
    if (!rec) return { notice: '' };
    const fail = async (notice) => { await wipeSession(); return { notice }; };
    try {
      if (!rec.key || !rec.seal || typeof rec.expiresAt !== 'number' || typeof rec.createdAt !== 'number') {
        return fail('This device\'s saved session was damaged, so it was cleared. Please unlock again.');
      }
      if (Date.now() >= rec.expiresAt) {
        return fail('Your 24 hours are up. Please unlock again.');
      }
      if (!getDeviceId() || getDeviceId() !== rec.deviceId) {
        return fail('This browser doesn\'t match the remembered device, so it was cleared. Please unlock again.');
      }
      let sealed;
      try {
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: rec.seal.iv, additionalData: sealAad(rec.deviceId, rec.createdAt, rec.expiresAt) },
          rec.key, rec.seal.ct);
        sealed = JSON.parse(new TextDecoder().decode(pt));
      } catch {
        return fail('This device\'s saved session didn\'t check out, so it was cleared. Please unlock again.');
      }
      if (sealed.deviceId !== rec.deviceId || sealed.expiresAt !== rec.expiresAt ||
          sealed.createdAt !== rec.createdAt || rec.expiresAt - rec.createdAt > SESSION_MS + 60000) {
        return fail('This device\'s saved session didn\'t check out, so it was cleared. Please unlock again.');
      }
      let mismatches;
      try { mismatches = await fingerprintMismatches(sealed.fingerprint); } catch { mismatches = MISMATCH_LIMIT; }
      if (mismatches >= MISMATCH_LIMIT) {
        return fail('This browser looks different from when you unlocked it, so the remembered session was cleared. Please unlock again.');
      }
      let data;
      try { data = await decryptWithKey(envelope, rec.key); } catch {
        return fail('The brain was republished (the password may have changed), so the remembered session was cleared. Please unlock again.');
      }
      sessionExpiresAt = rec.expiresAt;
      sessionDataKey = rec.key;
      return { data };
    } catch {
      return fail('Couldn\'t restore the remembered session. Please unlock again.');
    }
  }

  // ---- Locking: Lock now, idle auto-lock, cross-tab -------------------------
  let sessionExpiresAt = 0;
  let lockWatch = false;
  const lockChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('secondBrain.session') : null;

  function idleMinutes() {
    let v = NaN;
    try { v = parseInt(localStorage.getItem(IDLE_KEY), 10); } catch { /* ignore */ }
    return Number.isFinite(v) ? clamp(v, 1, 480) : DEFAULT_IDLE_MIN;
  }

  // Wipes the stored key and reloads: the in-memory graph is dropped and the
  // lock screen shows on the next load. Other tabs are told to do the same.
  async function lockNow() {
    await wipeSession();
    if (lockChannel) lockChannel.postMessage('lock');
    window.location.reload();
  }

  if (lockChannel) {
    lockChannel.onmessage = (e) => {
      if (e.data === 'lock' && $('#lockscreen').hidden) window.location.reload();
    };
  }

  function startLockWatch() {
    if (lockWatch) return;
    lockWatch = true;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(ev, touch, { passive: true });
    }
    const check = () => {
      if (Date.now() - last > idleMinutes() * 60000) return lockNow();
      if (sessionExpiresAt && Date.now() >= sessionExpiresAt) return lockNow();
    };
    setInterval(check, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }

  // Shows the lock screen and resolves with the decrypted graph once the
  // password (and, when MFA is configured, the TOTP code) is correct.
  // Loops on wrong passwords/codes; never stores the password.
  async function unlockWithPassword(envelope, notice) {
    const lock = $('#lockscreen');
    const stepPw = $('#lock-step-password');
    const stepCode = $('#lock-step-code');
    const input = $('#lock-input');
    const error = $('#lock-error');
    const btn = $('#lock-unlock');
    const codeInput = $('#code-input');
    const codeError = $('#code-error');
    const codeBtn = $('#code-verify');
    lock.hidden = false;
    stepPw.hidden = false;
    stepCode.hidden = true;

    // ---- Step 1: password -------------------------------------------------
    let password = '';
    let mfaSecret = null;
    let hint = notice || '';
    let remember = false;
    for (;;) {
      error.textContent = hint;
      hint = '';
      input.value = '';
      setTimeout(() => input.focus(), 50);
      password = await new Promise((resolve) => {
        const go = () => {
          const pw = input.value;
          remember = $('#lock-remember').checked;
          input.value = '';
          btn.onclick = null;
          input.onkeydown = null;
          resolve(pw);
        };
        btn.onclick = go;
        input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      });
      if (!password) { hint = 'Enter your password.'; continue; }
      try {
        mfaSecret = await loadMfaSecret(password);
        if (mfaSecret === null) {
          // No MFA configured: validate the password against the graph itself.
          await decryptEnvelope(envelope, password);
        }
        break;
      } catch (e) {
        hint = 'Wrong password. Try again.';
      }
    }

    // ---- Step 2: TOTP rolling code (only when MFA is configured) ---------
    if (mfaSecret !== null) {
      stepPw.hidden = true;
      stepCode.hidden = false;
      let codeHint = '';
      for (;;) {
        codeError.textContent = codeHint;
        codeHint = '';
        codeInput.value = '';
        setTimeout(() => codeInput.focus(), 50);
        const code = await new Promise((resolve) => {
          const go = () => {
            const c = codeInput.value.trim();
            codeInput.value = '';
            codeBtn.onclick = null;
            codeInput.onkeydown = null;
            resolve(c);
          };
          codeBtn.onclick = go;
          codeInput.onkeydown = (e) => { if (e.key === 'Enter') go(); };
        });
        if (!/^\d{6}$/.test(code)) {
          codeHint = 'Enter the 6-digit code from your authenticator app.';
          continue;
        }
        if (await verifyTotp(mfaSecret, code)) break;
        codeHint = 'Wrong code. Check your authenticator app and try again.';
      }
      mfaSecret = null; // drop it from memory once verified
    }

    const key = await deriveDataKey(envelope, password);
    const data = await decryptWithKey(envelope, key);
    sessionDataKey = key;
    await acquirePortalToken(password);
    password = ''; // dropped from our variables; JS can't guarantee the string is wiped
    lock.hidden = true;
    if (remember) {
      try { await createSession(key); } catch (e) {
        toast('Couldn\'t remember this device (browser storage is blocked).', 'err');
      }
    }
    return data;
  }

  // ---- View mode (3D universe / 2D fallback) ----------------------------------
  // In-memory only. The 3D scripts are injected strictly after unlock+decrypt;
  // nothing 3D-related is referenced from index.html.
  let viewMode = '3d';
  document.body.classList.add('view-3d');
  let graphData = null;
  let sessionDataKey = null; // derived data key, held in memory only while unlocked (same lifetime as graphData)
  let graph2dBuilt = false;
  const scriptLoads = new Map();

  function loadScriptOnce(src) {
    if (!scriptLoads.has(src)) {
      scriptLoads.set(src, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => { scriptLoads.delete(src); reject(new Error('Failed to load ' + src)); };
        document.head.append(s);
      }));
    }
    return scriptLoads.get(src);
  }

  async function renderView() {
    if (!graphData) return;
    const toggle = $('#view-toggle');
    const box = $('#universe');
    if (viewMode === '3d') {
      try {
        await loadScriptOnce('vendor/3d-force-graph.min.js?v=8ce9a5a');
        await loadScriptOnce('universe.js?v=8ce9a5a');
        if (!window.BrainUniverse) throw new Error('3D module unavailable');
        document.body.classList.add('view-3d');
        box.hidden = false;
        window.BrainUniverse.init(box, graphData, {
          onMeta: (text) => { $('#graph-meta').textContent = text; },
          loadLiveState: loadLiveStateLive, // live tailnet API first, baked fallback
          onBeatUpdates: (st) => appendBeatUpdates(st),
        });
        $('#demo-badge').hidden = !graphData.demo;
        if (toggle) { toggle.textContent = '2D'; toggle.title = 'Switch to 2D view'; }
        return;
      } catch (err) {
        console.error(err);
        toast('3D view unavailable, showing 2D.', 'err');
        viewMode = '2d';
        document.body.classList.remove('view-3d');
        box.hidden = true;
      }
    }
    if (toggle) { toggle.textContent = '3D'; toggle.title = 'Switch to 3D view'; }
    document.body.classList.add('view-2d');
    if (!graph2dBuilt) { buildGraph(graphData); graph2dBuilt = true; }
    else { resize(); fitView(false); requestRender(); }
  }

  async function setViewMode(mode) {
    if (mode === viewMode || !graphData) return;
    if (viewMode === '3d' && window.BrainUniverse) window.BrainUniverse.destroy();
    $('#universe').hidden = true;
    document.body.classList.remove('view-3d', 'view-2d');
    viewMode = mode;
    document.body.classList.add(mode === '3d' ? 'view-3d' : 'view-2d');
    await renderView();
  }

  const viewToggle = $('#view-toggle');
  if (viewToggle) viewToggle.addEventListener('click', () => { setViewMode(viewMode === '3d' ? '2d' : '3d'); });

  // ---- Alias dictionary + merged search (R3) ---------------------------------
  let aliasGroups = [];

  function loadAliases() {
    guardedFetch('aliases.json')
      .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then((body) => {
        const groups = body && Array.isArray(body.groups) ? body.groups : [];
        aliasGroups = groups
          .filter((g) => Array.isArray(g))
          .map((g) => g.map((w) => String(w).toLowerCase()));
      })
      .catch(() => { aliasGroups = []; });
  }

  function expandedSearch(q) {
    const U = window.BrainUniverse;
    const nodes = [];
    const rels = [];
    const seenNodes = new Set();
    const seenRels = new Set();
    for (const v of expandQueryVariants(q, aliasGroups)) {
      try {
        if (U && U.searchNodes) {
          for (const n of U.searchNodes(v) || []) {
            if (seenNodes.has(n.id)) continue;
            seenNodes.add(n.id);
            nodes.push(n);
          }
        }
      } catch (e) { /* noop */ }
      try {
        if (U && U.searchRelations) {
          for (const r of U.searchRelations(v) || []) {
            const key = r.from + '|' + r.type + '|' + r.to;
            if (seenRels.has(key)) continue;
            seenRels.add(key);
            rels.push(r);
          }
        }
      } catch (e) { /* noop */ }
    }
    // A4: demote superseded / echo hits below current ones (stable by rank, then match quality).
    const rankById = new Map();
    if (graphData && Array.isArray(graphData.nodes)) {
      for (const gn of graphData.nodes) rankById.set(gn.id, searchRankOf(gn));
    }
    const rk = (n) => rankById.get(n.id) || 0;
    nodes.sort((a, b) => (rk(a) - rk(b)) || ((b.score || 0) - (a.score || 0)));
    return { nodes: nodes.slice(0, 20), rels: rels.slice(0, 20) };
  }

  // ---- Load + sanitize graph.json -------------------------------------------
  async function loadGraph() {
    const status = $('#graph-status');
    status.textContent = 'Loading graph…';
    try {
      const res = await guardedFetch(CONFIG.graphUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      // Published site serves the encrypted envelope; a plain graph object
      // means local preview — load it directly.
      let data = body;
      if (isEnvelope(body)) {
        const r = await tryRememberedUnlock(body);
        data = r.data || await unlockWithPassword(body, r.notice);
        startLockWatch();
      }
      graphData = data; // decrypted graph stays in memory only
      $('#open-kb').hidden = false; // KB entry point: only after a full unlock
      await renderView();
      status.textContent = '';
      status.classList.remove('error');
      if (!Array.isArray(data && data.nodes) || !data.nodes.length) status.textContent = 'The graph is empty. Dump something and the nightly organizer will fill it in.';
    } catch (err) {
      console.error(err);
      status.classList.add('error');
      status.textContent = 'Couldn\'t load graph.json (' + err.message + '). If you opened index.html straight from disk, serve the folder instead, for example: python3 -m http.server';
      $('#graph-meta').textContent = 'Graph unavailable';
    }
  }

  // ---- LIVE heartbeat state -------------------------------------------------
  // live-state.json is staged by the 15-min heartbeat and copied into portal/
  // at publish time. Published, it wears the same AES-256-GCM envelope as
  // graph.json (encrypted by the publish workflow); locally it is a plain
  // object. Decrypted here with the session key, in memory only.
  async function loadLiveState() {
    try {
      const res = await guardedFetch('live-state.json', { cache: 'no-store' });
      if (!res.ok) return null;
      const body = await res.json();
      if (body && body.v === 1 && typeof body.data === 'string') {
        if (!sessionDataKey) return null;
        const st = await decryptWithKey(body, sessionDataKey); // returns parsed JSON
        return (st && typeof st.beat === 'number') ? st : null;
      }
      return (body && typeof body.beat === 'number') ? body : null; // local preview
    } catch {
      return null;
    }
  }

  // ---- LIVE backend (tailnet) — silent auto-detect, baked fallback --------
  // Tries the local machine's live API first (portal/config.js). On ANY
  // failure the portal silently uses the baked live-state.json. No modes, no
  // toggles, no UI changes: the universe keeps polling loadLiveState on its
  // own cadence, and whichever source answers feeds the same render path.
  let liveSseState = null;   // freshest beat pushed over SSE: { st, at }
  let liveSseOpen = false;
  let liveSseRetryAt = 0;
  let liveStateFloor = null; // freshest live-state payload ever returned (monotonic)
  let liveFetchOkAt = 0;     // last successful fetchLiveState() contact (ms epoch)

  // Read-only vitals feed for portal/vitals.js. Counts and payload only; no node, key or label leaves.
  window.__brainVitals = Object.freeze({
    read: () => {
      const sseAt = (liveSseState && liveSseState.at) || 0;
      const contactAt = Math.max(sseAt, liveFetchOkAt);
      const unlocked = !!graphData || !!(graph.nodes && graph.nodes.length);
      const edges = graph2dBuilt ? graph.edges : (graphData && graphData.edges); // 3D never builds graph.edges
      return {
        st: fresherLiveState(liveStateFloor, liveSseState && liveSseState.st),
        contactAt: contactAt,
        live: contactAt > 0,
        relations: (unlocked && Array.isArray(edges)) ? edges.length : null,
        unlocked: unlocked,
      };
    },
  });

  // Monotonic freshness: higher beat wins; equal beat -> later ts wins. Never
  // returns a payload older than `current`.
  function fresherLiveState(current, candidate) {
    const ok = (x) => x && typeof x === 'object' && typeof x.beat === 'number' && isFinite(x.beat);
    if (!ok(candidate)) return current;
    if (!ok(current)) return candidate;
    if (candidate.beat !== current.beat) return candidate.beat > current.beat ? candidate : current;
    const ct = Date.parse(candidate.ts), kt = Date.parse(current.ts);
    return (ct > kt) ? candidate : current;
  }

  function liveApiBase() {
    try { return (window.BRAIN_CONFIG && window.BRAIN_CONFIG.LIVE_API_BASE) || ''; }
    catch (e) { return ''; }
  }
  function historyLiveUrl() {
    const b = liveApiBase();
    return b ? b + '/graph-history.jsonl' : '';
  }

  // Server-side portal auth. The bearer token lives in this variable ONLY
  // (never localStorage/sessionStorage); a reload drops it and the lock screen
  // asks for the password again.
  let portalToken = null;
  function liveAuthHeaders(h) {
    const out = Object.assign({}, h || {});
    if (portalToken) out['Authorization'] = 'Bearer ' + portalToken;
    return out;
  }
  // Any 401 from a live route: forget the token and go back to the gate.
  function liveAuthFail() {
    if (!portalToken && !graphData) return;
    portalToken = null;
    lockNow();
  }
  // The live-state, stream, history and portal-ask calls stay as they are; they
  // are authenticated here, in one place. Only requests to the live API's gated
  // routes are touched, and the auth call itself is never rewritten.
  const LIVE_GATED_PATHS = ['/live-state', '/stream', '/graph-history.jsonl', '/api/portal-ask', '/sync-status.json', '/api/window', '/api/gate-queue'];
  function liveGatedPath(url) {
    const base = liveApiBase();
    if (!base || typeof url !== 'string' || url.indexOf(base) !== 0) return '';
    const rest = url.slice(base.length).split('?')[0];
    return LIVE_GATED_PATHS.indexOf(rest) !== -1 ? rest : '';
  }
  if (typeof window.fetch === 'function') {
    const plainFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : '';
      if (!liveGatedPath(url)) return plainFetch(input, init);
      const next = Object.assign({}, init || {});
      next.headers = liveAuthHeaders(next.headers);
      return plainFetch(input, next).then((res) => {
        if (res && res.status === 401) liveAuthFail();
        return res;
      });
    };
  }
  if (typeof window.EventSource === 'function') {
    const PlainEventSource = window.EventSource;
    window.EventSource = function (url, opts) {
      const u = (portalToken && liveGatedPath(String(url)) === '/stream')
        ? String(url) + (String(url).indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(portalToken) : url;
      return new PlainEventSource(u, opts);
    };
    window.EventSource.prototype = PlainEventSource.prototype;
  }
  // Called once after a full unlock with the password just typed. Failure is
  // silent: without a token the live routes simply stay behind the gate.
  async function acquirePortalToken(password) {
    const base = liveApiBase();
    portalToken = null;
    if (!base || typeof fetch !== 'function') return;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 5000);
      const res = await fetch(base + '/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password }),
        credentials: 'omit',
        cache: 'no-store',
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const body = res.ok ? await res.json() : null;
      if (body && typeof body.token === 'string') portalToken = body.token;
    } catch (e) { portalToken = null; }
  }

  async function fetchLiveState() {
    const base = liveApiBase();
    if (!base || typeof fetch !== 'function') return null;
    try {
      const ctl = new AbortController();
      const ms = (window.BRAIN_CONFIG && window.BRAIN_CONFIG.LIVE_TIMEOUT_MS) || 2500;
      const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, ms);
      const res = await fetch(base + '/live-state', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const body = await res.json();
      if (body && typeof body.beat === 'number') liveFetchOkAt = Date.now();
      return (body && typeof body.beat === 'number') ? body : null;
    } catch (e) { return null; }
  }

  async function fetchSyncStatusLive() {
    const base = liveApiBase();
    if (!base || typeof fetch !== 'function') return null;
    try {
      const ctl = new AbortController();
      const ms = (window.BRAIN_CONFIG && window.BRAIN_CONFIG.LIVE_TIMEOUT_MS) || 2500;
      const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, ms);
      const res = await fetch(base + '/sync-status.json', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const body = await res.json();
      return (body && body.dial && typeof body.dial.percent === 'number') ? body : null;
    } catch (e) { return null; }
  }

  function ensureLiveStream() {
    const base = liveApiBase();
    if (!base || liveSseOpen || typeof EventSource !== 'function') return;
    if (Date.now() < liveSseRetryAt) return;
    try {
      const es = new EventSource(base + '/stream');
      liveSseOpen = true;
      es.addEventListener('beat', (ev) => {
        try {
          const b = JSON.parse(ev.data);
          if (b && typeof b.beat === 'number' && (!liveSseState || fresherLiveState(liveSseState.st, b) === b)) {
            liveSseState = { st: b, at: Date.now() };
          }
        } catch (e) {}
      });
      es.onerror = () => {
        try { es.close(); } catch (e) {}
        liveSseOpen = false;
        liveSseRetryAt = Date.now() + 60000; // retry at most once a minute
      };
    } catch (e) { liveSseRetryAt = Date.now() + 60000; }
  }

  async function loadLiveStateLive() {
    let st;
    if (liveSseState && Date.now() - liveSseState.at < 45000) {
      ensureLiveStream();
      st = liveSseState.st;
    } else {
      const live = await fetchLiveState();
      if (live) { ensureLiveStream(); st = live; }
      else st = await loadLiveState(); // baked static fallback — silent
    }
    // Keep-the-max: an older payload (e.g. the baked snapshot) never regresses the floor.
    liveStateFloor = fresherLiveState(liveStateFloor, st);
    return liveStateFloor || st;
  }

  function buildGraph(data) {
    const rawNodes = Array.isArray(data && data.nodes) ? data.nodes : [];
    const rawEdges = Array.isArray(data && data.edges) ? data.edges : [];

    graph.nodes = [];
    graph.edges = [];
    graph.byId.clear();
    graph.adj.clear();

    for (const n of rawNodes) {
      if (!n || (typeof n.id !== 'string' && typeof n.id !== 'number')) continue;
      const id = String(n.id);
      if (graph.byId.has(id)) continue;
      // Map domain → 2D type for coloring. Domains: people, projects, topics, places, patterns, library.
      const domainToType = { people: 'person', projects: 'project', topics: 'topic', places: 'target', patterns: 'idea', library: 'cluster' };
      const rawType = n.type || domainToType[n.domain] || 'unknown';
      const type = NODE_TYPES.includes(rawType) ? rawType : 'unknown';
      const size = clamp(Number(n.size) || 1, 1, 1000);
      const label = String(n.label == null ? id : n.label).slice(0, 120);
      const node = {
        id, label, type, size,
        r: radiusFor(type, size),
        x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
        degree: 0,
      };
      graph.nodes.push(node);
      graph.byId.set(id, node);
      graph.adj.set(id, []);
    }

    const seen = new Set();
    for (const e of rawEdges) {
      if (!e) continue;
      const a = graph.byId.get(String(e.from || e.source));
      const b = graph.byId.get(String(e.to || e.target));
      if (!a || !b || a === b) continue;
      const key = a.id < b.id ? a.id + '\u0000' + b.id : b.id + '\u0000' + a.id;
      if (seen.has(key)) continue;
      seen.add(key);
      let s = Number(e.strength);
      if (!Number.isFinite(s)) s = 0.5;
      if (s > 1) s = s / 10; // tolerate 0..10 scales
      s = clamp(s, 0.05, 1);
      const edge = { source: a, target: b, strength: s, bend: hashSign(key) };
      graph.edges.push(edge);
      graph.adj.get(a.id).push({ node: b, strength: s });
      graph.adj.get(b.id).push({ node: a, strength: s });
      a.degree++;
      b.degree++;
    }

    // Meta line in the top bar.
    const parts = [
      nf.format(graph.nodes.length) + ' nodes',
      nf.format(graph.edges.length) + ' strings',
    ];
    if (data && data.generated) {
      const d = new Date(data.generated);
      if (!isNaN(d)) parts.push('updated ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    }
    $('#graph-meta').textContent = parts.join(' · ');
    $('#demo-badge').hidden = !(data && data.demo);

    seedPositions();
    // Pre-warm the layout so the first frame is already tidy.
    sim.alpha = 1;
    const warm = reducedMotion ? 400 : 220;
    for (let i = 0; i < warm; i++) tick();
    sim.alpha = reducedMotion ? 0 : 0.25;
    fitView(false);
    startSim();
  }

  function radiusFor(type, size) {
    const s = Math.sqrt(size);
    if (type === 'cluster') return 16 + s * 3.2;
    if (type === 'target') return 6.5 + s * 1.6;
    return 5.5 + s * 1.5;
  }

  function hashSign(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return (h & 1) ? 1 : -1;
  }

  // Deterministic pseudo-random so the layout is stable between reloads.
  function seeded(i) {
    const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  function seedPositions() {
    const clusters = graph.nodes.filter((n) => n.type === 'cluster');
    const R = 120 + clusters.length * 45;
    clusters.forEach((c, i) => {
      const a = (i / Math.max(1, clusters.length)) * Math.PI * 2 - Math.PI / 2;
      c.x = Math.cos(a) * R;
      c.y = Math.sin(a) * R;
    });
    graph.nodes.forEach((n, i) => {
      if (n.type === 'cluster') return;
      const parent = graph.adj.get(n.id).map((x) => x.node).find((m) => m.type === 'cluster');
      const ang = seeded(i) * Math.PI * 2;
      const dist = 60 + seeded(i + 99) * 80;
      const bx = parent ? parent.x : (seeded(i + 7) - 0.5) * R * 2;
      const by = parent ? parent.y : (seeded(i + 13) - 0.5) * R * 2;
      n.x = bx + Math.cos(ang) * dist;
      n.y = by + Math.sin(ang) * dist;
    });
  }

  // ---- Force simulation -----------------------------------------------------
  function tick() {
    const nodes = graph.nodes;
    const alpha = sim.alpha;
    const N = nodes.length;

    // Repulsion (n-body, O(n^2) is fine for a personal graph of a few hundred nodes)
    for (let i = 0; i < N; i++) {
      const a = nodes[i];
      const wa = a.type === 'cluster' ? 2.4 : 1;
      for (let j = i + 1; j < N; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > 640000) continue; // ignore beyond 800px
        if (d2 < 1) { dx = seeded(i + j) - 0.5; dy = seeded(i * j + 3) - 0.5; d2 = 1; }
        const wb = b.type === 'cluster' ? 2.4 : 1;
        const d = Math.sqrt(d2);
        const f = (1800 * wa * wb * alpha) / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;

        // Collision: keep discs apart
        const minD = a.r + b.r + 6;
        if (d < minD) {
          const push = ((minD - d) / d) * 0.5;
          a.x -= dx * push * 0.5; a.y -= dy * push * 0.5;
          b.x += dx * push * 0.5; b.y += dy * push * 0.5;
        }
      }
    }

    // Springs ("strings"): stronger strings are shorter and stiffer.
    for (const e of graph.edges) {
      const a = e.source, b = e.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const bothClusters = a.type === 'cluster' && b.type === 'cluster';
      const rest = a.r + b.r + (bothClusters ? 220 : 40) + (1 - e.strength) * (bothClusters ? 160 : 90);
      const k = (0.04 + 0.1 * e.strength) * alpha;
      const f = ((d - rest) / d) * k;
      const bias = b.degree / (a.degree + b.degree || 1);
      a.vx += dx * f * bias; a.vy += dy * f * bias;
      b.vx -= dx * f * (1 - bias); b.vy -= dy * f * (1 - bias);
    }

    // Gentle gravity toward the origin + integrate
    for (const n of nodes) {
      n.vx -= n.x * 0.006 * alpha;
      n.vy -= n.y * 0.006 * alpha;
      if (n.fx != null) {
        n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0;
        continue;
      }
      n.vx *= 0.62;
      n.vy *= 0.62;
      n.x += n.vx;
      n.y += n.vy;
    }

    sim.alpha += (sim.alphaTarget - sim.alpha) * 0.02;
  }

  function startSim() {
    if (sim.running) return;
    sim.running = true;
    requestRender();
  }

  // ---- Rendering --------------------------------------------------------------
  let rafId = 0;
  function requestRender() {
    needsDraw = true;
    if (viewMode !== '2d') return; // 2D loop is parked while the 3D universe is active
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  // Filter 2D graph by hidden node types (from mobile legend).
  window.apply2dTypeFilter = function() {
    if (!window._hiddenTypes) window._hiddenTypes = new Set();
    // The 2D renderer checks node visibility in the draw loop.
    // Store the filter and trigger a re-render.
    requestRender();
  };

  function frame(t) {
    rafId = 0;
    if (viewMode !== '2d') return;
    if (viewAnim) stepViewAnim(t);
    if (sim.running) {
      tick();
      if (sim.alpha < 0.004 && sim.alphaTarget === 0) sim.running = false;
      needsDraw = true;
    }
    if (needsDraw) {
      needsDraw = false;
      draw();
    }
    if (sim.running || viewAnim) rafId = requestAnimationFrame(frame);
  }

  function resize() {
    view.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    view.w = window.innerWidth;
    view.h = window.innerHeight;
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    requestRender();
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const RGB = Object.fromEntries(Object.entries(TYPE_COLORS).map(([k, v]) => [k, hexToRgb(v)]));
  RGB.unknown = hexToRgb(UNKNOWN_COLOR);
  const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

  function draw() {
    const { dpr, k, tx, ty } = view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawBackdrop();

    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);

    const focus = hovered || selected;
    const focusSet = new Set();
    if (focus) {
      focusSet.add(focus.id);
      for (const { node } of graph.adj.get(focus.id) || []) focusSet.add(node.id);
    }

    // Strings
    ctx.lineCap = 'round';
    for (const e of graph.edges) {
      const a = e.source, b = e.target;
      const inFocus = focus && (a === focus || b === focus);
      const dim = focus && !inFocus;
      const dx = b.x - a.x, dy = b.y - a.y;
      const bend = 0.1 * e.bend;
      const cx = (a.x + b.x) / 2 - dy * bend;
      const cy = (a.y + b.y) / 2 + dx * bend;

      const ca = RGB[a.type], cb = RGB[b.type];
      const baseAlpha = dim ? 0.05 : inFocus ? 0.85 : 0.14 + 0.36 * e.strength;
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, rgba(ca, baseAlpha));
      grad.addColorStop(1, rgba(cb, baseAlpha));
      ctx.strokeStyle = grad;
      ctx.lineWidth = (0.6 + 2.2 * e.strength) * (inFocus ? 1.4 : 1) / Math.sqrt(Math.max(k, 0.3));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();
    }

    // Nodes: glow halo + core
    for (const n of graph.nodes) {
      // Skip hidden types (mobile legend filter).
      if (window._hiddenTypes && window._hiddenTypes.has(n.type)) continue;
      const rgb = RGB[n.type];
      const dim = focus && !focusSet.has(n.id);
      const isFocus = n === focus;
      const glowR = n.r * (n.type === 'cluster' ? 3.4 : 3.0) * (isFocus ? 1.25 : 1);

      const halo = ctx.createRadialGradient(n.x, n.y, n.r * 0.5, n.x, n.y, glowR);
      halo.addColorStop(0, rgba(rgb, dim ? 0.05 : isFocus ? 0.45 : 0.22));
      halo.addColorStop(1, rgba(rgb, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
      ctx.fill();

      const core = ctx.createRadialGradient(n.x - n.r * 0.35, n.y - n.r * 0.35, n.r * 0.1, n.x, n.y, n.r);
      const lighter = rgb.map((c) => Math.min(255, c + 70));
      core.addColorStop(0, rgba(lighter, dim ? 0.25 : 1));
      core.addColorStop(1, rgba(rgb, dim ? 0.2 : 0.95));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();

      if (n === selected) {
        // Hover wins over the pin: keep the pinned ring, but subtle when outside the hover ego set.
        ctx.strokeStyle = focusSet.has(n.id) ? 'rgba(110,231,255,0.9)' : 'rgba(110,231,255,0.35)';
        ctx.lineWidth = 2 / k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 5 / k, 0, Math.PI * 2);
        ctx.stroke();
      } else if (n === hovered) {
        ctx.strokeStyle = 'rgba(110,231,255,0.45)';
        ctx.lineWidth = 1.5 / k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3 / k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Labels in screen space (crisp at any zoom)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    for (const n of graph.nodes) {
      const inFocus = focusSet.has(n.id);
      const show = n.type === 'cluster' || k > 1.05 || inFocus;
      if (!show) continue;
      if (focus && !inFocus && n.type !== 'cluster') continue;
      const sx = n.x * k + tx;
      const sy = n.y * k + ty;
      if (sx < -200 || sx > view.w + 200 || sy < -50 || sy > view.h + 50) continue;
      const isCluster = n.type === 'cluster';
      const size = isCluster ? 13.5 : 11.5;
      ctx.font = `${isCluster ? 650 : 500} ${size}px ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, sans-serif`;
      const dim = focus && !inFocus;
      const label = n.label.length > 42 ? n.label.slice(0, 40) + '…' : n.label;
      const y = sy + n.r * k + 6;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(7,8,13,0.85)';
      ctx.strokeText(label, sx, y);
      ctx.fillStyle = dim ? 'rgba(233,234,242,0.3)' : isCluster ? 'rgba(244,244,250,0.96)' : 'rgba(200,203,220,0.9)';
      ctx.fillText(label, sx, y);
    }
  }

  // Faint dot grid in world space gives a sense of pan/zoom.
  function drawBackdrop() {
    const { dpr, k, tx, ty, w, h } = view;
    let step = 60 * k;
    while (step < 28) step *= 2;
    while (step > 120) step /= 2;
    const ox = ((tx % step) + step) % step;
    const oy = ((ty % step) + step) % step;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(110,231,255,0.05)';
    for (let x = ox; x < w; x += step) {
      for (let y = oy; y < h; y += step) {
        ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      }
    }
  }

  // ---- View transforms --------------------------------------------------------
  const MIN_K = 0.12, MAX_K = 4;

  function screenToWorld(sx, sy) {
    return { x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k };
  }

  function zoomAt(sx, sy, factor) {
    const k2 = clamp(view.k * factor, MIN_K, MAX_K);
    const f = k2 / view.k;
    view.tx = sx - (sx - view.tx) * f;
    view.ty = sy - (sy - view.ty) * f;
    view.k = k2;
    viewAnim = null;
    requestRender();
  }

  function computeFit() {
    if (!graph.nodes.length) return { k: 1, tx: view.w / 2, ty: view.h / 2 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of graph.nodes) {
      minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r + 20);
    }
    const padTop = 90, padBottom = 70, padX = 40;
    const aw = Math.max(100, view.w - padX * 2);
    const ah = Math.max(100, view.h - padTop - padBottom);
    const k = clamp(Math.min(aw / (maxX - minX || 1), ah / (maxY - minY || 1)), MIN_K, 1.6);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    return { k, tx: view.w / 2 - cx * k, ty: padTop + ah / 2 - cy * k };
  }

  function fitView(animate = true) {
    animateViewTo(computeFit(), animate);
  }

  function animateViewTo(target, animate = true) {
    if (!animate || reducedMotion) {
      Object.assign(view, target);
      viewAnim = null;
      requestRender();
      return;
    }
    viewAnim = { from: { k: view.k, tx: view.tx, ty: view.ty }, to: target, start: performance.now(), dur: 450 };
    requestRender();
  }

  function stepViewAnim(t) {
    const a = viewAnim;
    const p = clamp((t - a.start) / a.dur, 0, 1);
    const e = 1 - Math.pow(1 - p, 3);
    view.k = a.from.k + (a.to.k - a.from.k) * e;
    view.tx = a.from.tx + (a.to.tx - a.from.tx) * e;
    view.ty = a.from.ty + (a.to.ty - a.from.ty) * e;
    needsDraw = true;
    if (p >= 1) viewAnim = null;
  }

  function centerOn(node) {
    const k = Math.max(view.k, 0.9);
    const panelOffset = window.innerWidth > 640 && !$('#node-panel').hidden ? 170 : 0;
    animateViewTo({ k, tx: (view.w - panelOffset) / 2 - node.x * k, ty: view.h / 2 - node.y * k });
  }

  function nodeAt(sx, sy) {
    const p = screenToWorld(sx, sy);
    const slop = 6 / view.k;
    for (let i = graph.nodes.length - 1; i >= 0; i--) {
      const n = graph.nodes[i];
      const dx = n.x - p.x, dy = n.y - p.y;
      const r = n.r + slop;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  // ---- Pointer interaction: pan, drag nodes, pinch zoom ----------------------
  const pointers = new Map();
  let gesture = null; // {mode: 'pan'|'node'|'pinch', ...}

  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    canvas.setPointerCapture(e.pointerId);
    const p = localPoint(e);
    pointers.set(e.pointerId, p);

    if (pointers.size === 2) {
      releaseDraggedNode();
      const [p1, p2] = [...pointers.values()];
      gesture = {
        mode: 'pinch',
        dist: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1,
        mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      };
      return;
    }
    if (pointers.size > 2) return;

    viewAnim = null;
    const n = nodeAt(p.x, p.y);
    if (n) {
      gesture = { mode: 'node', node: n, start: p, moved: false };
      canvas.classList.add('dragging-node');
    } else {
      gesture = { mode: 'pan', start: p, last: p, moved: false };
      canvas.classList.add('panning');
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = localPoint(e);
    if (!pointers.has(e.pointerId)) {
      // Plain hover
      const n = nodeAt(p.x, p.y);
      if (n !== hovered) {
        hovered = n;
        canvas.classList.toggle('over-node', !!n);
        requestRender();
      }
      return;
    }
    pointers.set(e.pointerId, p);
    if (!gesture) return;

    if (gesture.mode === 'pinch' && pointers.size >= 2) {
      const [p1, p2] = [...pointers.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      view.tx += mid.x - gesture.mid.x;
      view.ty += mid.y - gesture.mid.y;
      zoomAt(mid.x, mid.y, dist / gesture.dist);
      gesture.dist = dist;
      gesture.mid = mid;
      return;
    }

    if (gesture.mode === 'node') {
      if (!gesture.moved && Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > 4) {
        gesture.moved = true;
        sim.alphaTarget = 0.25;
        sim.alpha = Math.max(sim.alpha, 0.3);
        startSim();
      }
      if (gesture.moved) {
        const w = screenToWorld(p.x, p.y);
        gesture.node.fx = w.x;
        gesture.node.fy = w.y;
        requestRender();
      }
      return;
    }

    if (gesture.mode === 'pan') {
      if (Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > 4) gesture.moved = true;
      view.tx += p.x - gesture.last.x;
      view.ty += p.y - gesture.last.y;
      gesture.last = p;
      requestRender();
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    const g = gesture;

    if (g && g.mode === 'pinch') {
      if (pointers.size === 1) {
        // Continue as a pan with the remaining finger.
        const p = [...pointers.values()][0];
        gesture = { mode: 'pan', start: p, last: p, moved: true };
      } else if (pointers.size === 0) {
        gesture = null;
      }
      return;
    }
    if (pointers.size > 0) return;

    canvas.classList.remove('panning', 'dragging-node');
    if (g && e.type === 'pointerup') {
      if (g.mode === 'node' && !g.moved) selectNode(g.node);
      else if (g.mode === 'pan' && !g.moved) selectNode(null);
    }
    releaseDraggedNode();
    gesture = null;
  }

  function releaseDraggedNode() {
    if (gesture && gesture.mode === 'node') {
      gesture.node.fx = null;
      gesture.node.fy = null;
      sim.alphaTarget = 0;
      startSim();
    }
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => {
    if (!pointers.size && hovered) {
      hovered = null;
      canvas.classList.remove('over-node');
      requestRender();
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localPoint(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= view.h;
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
    zoomAt(p.x, p.y, factor);
  }, { passive: false });

  // Safari trackpad pinch
  let gestureScale = 1;
  canvas.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; });
  canvas.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const p = localPoint(e);
    zoomAt(p.x, p.y, e.scale / gestureScale);
    gestureScale = e.scale;
  });

  $('#zoom-in').addEventListener('click', () => zoomAt(view.w / 2, view.h / 2, 1.3));
  $('#zoom-out').addEventListener('click', () => zoomAt(view.w / 2, view.h / 2, 1 / 1.3));
  $('#zoom-fit').addEventListener('click', () => fitView(true));

  // ---- Node details panel -----------------------------------------------------
  function selectNode(n) {
    selected = n;
    requestRender();
    const panel = $('#node-panel');
    if (!n) { panel.hidden = true; return; }

    const color = TYPE_COLORS[n.type] || UNKNOWN_COLOR;
    const typeEl = $('#node-type');
    typeEl.textContent = '';
    typeEl.append(el('i', { class: 'dot dot-' + n.type }), n.type);
    $('#node-title').textContent = n.label;
    $('#node-count').textContent = nf.format(n.size);
    $('#node-degree').textContent = nf.format(n.degree);
    typeEl.style.color = color;

    const list = $('#node-neighbors');
    list.textContent = '';
    const neighbors = [...(graph.adj.get(n.id) || [])].sort((a, b) => b.strength - a.strength || a.node.label.localeCompare(b.node.label));
    for (const { node: m, strength } of neighbors) {
      const bar = el('i');
      bar.style.width = Math.round(strength * 100) + '%';
      const btn = el('button', {
        type: 'button',
        title: 'String strength ' + Math.round(strength * 100) + '%',
        onclick: () => { selectNode(m); centerOn(m); },
      },
        el('i', { class: 'dot dot-' + m.type }),
        el('span', { class: 'n-label' }, m.label, el('small', { text: m.type })),
        el('span', { class: 'strength', 'aria-label': 'strength ' + Math.round(strength * 100) + '%' }, bar),
      );
      list.append(el('li', {}, btn));
    }
    $('#node-empty').hidden = neighbors.length > 0;
    panel.hidden = false;
  }

  $('#close-node').addEventListener('click', () => selectNode(null));

  window.addEventListener('resize', () => { resize(); });

  // ===========================================================================
  // DUMP PANEL
  // ===========================================================================
  const dump = {
    files: [],        // [{id, file, name, kind, status, progress, error}]
    uploading: false,
    session: null,    // {folder, noteDone, slug} so a failed upload can be retried into the same folder
    nextId: 1,
  };

  const textEl = $('#dump-text');
  const fileInput = $('#file-input');
  const dropzone = $('#dropzone');

  function openDump() {
    $('#dump-panel').hidden = false;
    $('#dump-scrim').hidden = false;
    refreshTokenWarning();
    if (!$('#dump-form-wrap').hidden) setTimeout(() => textEl.focus(), 50);
  }
  function closeDump() {
    $('#dump-panel').hidden = true;
    $('#dump-scrim').hidden = true;
    $('#open-dump').focus();
  }
  $('#open-dump').addEventListener('click', openDump);
  $('#close-dump').addEventListener('click', closeDump);
  $('#dump-scrim').addEventListener('click', () => { if (!dump.uploading) closeDump(); });
  $('#dump-open-settings').addEventListener('click', openSettings);

  // ---- Sync now ---------------------------------------------------------------
  // On-demand sync triggered DIRECTLY from the portal: dispatches the
  // sync-now GitHub Actions workflow, then polls its run status with a
  // progress dial. No cron polling — the pipeline starts immediately.
  $('#sync-now').addEventListener('click', async () => {
    const token = getToken();
    if (!token) { toast('Add your GitHub token in Settings first.', 'err'); openSettings(); return; }
    const btn = $('#sync-now');
    if (btn.disabled) return;
    btn.disabled = true;
    const label = btn.querySelector('span');
    const origLabel = label.textContent;

    const api = (path, opts = {}) => guardedFetch(CONFIG.apiBase + path, {
      ...opts,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        ...(opts.headers || {}),
      },
    });

    // Get current node count for diffing.
    async function getNodeCount() {
      try {
        const res = await fetch(CONFIG.graphUrl, { cache: 'no-store' });
        if (!res.ok) return null;
        const data = await res.json();
        return {
          count: data.nodes ? data.nodes.length : 0,
          ids: new Set((data.nodes || []).map((n) => n.id)),
        };
      } catch { return null; }
    }

    try {
      // 0. Snapshot before.
      label.textContent = 'Starting…';
      if (window.BrainUniverse && window.BrainUniverse.setSyncDial) { try { window.BrainUniverse.setSyncDial(5, 'Force sync starting…', true); } catch (e) { /* never break sync */ } }
      // DYNAMIC UI v1: show the harvest happening — a sweep leaves the core.
      if (window.BrainUniverse && window.BrainUniverse.syncSweep) { try { window.BrainUniverse.syncSweep(); } catch (e) { /* never break sync */ } }
      const before = await getNodeCount();

      // 1. Dispatch the workflow directly.
      const disp = await api('/repos/Vrdevil44/dream-brain/actions/workflows/sync.yml/dispatches', {
        method: 'POST',
        body: JSON.stringify({ ref: 'master', inputs: { force: 'true' } }), // sync dial v2: the portal button bypasses the peek gate
      });
      if (!disp.ok) throw new Error('GitHub API ' + disp.status);

      // 2. Find the run we just triggered.
      btn.classList.add('syncing');
      let runId = null;
      for (let i = 0; i < 6 && !runId; i++) {
        label.textContent = 'Queued…';
        if (window.BrainUniverse && window.BrainUniverse.setSyncDial) { try { window.BrainUniverse.setSyncDial(10, 'Sync queued on GitHub…', true); } catch (e) { /* never break sync */ } }
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const runs = await api('/repos/Vrdevil44/dream-brain/actions/workflows/sync.yml/runs?per_page=5');
          if (runs.ok) {
            const data = await runs.json();
            const run = data.workflow_runs && data.workflow_runs[0];
            if (run) runId = run.id;
          }
        } catch { /* retry */ }
      }
      if (!runId) throw new Error('Could not find the triggered run');

      // 3. Poll jobs for step-by-step progress.
      const deadline = Date.now() + 10 * 60 * 1000;
      let status = '', conclusion = '';
      const seenSteps = new Set();
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const jobsRes = await api(`/repos/Vrdevil44/dream-brain/actions/runs/${runId}/jobs`);
          if (!jobsRes.ok) continue;
          const jobsData = await jobsRes.json();
          const job = (jobsData.jobs || [])[0];
          if (!job) continue;

          status = job.status;
          conclusion = job.conclusion;

          // Show current step.
          const steps = job.steps || [];
          const current = steps.find((s) => s.status === 'in_progress');
          const completed = steps.filter((s) => s.status === 'completed').length;
          const dial = (pct, words) => { if (window.BrainUniverse && window.BrainUniverse.setSyncDial) { try { window.BrainUniverse.setSyncDial(pct, words, true); } catch (e) { /* never break sync */ } } };
          if (current) {
            if (!seenSteps.has(current.name)) {
              seenSteps.add(current.name);
            }
            label.textContent = `${completed + 1}/${steps.length}: ${current.name.slice(0, 24)}…`;
            dial(steps.length ? Math.round((completed / steps.length) * 100) : 0, current.name);
          } else if (status === 'in_progress') {
            label.textContent = `Syncing… ${completed}/${steps.length} steps`;
            dial(steps.length ? Math.round((completed / steps.length) * 100) : 0, 'Syncing…');
          }

          if (status === 'completed') break;
        } catch { /* keep polling */ }
      }
      btn.classList.remove('syncing');
      // The HUD dial lands at 100% with the outcome in words, then hands back
      // to the relay's live sync face after 10s.
      const dialDone = (words) => {
        if (window.BrainUniverse && window.BrainUniverse.setSyncDial) { try { window.BrainUniverse.setSyncDial(100, words, false); } catch (e) { /* never break sync */ } }
        setTimeout(() => { if (window.BrainUniverse && window.BrainUniverse.releaseSyncDial) { try { window.BrainUniverse.releaseSyncDial(); } catch (e) { /* noop */ } } }, 10000);
      };

      if (status === 'completed' && conclusion === 'success') {
        // 4. Diff nodes.
        await new Promise((r) => setTimeout(r, 3000)); // Let Pages rebuild.
        const after = await getNodeCount();
        let newIds = [];
        if (before && after) {
          newIds = [...after.ids].filter((id) => !before.ids.has(id));
          const diff = after.count - before.count;
          if (diff > 0) {
            toast(`Sync complete: ${diff} new node${diff === 1 ? '' : 's'} added.`, 'ok');
            dialDone(`Sync complete: ${diff} new node${diff === 1 ? '' : 's'} added`);
            // Mark fresh for 60s glow.
            if (window.BrainUniverse && window.BrainUniverse.markFresh) {
              window.BrainUniverse.markFresh(newIds);
            }
            // DYNAMIC UI v1: the harvest lands visibly — streaks + truthful ticker.
            if (window.BrainUniverse && window.BrainUniverse.syncDone) { try { window.BrainUniverse.syncDone(diff, newIds); } catch (e) { /* never break sync */ } }
            // Reload graph to show new nodes.
            loadGraph();
            loadUpdatesLog();
          } else {
            toast('Sync complete: no new nodes.', 'ok');
            dialDone('Sync complete: no new nodes');
            if (window.BrainUniverse && window.BrainUniverse.syncDone) { try { window.BrainUniverse.syncDone(0, []); } catch (e) { /* never break sync */ } }
          }
        } else {
          toast('Sync complete.', 'ok');
          dialDone('Sync complete');
        }
      } else if (status === 'completed') {
        toast('Sync finished: ' + conclusion, 'err');
        dialDone('Sync finished: ' + conclusion);
      } else {
        toast('Sync still running — check Actions on GitHub.', 'ok');
        dialDone('Sync still running — check Actions on GitHub');
      }
    } catch (err) {
      btn.classList.remove('syncing');
      if (window.BrainUniverse && window.BrainUniverse.releaseSyncDial) { try { window.BrainUniverse.releaseSyncDial(); } catch (e) { /* noop */ } }
      toast('Sync failed: ' + err.message, 'err');
    } finally {
      label.textContent = origLabel;
      btn.disabled = false;
    }
  });

  function refreshTokenWarning() {
    $('#dump-token-warning').hidden = !!getToken();
  }

  // ---- Text counter -----------------------------------------------------------
  function updateCounter() {
    const len = textEl.value.length;
    const c = $('#text-counter');
    c.textContent = nf.format(len) + ' / ' + nf.format(MAX_TEXT);
    c.classList.toggle('warn', len >= MAX_TEXT * 0.9 && len <= MAX_TEXT);
    c.classList.toggle('over', len > MAX_TEXT);
    $('#text-error').textContent = len >= MAX_TEXT ? 'You\'ve hit the 50,000 character limit. Split the rest into another dump.' : '';
  }
  textEl.addEventListener('input', () => { updateCounter(); clearSubmitError(); invalidateSession(); });

  // ---- File validation ----------------------------------------------------------
  function sanitizeFilename(raw) {
    // Strip any path components (both separators), control chars and unsafe characters.
    let name = String(raw || '').split(/[\\/]/).pop();
    name = name.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    name = name.replace(/[\u0000-\u001f\u007f]/g, '');
    name = name.replace(/[^A-Za-z0-9._-]+/g, '-');
    name = name.replace(/-+/g, '-').replace(/\.{2,}/g, '.');
    name = name.replace(/^[-.]+/, '').replace(/[-.]+$/, '');

    const dot = name.lastIndexOf('.');
    let base = dot > 0 ? name.slice(0, dot) : name;
    let ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    base = base.replace(/[-.]+$/, '') || 'file';
    if (ext.length > 10) ext = ext.slice(0, 10);
    const maxBase = MAX_NAME_LEN - (ext ? ext.length + 1 : 0);
    if (base.length > maxBase) base = base.slice(0, maxBase).replace(/[-.]+$/, '') || 'file';
    return ext ? base + '.' + ext : base;
  }

  function extensionsOf(name) {
    const parts = String(name).toLowerCase().split(/[\\/]/).pop().split('.');
    return parts.length > 1 ? parts.slice(1) : [];
  }

  function validateFile(file) {
    const display = String(file.name || 'file').split(/[\\/]/).pop();
    const exts = extensionsOf(display);
    const ext = exts[exts.length - 1] || '';

    if (exts.some((x) => BLOCKED.has(x))) {
      const bad = exts.find((x) => BLOCKED.has(x));
      return display + ': .' + bad + ' files are executables and are blocked for safety.';
    }
    if (!ext) return display + ': files need an extension so the organizer knows what they are.';
    if (!EXT_KIND[ext]) {
      return display + ': .' + ext + ' isn\'t supported. Allowed: images, video (mp4, webm, mov), audio (mp3, wav, m4a, ogg), documents (pdf, txt, md, doc, docx, csv) and zip.';
    }
    if (file.size === 0) return display + ' is empty (0 bytes).';
    if (file.size > MAX_FILE_BYTES) {
      return display + ' is ' + formatBytes(file.size) + '. The limit is 25 MB per file.';
    }
    return '';
  }

  function addFiles(fileList) {
    if (dump.uploading) return;
    const errors = [];
    const incoming = [...fileList];
    const skippedForLimit = [];

    for (const file of incoming) {
      const err = validateFile(file);
      if (err) { errors.push(err); continue; }
      const dup = dump.files.some((f) => f.file.name === file.name && f.file.size === file.size && f.file.lastModified === file.lastModified);
      if (dup) { errors.push(file.name + ' is already added.'); continue; }
      if (dump.files.length >= MAX_FILES) { skippedForLimit.push(file.name); continue; }
      const ext = extensionsOf(file.name).pop();
      dump.files.push({
        id: dump.nextId++,
        file,
        name: sanitizeFilename(file.name),
        kind: EXT_KIND[ext],
        status: 'ready',
        progress: 0,
        error: '',
      });
    }
    if (skippedForLimit.length) {
      errors.push('You can add up to ' + MAX_FILES + ' files per dump. Skipped: ' + skippedForLimit.join(', ') + '.');
    }
    dedupeNames();
    invalidateSession();
    renderFileErrors(errors);
    renderFiles();
    clearSubmitError();
  }

  // Make sanitized names unique within this dump (and never clash with note.md).
  function dedupeNames() {
    const used = new Set(['note.md']);
    for (const f of dump.files) {
      let name = f.name;
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let i = 2;
      while (used.has(name.toLowerCase())) name = base.slice(0, MAX_NAME_LEN - ext.length - 3) + '-' + i++ + ext;
      f.name = name;
      used.add(name.toLowerCase());
    }
  }

  function renderFileErrors(errors) {
    const ul = $('#file-errors');
    ul.textContent = '';
    for (const msg of errors) ul.append(el('li', { text: msg }));
  }

  function renderFiles() {
    const ul = $('#file-list');
    ul.textContent = '';
    for (const f of dump.files) {
      const bar = el('i');
      bar.style.width = Math.round(f.progress * 100) + '%';
      let sub = formatBytes(f.file.size);
      let subClass = 'file-sub';
      if (f.status === 'encoding') sub = 'Preparing…';
      if (f.status === 'uploading') sub = 'Uploading ' + Math.round(f.progress * 100) + '%';
      if (f.status === 'done') { sub = 'Uploaded'; subClass += ' ok'; }
      if (f.status === 'failed') { sub = f.error || 'Upload failed'; subClass += ' err'; }
      if (f.status === 'skipped') { sub = 'Not sent'; }

      const kindLabel = (extensionsOf(f.name).pop() || '').slice(0, 4);
      const removeBtn = el('button', {
        class: 'btn btn-icon btn-ghost file-remove',
        type: 'button',
        'aria-label': 'Remove ' + f.name,
        disabled: dump.uploading || f.status === 'done',
        onclick: () => {
          dump.files = dump.files.filter((x) => x !== f);
          invalidateSession();
          renderFiles();
        },
      }, svgIcon('M6 6l12 12M18 6L6 18'));

      const li = el('li', { class: 'file-item ' + f.status, 'data-id': f.id },
        el('span', { class: 'file-kind k-' + f.kind, text: kindLabel }),
        el('div', { class: 'file-meta' },
          el('div', { class: 'file-name', title: f.name, text: f.name }),
          el('div', { class: subClass, text: sub }),
        ),
        removeBtn,
        f.status !== 'ready' ? el('div', { class: 'progress' }, bar) : null,
      );
      ul.append(li);
    }
    dropzone.classList.toggle('disabled', dump.uploading || dump.files.length >= MAX_FILES);
    // When files are present, the text area is their comment — make that explicit.
    const hasFiles = dump.files.length > 0;
    $('#dump-text-label').textContent = hasFiles ? 'Comment for these files' : 'Notes & links';
    $('#dump-comment-hint').hidden = !hasFiles;
    textEl.placeholder = hasFiles
      ? 'What are these files about? The brain files them using your words…'
      : 'Brain-dump anything: ideas, targets, progress, links…';
  }

  function updateFileProgress(f) {
    // Cheap in-place update during upload instead of re-rendering the list.
    const li = document.querySelector('.file-item[data-id="' + f.id + '"]');
    if (!li) return renderFiles();
    const bar = li.querySelector('.progress i');
    const sub = li.querySelector('.file-sub');
    if (!bar || !sub) return renderFiles();
    bar.style.width = Math.round(f.progress * 100) + '%';
    if (f.status === 'uploading') sub.textContent = 'Uploading ' + Math.round(f.progress * 100) + '%';
  }

  // ---- Drag and drop ------------------------------------------------------------
  // Stop the browser from navigating away if a file is dropped outside the zone.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  let dragDepth = 0;
  dropzone.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropzone.classList.remove('drag-over'); });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  dropzone.addEventListener('click', () => { if (!dump.uploading) fileInput.click(); });
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!dump.uploading) fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  // ---- Submit ---------------------------------------------------------------------
  function clearSubmitError() { $('#submit-error').textContent = ''; }
  function showSubmitError(msg) { $('#submit-error').textContent = msg; }

  // Any edit after a partial failure starts a fresh dump folder on the next submit.
  function invalidateSession() {
    if (dump.uploading) return;
    dump.session = null;
    for (const f of dump.files) if (f.status !== 'ready') { f.status = 'ready'; f.progress = 0; f.error = ''; }
  }

  function pad(n, w = 2) { return String(n).padStart(w, '0'); }

  function timestamp(d = new Date()) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function slugify(s) {
    const slug = String(s || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/https?:\/\/(www\.)?/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-').filter(Boolean).slice(0, 6).join('-')
      .slice(0, 40)
      .replace(/-+$/, '');
    return slug || 'dump';
  }

  function encodePath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result);
        resolve(s.slice(s.indexOf(',') + 1));
      };
      reader.onerror = () => reject(new Error('Couldn\'t read the file from disk.'));
      reader.readAsDataURL(file);
    });
  }

  function apiErrorMessage(status, body, opts) {
    const msg = body && body.message ? String(body.message) : '';
    if (status === 0) return 'Network error. Check your connection and try again.';
    if (status === 401) return 'GitHub rejected this token — it expired or was revoked. Paste a new one.';
    if (status === 403) {
      if (/rate limit/i.test(msg)) return 'GitHub rate limit hit. Wait a few minutes and retry.';
      if (status === 403 && opts && opts.test) return 'GitHub refused the token (403): rate limit, or it is missing a permission. Check it has Contents: Read and write on about-vibhu.';
      return 'The token doesn\'t have write access (403). It needs Contents: Read and write on about-vibhu.';
    }
    if (status === 404) return 'Repo not found (404). The token can\'t see Vrdevil44/about-vibhu.';
    if (status === 409) return 'GitHub reported a conflict (409). Try again in a moment.';
    if (status === 413) return 'The file is too large for the GitHub API.';
    if (status === 422) return 'GitHub refused the file (422)' + (msg ? ': ' + msg : '.');
    return 'GitHub error ' + status + (msg ? ': ' + msg : '');
  }

  // PUT a file through the Contents API with upload progress (XHR has upload events, fetch doesn't).
  function putContent(token, path, base64, message, onProgress) {
    const url = CONFIG.apiBase + '/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/contents/' + encodePath(path);
    assertAllowedRequest(url, 'PUT');
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      const headers = githubHeaders(token);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        const body = xhr.response;
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else {
          const err = new Error(apiErrorMessage(xhr.status, body));
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = () => { const err = new Error(apiErrorMessage(0)); err.status = 0; reject(err); };
      xhr.send(JSON.stringify({ message, content: base64 }));
    });
  }

  async function putWithRetry(token, path, base64, message, onProgress) {
    try {
      return await putContent(token, path, base64, message, onProgress);
    } catch (err) {
      // Back-to-back commits can race the branch head; one retry clears it.
      if (err.status === 409 || err.status === 0) {
        await new Promise((r) => setTimeout(r, 1200));
        return putContent(token, path, base64, message, onProgress);
      }
      throw err;
    }
  }

  function setUploading(on) {
    dump.uploading = on;
    const btn = $('#dump-submit');
    btn.disabled = on;
    btn.classList.toggle('loading', on);
    btn.querySelector('.label').textContent = on ? 'Sending…' : (dump.session ? 'Retry' : 'Send to brain');
    $('#dump-clear').disabled = on;
    $('#close-dump').disabled = on;
    textEl.readOnly = on;
    renderFiles();
  }

  async function submitDump() {
    if (dump.uploading) return;
    clearSubmitError();

    const token = getToken();
    if (!token) {
      showSubmitError('Add your GitHub token in Settings first. The graph works without it, but dumping needs it.');
      refreshTokenWarning();
      return;
    }
    const fmt = tokenFormatError(token);
    if (fmt) { showSubmitError('Saved token is invalid: ' + fmt); return; }

    const text = textEl.value;
    if (text.length > MAX_TEXT) { showSubmitError('The note is over 50,000 characters.'); return; }
    if (!text.trim() && !dump.files.length) {
      showSubmitError('Nothing to send yet. Write a note or add a file.');
      return;
    }
    if (dump.files.length > MAX_FILES) { showSubmitError('Too many files. The limit is ' + MAX_FILES + '.'); return; }
    // Re-validate right before sending, in case anything slipped through.
    for (const f of dump.files) {
      const err = validateFile(f.file);
      if (err) { showSubmitError(err); return; }
    }

    if (!dump.session) {
      const now = new Date();
      const slug = slugify(text.trim() ? text : (dump.files[0] && dump.files[0].name.replace(/\.[^.]+$/, '')));
      dump.session = { folder: CONFIG.dumpDir + '/' + timestamp(now) + '-' + slug, slug, created: now, noteDone: false, lastCommit: null };
    }
    const session = dump.session;

    setUploading(true);
    let failed = null;

    try {
      if (text.trim() && !session.noteDone) {
        const header = '<!-- dumped via second-brain portal at ' + session.created.toISOString() + ' -->\n\n';
        const res = await putWithRetry(token, session.folder + '/note.md', utf8ToBase64(header + text + '\n'), 'dump: ' + session.slug + ' (note)');
        session.noteDone = true;
        session.lastCommit = res && res.commit;
        // v3: when files are present, the text is their comment — save it
        // explicitly as comment.md so the ingest applies it as cmt:.
        if (dump.files.length) {
          await putWithRetry(token, session.folder + '/comment.md', utf8ToBase64(text + '\n'), 'dump: ' + session.slug + ' (comment)');
        }
      }

      for (const f of dump.files) {
        if (f.status === 'done') continue;
        f.status = 'encoding';
        f.progress = 0;
        f.error = '';
        renderFiles();
        try {
          const b64 = await fileToBase64(f.file);
          f.status = 'uploading';
          renderFiles();
          const res = await putWithRetry(token, session.folder + '/' + f.name, b64, 'dump: ' + session.slug + ' (' + f.name + ')', (p) => {
            f.progress = Math.min(p, 0.99);
            updateFileProgress(f);
          });
          f.status = 'done';
          f.progress = 1;
          session.lastCommit = res && res.commit;
          renderFiles();
        } catch (err) {
          f.status = 'failed';
          f.error = err.message;
          failed = err;
          renderFiles();
          break;
        }
      }
    } catch (err) {
      failed = err;
    }

    if (failed) {
      for (const f of dump.files) if (f.status === 'ready') f.status = 'skipped';
      setUploading(false);
      const sent = (session.noteDone ? 1 : 0) + dump.files.filter((f) => f.status === 'done').length;
      showSubmitError(failed.message + (sent ? ' ' + sent + ' item(s) were saved already; Retry sends only the rest into the same folder.' : ''));
      return;
    }

    setUploading(false);
    showSuccess(session);
  }

  function showSuccess(session) {
    const count = (session.noteDone ? 1 : 0) + dump.files.length;
    $('#success-detail').textContent = count + ' item' + (count === 1 ? '' : 's') + ' saved to ' + session.folder + '/';
    const link = $('#success-commit');
    const commit = session.lastCommit;
    const href = commit && commit.html_url && /^https:\/\/github\.com\//.test(commit.html_url)
      ? commit.html_url
      : 'https://github.com/' + CONFIG.owner + '/' + CONFIG.repo + '/commits';
    link.href = href;
    link.textContent = commit && commit.sha ? 'View commit ' + commit.sha.slice(0, 7) + ' on GitHub' : 'View commits on GitHub';
    $('#dump-form-wrap').hidden = true;
    $('#dump-success').hidden = false;
    toast('Dump saved to your brain', 'ok');
  }

  function resetDump() {
    textEl.value = '';
    dump.files = [];
    dump.session = null;
    updateCounter();
    renderFiles();
    renderFileErrors([]);
    clearSubmitError();
    $('#dump-submit .label').textContent = 'Send to brain';
    $('#dump-success').hidden = true;
    $('#dump-form-wrap').hidden = false;
  }

  $('#dump-submit').addEventListener('click', submitDump);
  $('#dump-clear').addEventListener('click', () => { if (!dump.uploading) resetDump(); });
  $('#dump-new').addEventListener('click', () => { resetDump(); textEl.focus(); });
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitDump(); }
  });

  // ===========================================================================
  // SETTINGS
  // ===========================================================================
  const tokenInput = $('#token-input');

  const EXPIRY_KEY = 'secondBrain.tokenExpiry';

  // Write/read/remove probe: tells us if this browser will really keep the token.
  function storageWorks() {
    try {
      const k = 'secondBrain.probe';
      localStorage.setItem(k, '1');
      const ok = localStorage.getItem(k) === '1';
      localStorage.removeItem(k);
      return ok;
    } catch { return false; }
  }

  function renderSession() {
    const sec = $('#device-section');
    sec.hidden = !lockWatch; // only when the published (encrypted) graph is in use
    if (sec.hidden) return;
    $('#session-status').textContent = sessionExpiresAt
      ? 'Remembered until ' + new Date(sessionExpiresAt).toLocaleString() + '. Anyone using this unlocked browser can open the portal.'
      : 'Not remembered: you type the password every time you open the portal.';
    $('#forget-device').hidden = !sessionExpiresAt;
    $('#idle-minutes').value = idleMinutes();
  }

  function renderTokenExpiry(iso) {
    const box = $('#token-expiry');
    if (!iso) { box.textContent = ''; box.className = 'connection'; return; }
    const d = new Date(iso);
    if (isNaN(d)) { box.textContent = ''; box.className = 'connection'; return; }
    const days = Math.ceil((d - Date.now()) / 86400000);
    box.textContent = 'Token expires on ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      (days <= 7 ? ' (' + (days > 0 ? days + ' day' + (days === 1 ? '' : 's') + ' left' : 'expired') + '). Make a new one soon.' : '.');
    box.className = 'connection ' + (days <= 7 ? 'err' : 'ok');
  }

  // GET /user with the token: OK + expiry date, or one distinct message per failure.
  // GitHub reports the expiry in the github-authentication-token-expiration
  // header; if the browser doesn't expose it we simply don't show a date.
  async function checkToken(t) {
    try {
      const res = await guardedFetch(CONFIG.apiBase + '/user', { headers: githubHeaders(t), cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, message: apiErrorMessage(res.status, body, { test: true }) };
      const exp = res.headers.get('github-authentication-token-expiration');
      const parsed = exp ? new Date(exp.replace(' UTC', 'Z').replace(' ', 'T')) : null;
      const iso = parsed && !isNaN(parsed) ? parsed.toISOString() : '';
      return { ok: true, login: body.login, expiry: iso };
    } catch (e) {
      return { ok: false, message: 'Couldn\'t reach GitHub (network error). Check your connection and try again.' };
    }
  }

  function openSettings() {
    tokenInput.value = getToken();
    $('#token-error').textContent = '';
    setConnection('', '');
    refreshBrainControls(); // S3 (D5): re-read the window flag + gate queue on every open
    let stored = '';
    try { stored = localStorage.getItem(EXPIRY_KEY) || ''; } catch { /* ignore */ }
    renderTokenExpiry(stored);
    $('#storage-warning').hidden = storageWorks();
    renderSession();
    $('#settings-modal').hidden = false;
    setTimeout(() => tokenInput.focus(), 30);
    const t = getToken();
    if (t) {
      checkToken(t).then((r) => {
        if (tokenInput.value.trim() !== t || $('#settings-modal').hidden) return;
        if (r.ok) {
          try { if (r.expiry) localStorage.setItem(EXPIRY_KEY, r.expiry); } catch { /* ignore */ }
          renderTokenExpiry(r.expiry);
          setConnection('Token OK' + (r.login ? ' (@' + r.login + ')' : '') + '.', 'ok');
        } else {
          setConnection(r.message, 'err');
        }
      });
    }
  }
  function closeSettings() {
    $('#settings-modal').hidden = true;
    tokenInput.type = 'password';
    $('#token-toggle').textContent = 'Show';
    $('#token-toggle').setAttribute('aria-pressed', 'false');
  }
  function refreshTokenDot() {
    $('#token-dot').classList.toggle('on', !!getToken());
    const tokenDotText = getToken() ? 'GitHub token connected' : 'GitHub token not connected';
    $('#token-dot').title = tokenDotText;
    $('#token-dot').setAttribute('aria-label', tokenDotText);
    $('#open-settings').title = getToken() ? 'Settings (token saved)' : 'Settings (no token)';
  }
  function setConnection(msg, kind) {
    const c = $('#connection-status');
    c.textContent = msg;
    c.className = 'connection' + (kind ? ' ' + kind : '');
  }

  $('#lock-now').addEventListener('click', lockNow);
  $('#forget-device').addEventListener('click', lockNow);
  $('#idle-minutes').addEventListener('change', (e) => {
    const v = clamp(parseInt(e.target.value, 10) || DEFAULT_IDLE_MIN, 1, 480);
    e.target.value = v;
    try { localStorage.setItem(IDLE_KEY, String(v)); } catch { /* ignore */ }
  });

  $('#open-settings').addEventListener('click', openSettings);
  $('#close-settings').addEventListener('click', closeSettings);
  $('#settings-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSettings(); });

  $('#token-toggle').addEventListener('click', () => {
    const show = tokenInput.type === 'password';
    tokenInput.type = show ? 'text' : 'password';
    $('#token-toggle').textContent = show ? 'Hide' : 'Show';
    $('#token-toggle').setAttribute('aria-pressed', String(show));
  });

  tokenInput.addEventListener('input', () => { $('#token-error').textContent = ''; setConnection('', ''); });

  $('#token-save').addEventListener('click', () => {
    const t = tokenInput.value.trim();
    const err = tokenFormatError(t);
    if (err) { $('#token-error').textContent = err; return; }
    if (!setToken(t)) { $('#token-error').textContent = 'Couldn\'t save: this browser is blocking localStorage.'; return; }
    try { localStorage.removeItem(EXPIRY_KEY); } catch { /* ignore */ }
    refreshTokenDot();
    refreshTokenWarning();
    toast('Token saved in this browser', 'ok');
    closeSettings();
  });

  $('#token-clear').addEventListener('click', () => {
    setToken('');
    try { localStorage.removeItem(EXPIRY_KEY); } catch { /* ignore */ }
    renderTokenExpiry('');
    tokenInput.value = '';
    refreshTokenDot();
    refreshTokenWarning();
    setConnection('Token removed from this browser.', '');
  });

  $('#token-test').addEventListener('click', async () => {
    const t = tokenInput.value.trim();
    const err = tokenFormatError(t);
    if (err) { $('#token-error').textContent = err; return; }
    const btn = $('#token-test');
    btn.disabled = true;
    btn.classList.add('loading');
    setConnection('Checking…', '');
    try {
      const r = await checkToken(t);
      if (r.ok) {
        renderTokenExpiry(r.expiry);
        setConnection('Connected as @' + r.login + '. Remember to Save.', 'ok');
      } else {
        setConnection(r.message, 'err');
      }
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  });

  tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#token-save').click(); });

  // ===========================================================================
  // S3 controls — keyboard shortcuts + Brain controls section
  // ===========================================================================
  // The ONE key map (D3). Every space-explorer binding lives here; the `?`
  // overlay renders from this const and there is no second list anywhere.
  // Key identity per D2: e.code for WASD/Q/E/F (physical positions,
  // AZERTY-safe), e.key for ?/+/- (layout dependent). D1: D = strafe-right,
  // never dump; U opens the dump panel ("Upload / dump (was D)").
  const BRAIN_KEYMAP = {
    ArrowUp:    { show: '↑',     group: 'Move',   action: 'fly-up',     label: 'Fly up' },
    ArrowDown:  { show: '↓',     group: 'Move',   action: 'fly-down',   label: 'Fly down' },
    ArrowLeft:  { show: '←',     group: 'Move',   action: 'fly-left',   label: 'Fly left' },
    ArrowRight: { show: '→',     group: 'Move',   action: 'fly-right',  label: 'Fly right' },
    KeyW:       { show: 'W',     group: 'Move',   action: 'fly-up',     label: 'Fly up' },
    KeyS:       { show: 'S',     group: 'Move',   action: 'fly-down',   label: 'Fly down' },
    KeyA:       { show: 'A',     group: 'Move',   action: 'fly-left',   label: 'Fly left' },
    KeyD:       { show: 'D',     group: 'Move',   action: 'fly-right',  label: 'Fly right' },
    KeyQ:       { show: 'Q',     group: 'Zoom',   action: 'zoom-out',   label: 'Zoom out' },
    KeyE:       { show: 'E',     group: 'Zoom',   action: 'zoom-in',    label: 'Zoom in' },
    '+':        { show: '+',     group: 'Zoom',   action: 'zoom-in',    label: 'Zoom in' },
    '=':        { show: '=',     group: 'Zoom',   action: 'zoom-in',    label: 'Zoom in' },
    '-':        { show: '−',     group: 'Zoom',   action: 'zoom-out',   label: 'Zoom out' },
    '_':        { show: '_',     group: 'Zoom',   action: 'zoom-out',   label: 'Zoom out' },
    KeyF:       { show: 'F',     group: 'Node',   action: 'focus-node', label: 'Focus the selected node' },
    'Enter':    { show: 'Enter', group: 'Node',   action: 'open-node',  label: 'Open the selected node' },
    'Tab':      { show: 'Tab',   group: 'Node',   action: 'walk-nodes', label: 'Walk nodes in relation order' },
    Escape:     { show: 'Esc',   group: 'Panels', action: 'go-back',    label: 'Close top panel · deselect' },
    '?':        { show: '?',     group: 'Panels', action: 'keymap',     label: 'Show this key map' },
    KeyU:       { show: 'U',     group: 'Panels', action: 'dump',       label: 'Upload / dump (was D)' },
  };
  // Shared with the 3D surface: universe.js reads window.BRAIN_KEYMAP.
  window.BRAIN_KEYMAP = BRAIN_KEYMAP;
  const FLY_ACTIONS = new Set(['fly-up', 'fly-down', 'fly-left', 'fly-right']);

  // ---- Held-key fly loop (B3): keydown/keyup set driven by rAF, never OS
  // key-repeat. Cleared on blur/hidden tab so the camera never drifts.
  const heldFly = new Set();
  let flyRaf = 0;
  function flyTick() {
    flyRaf = 0;
    if (!heldFly.size) return;
    const step = reducedMotion ? 10 : 34;
    let dx = 0, dy = 0;
    for (const a of heldFly) {
      if (a === 'fly-up') dy += step;
      else if (a === 'fly-down') dy -= step;
      else if (a === 'fly-left') dx += step;
      else if (a === 'fly-right') dx -= step;
    }
    if (dx || dy) { viewAnim = null; view.tx += dx; view.ty += dy; requestRender(); }
    flyRaf = requestAnimationFrame(flyTick);
  }
  function holdFly(action, on) {
    if (on) heldFly.add(action); else heldFly.delete(action);
    if (heldFly.size && !flyRaf) flyRaf = requestAnimationFrame(flyTick);
    else if (!heldFly.size && flyRaf) { cancelAnimationFrame(flyRaf); flyRaf = 0; }
  }
  function clearHeldFly() { heldFly.clear(); if (flyRaf) { cancelAnimationFrame(flyRaf); flyRaf = 0; } }
  window.addEventListener('keyup', (e) => {
    const entry = BRAIN_KEYMAP[e.code] || BRAIN_KEYMAP[e.key];
    if (entry && FLY_ACTIONS.has(entry.action)) holdFly(entry.action, false);
  });
  window.addEventListener('blur', clearHeldFly);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearHeldFly(); });

  // ---- D4 relation order: neighbours of the selected node in link order
  // (adjacency insertion order), then remaining nodes in stable build order.
  function relationOrder() {
    const order = [], seen = new Set();
    if (selected) {
      for (const { node } of (graph.adj.get(selected.id) || [])) {
        if (node && !seen.has(node.id)) { seen.add(node.id); order.push(node); }
      }
      seen.add(selected.id);
    }
    for (const n of graph.nodes) if (!seen.has(n.id)) { seen.add(n.id); order.push(n); }
    return order;
  }
  function walkNodes(e, dir) {
    const order = relationOrder();
    if (!order.length) return;
    const cur = selected ? order.findIndex((n) => n.id === selected.id) : -1;
    let next = null;
    if (dir > 0) {
      if (cur >= order.length - 1) return; // past the last node: native Tab order (no trap)
      next = order[cur + 1];
    } else {
      if (cur <= 0) return; // before the first node: native Shift+Tab order (no trap)
      next = order[cur - 1];
    }
    e.preventDefault();
    selectNode(next);
    centerOn(next);
    const g = $('#graph');
    if (g && typeof g.focus === 'function') g.focus({ preventScroll: true });
  }

  // ---- `?` key-map overlay (rendered from the ONE const, D3) ----
  function keymapIsOpen() { return !$('#keymap-overlay').hidden; }
  function openKeymap() {
    const list = $('#keymap-list');
    list.textContent = '';
    const groups = {};
    for (const k of Object.keys(BRAIN_KEYMAP)) {
      const info = BRAIN_KEYMAP[k];
      (groups[info.group] = groups[info.group] || []).push(info);
    }
    for (const g of ['Move', 'Zoom', 'Node', 'Panels']) {
      if (!groups[g]) continue;
      list.append(el('h3', { class: 'keymap-group' }, g));
      const ul = el('ul', { class: 'keymap-rows' });
      for (const r of groups[g]) {
        ul.append(el('li', {}, el('kbd', {}, r.show), el('span', {}, r.label)));
      }
      list.append(ul);
    }
    $('#keymap-overlay').hidden = false;
    $('#keymap-scrim').hidden = false;
  }
  function closeKeymap() {
    $('#keymap-overlay').hidden = true;
    $('#keymap-scrim').hidden = true;
  }
  $('#close-keymap').addEventListener('click', closeKeymap);
  $('#keymap-scrim').addEventListener('click', closeKeymap);

  // Bridge for the 3D surface's Esc chain (B5): universe.js calls these.
  window.__brainS3 = {
    keymapOpen: keymapIsOpen, openKeymap, closeKeymap,
    dumpOpen: () => !$('#dump-panel').hidden,
    dumpUploading: () => dump.uploading,
    closeDump, openDump,
    settingsOpen: () => !$('#settings-modal').hidden,
    closeSettings,
  };

  // ---- Brain controls: outward-window switch / gate queue / needs-you ----
  // Plain words, no jargon. The switch renders from the POST response body
  // (the truth, D5) and is never optimistic.
  const brainCtl = { window: null, checking: false }; // window: true/false = last confirmed; null = unknown
  function liveApi(path, opts) {
    const base = liveApiBase();
    if (!base || typeof fetch !== 'function') return Promise.reject(new Error('no live api'));
    return fetch(base + path, opts);
  }
  function renderWindowSwitch() {
    const btn = $('#window-switch'), note = $('#window-note');
    if (!btn) return;
    if (brainCtl.checking) {
      btn.disabled = true;
      btn.textContent = 'checking…';
      btn.setAttribute('aria-pressed', 'false');
      if (note) note.textContent = 'Asking the brain…';
      return;
    }
    btn.disabled = false;
    if (brainCtl.window === null) {
      btn.textContent = 'needs live connection';
      btn.setAttribute('aria-pressed', 'false');
      if (note) note.textContent = 'The brain is not reachable right now, so the switch shows nothing instead of a guess.';
    } else if (brainCtl.window) {
      btn.textContent = 'allowed';
      btn.setAttribute('aria-pressed', 'true');
      if (note) note.textContent = 'The brain is allowed to reach the outside world. Flip to take the permission away.';
    } else {
      btn.textContent = 'not allowed';
      btn.setAttribute('aria-pressed', 'false');
      if (note) note.textContent = 'The brain is not allowed to reach the outside world. Flip to allow it.';
    }
  }
  async function readWindowFlag() {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 3000);
      const res = await liveApi('/api/window', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      brainCtl.window = !!(body && body.enabled === true);
    } catch (err) {
      brainCtl.window = null; // unreachable: honesty, never a fake state
    }
    renderWindowSwitch();
  }
  async function flipWindow() {
    if (brainCtl.checking) return;
    const want = !(brainCtl.window === true);
    brainCtl.checking = true;
    renderWindowSwitch(); // disabled "checking…" while the write is in flight (D5)
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 3000); // D5: 3 s timeout
      const res = await liveApi('/api/window', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: want }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      brainCtl.window = !!(body && body.enabled === true); // D5: the POST response body is the truth
      const errEl = $('#window-error');
      if (errEl) errEl.textContent = '';
    } catch (err) {
      // D5: a failed or timed-out POST keeps the last confirmed state + plain-words error.
      const errEl = $('#window-error');
      if (errEl) {
        errEl.textContent = (err && err.name === 'AbortError')
          ? 'The brain did not answer in time. The switch still shows the last confirmed state.'
          : 'Could not reach the brain. The switch still shows the last confirmed state.';
      }
    } finally {
      brainCtl.checking = false;
      renderWindowSwitch();
    }
  }
  async function readGateQueue() {
    const list = $('#gate-queue-list');
    if (!list) return;
    const empty = (msg) => {
      list.textContent = '';
      list.append(el('li', { class: 'muted' }, msg));
    };
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 3000);
      const res = await liveApi('/api/gate-queue', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      const items = (body && body.items) || [];
      if (!items.length) { empty('Nothing is waiting at the gate.'); return; }
      list.textContent = '';
      for (const it of items.slice(0, 12)) {
        list.append(el('li', {},
          el('span', {}, String((it && it.title) || 'untitled').slice(0, 120)),
          ' ',
          el('small', { class: 'muted' }, String((it && it.status) || '').slice(0, 80))));
      }
    } catch (err) {
      empty('Needs live connection to see the gate queue.');
    }
  }
  async function readNeedsYou() {
    const list = $('#needs-you-list');
    if (!list) return;
    list.textContent = '';
    let st = null;
    try { st = await loadLiveStateLive(); } catch (err) { /* fall through to honest empty */ }
    const top = (st && st.demands_top) || [];
    if (!top.length) {
      list.append(el('li', { class: 'muted' }, st ? 'Nothing needs you right now.' : 'Needs live connection to see demands.'));
      return;
    }
    for (const d of top.slice(0, 5)) {
      list.append(el('li', {}, String(d).slice(0, 140)));
    }
  }
  function refreshBrainControls() {
    renderWindowSwitch();
    readWindowFlag(); // D5: re-read GET on every modal open, so another device's flip shows up
    readGateQueue();
    readNeedsYou();
  }
  $('#window-switch').addEventListener('click', flipWindow);

  // B5: dismiss the topmost panel: ? overlay -> settings -> dump panel.
  // Returns true when something was dismissed.
  function dismissTopPanel() {
    if (keymapIsOpen()) { closeKeymap(); return true; }
    if (!$('#settings-modal').hidden) { closeSettings(); return true; }
    if (!$('#dump-panel').hidden) { if (!dump.uploading) closeDump(); return true; }
    return false;
  }

  window.addEventListener('keydown', (e) => {
    const is3DView = document.body.classList.contains('view-3d');
    if (is3DView) return; // B1: the 3D handler owns keys in 3D view — one keypress, one action
    if (e.key === 'Escape') {
      if (dismissTopPanel()) return; // B5 precedence
      if (selected && !/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '') && !(e.target && e.target.isContentEditable)) return selectNode(null);
      return;
    }
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable) || e.metaKey || e.ctrlKey || e.altKey) return;
    // Key identity (D2): e.code for WASD/Q/E/F (physical positions), e.key for
    // layout-dependent keys. The explicit e.key comparisons keep the zoom
    // bindings visible to the S1-era static parity guard; the ONE map (D3)
    // still owns every action and label.
    let entry = BRAIN_KEYMAP[e.code] || BRAIN_KEYMAP[e.key];
    if (!entry && (e.key === '+' || e.key === '=')) entry = BRAIN_KEYMAP['+'];
    else if (!entry && (e.key === '-' || e.key === '_')) entry = BRAIN_KEYMAP['-'];
    if (!entry) return;
    if (entry.action === 'keymap') { e.preventDefault(); openKeymap(); return; }
    if (e.key === 'Tab') {
      // D4: the Tab walk applies only while focus is on the graph element itself.
      if (document.activeElement !== $('#graph')) return; // native order elsewhere — no trap
      walkNodes(e, e.shiftKey ? -1 : 1);
      return;
    }
    if (FLY_ACTIONS.has(entry.action)) {
      e.preventDefault();
      if (!e.repeat) holdFly(entry.action, true); // B3: rAF loop, not OS key-repeat
      return;
    }
    if (entry.action === 'zoom-in') { e.preventDefault(); zoomAt(view.w / 2, view.h / 2, 1.3); return; }
    if (entry.action === 'zoom-out') { e.preventDefault(); zoomAt(view.w / 2, view.h / 2, 1 / 1.3); return; }
    if (entry.action === 'focus-node') { if (selected) { e.preventDefault(); centerOn(selected); } return; }
    if (entry.action === 'open-node') {
      if (/^(BUTTON|A|SUMMARY)$/.test(tag)) return; // B4: native activation wins
      if (selected) { e.preventDefault(); selectNode(selected); }
      return;
    }
    if (entry.action === 'dump') { e.preventDefault(); openDump(); return; } // D1: U opens the dump
  });

  // ===========================================================================
  // Latest updates log
  // ===========================================================================
  async function loadUpdatesLog() {
    const list = $('#updates-list');
    if (!list) return;
    const token = getToken();
    try {
      let commits;
      if (token) {
        // Private repo — use the token.
        const res = await guardedFetch(CONFIG.apiBase + '/repos/Vrdevil44/dream-brain/commits?per_page=8', {
          headers: {
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.github+json',
          },
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        commits = await res.json();
      } else {
        list.innerHTML = '<li class="muted">Add your GitHub token in Settings to see updates.</li>';
        return;
      }
      // Preserve beat entries already merged into the feed (newer than commits).
      const beatItems = [...list.querySelectorAll('.beat-entry, .beat-summary')];
      list.innerHTML = '';
      // Log-tail order (his call 2026-10-13): oldest first, newest last —
      // entries stream in chronologically and the view pins to the newest.
      for (const c of commits.slice(0, 8).reverse()) {        const li = document.createElement('li');
        const msg = (c.commit.message || '').split('\n')[0].slice(0, 80);
        const time = new Date(c.commit.author.date).toLocaleString('en-US', {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });
        li.innerHTML = '<div></div><div class="u-time"></div>';
        li.querySelector('div').textContent = msg;
        li.querySelector('.u-time').textContent = time;
        // Clicking focuses the graph (new nodes glow if just synced).
        li.style.cursor = 'pointer';
        li.title = 'Click to view in graph';
        li.addEventListener('click', async () => {
          // Try to find F-IDs: first from "F-XXXX..F-YYYY" ranges, then individual.
          const rangeM = msg.match(/F-(\d+)\.\.F-(\d+)/);
          let fids = [];
          if (rangeM) {
            const start = parseInt(rangeM[1], 10);
            const end = parseInt(rangeM[2], 10);
            for (let i = start; i <= end && i < start + 20; i++) {
              fids.push('F-' + String(i).padStart(4, '0'));
            }
          } else {
            fids = msg.match(/F-\d+/g) || [];
          }

          if (fids.length > 0 && window.BrainUniverse) {
            for (const fid of fids) {
              if (window.BrainUniverse.focusNode(fid)) {
                toast('Focused ' + fid, 'ok');
                return;
              }
            }
          }

          // Fallback: fetch commit files, find knowledge/ changes, extract F-IDs.
          try {
            const token2 = getToken();
            const sha = c.sha;
            const detRes = await guardedFetch(
              CONFIG.apiBase + `/repos/Vrdevil44/dream-brain/commits/${sha}`,
              { headers: { 'Authorization': 'Bearer ' + token2, 'Accept': 'application/vnd.github+json' } }
            );
            if (detRes.ok) {
              const det = await detRes.json();
              const kFiles = (det.files || []).filter((f) => f.filename.startsWith('knowledge/'));
              if (kFiles.length > 0 && window.BrainUniverse) {
                // Try focusing via the first file's F-IDs from its patch.
                const patch = kFiles[0].patch || '';
                const patchFids = patch.match(/F-\d+/g) || [];
                for (const fid of [...new Set(patchFids)].slice(0, 5)) {
                  if (window.BrainUniverse.focusNode(fid)) {
                    toast('Focused ' + fid, 'ok');
                    return;
                  }
                }
              }
            }
          } catch { /* fall through */ }

          toast('No graph node found for this update', 'err');
        });
        list.appendChild(li);
      }
      // Re-append preserved beat entries at the end (chronological: newest last).
      for (const b of beatItems) list.appendChild(b);
      // Log tail: pin to the newest entry after (re)load.
      initUpdatesAutoScroll();
      if (updatesAutoScroll) scrollUpdatesToBottom();
      // Update mobile pill badge.
      updateUpdatesBadge(commits.length);
    } catch (err) {
      list.innerHTML = '<li class="muted">Could not load updates.</li>';
    }
  }

  // ===========================================================================
  // Beat entries merged into the Updates feed (his call 2026-10-13).
  // No separate CORE panel: each beat's demands append here as feed entries,
  // closed by a compact beat summary line. The feed auto-scrolls to the newest
  // entry; scrolling up pauses it, returning to the bottom resumes.
  // ===========================================================================
  let updatesAutoScroll = true;

  function isUpdatesAtBottom() {
    const log = $('#updates-log');
    if (!log) return true;
    return (log.scrollHeight - log.scrollTop - log.clientHeight) < 24;
  }

  function initUpdatesAutoScroll() {
    const log = $('#updates-log');
    if (!log || log._beatScrollWired) return;
    log._beatScrollWired = true;
    log.addEventListener('scroll', () => { updatesAutoScroll = isUpdatesAtBottom(); }, { passive: true });
  }

  function scrollUpdatesToBottom() {
    const log = $('#updates-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function bumpUpdatesBadge() {
    const badge = $('#updates-badge');
    const pill = $('#updates-pill');
    const list = $('#updates-list');
    const log = $('#updates-log');
    if (!badge || !pill || !list || !log) return;
    if (!isMobile()) return;
    if (log.classList.contains('expanded')) return; // open feed: no badge needed
    const lastSeen = parseInt(localStorage.getItem('updates-last-seen') || '0', 10);
    const fresh = Math.max(0, list.children.length - lastSeen);
    badge.textContent = fresh > 0 ? fresh : '';
  }

  // Mobile beat pill: compact beat status; dot lights up when a new beat
  // arrives while the HUD panel is collapsed (his call 2026-10-13).
  function updateBeatPill(st) {
    const pill = $('#beat-pill');
    if (!pill || !st || !isMobile()) return;
    pill.hidden = false;
    const label = $('#beat-pill-label');
    if (label) label.textContent = 'beat ' + st.beat; // plain words, never F-IDs
    const dot = $('#beat-dot');
    const hud = document.querySelector('.hud');
    if (dot && (!hud || !hud.classList.contains('expanded'))) dot.classList.add('new');
  }

  // ---- Data freshness indicator ------------------------------------------------
  // R6 quick win: the updates panel header shows how old the newest brain
  // state is, derived from live-state.json's `ts` field ("data 12 min old").
  // Wired to every beat that reaches appendBeatUpdates (live tailnet API or
  // the baked static fallback feed the same path), plus a 30s ticker so the
  // age keeps climbing between beats. Empty until the first state arrives.
  let freshState = null; // newest live state seen: { ts }
  function fmtFreshAge(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    if (s < 60) return 'just updated';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min old';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' hr' + (h === 1 ? '' : 's') + ' ' + (m % 60) + ' min old';
    const d = Math.floor(h / 24);
    return d + ' day' + (d === 1 ? '' : 's') + ' old';
  }
  function renderFreshness() {
    const el = $('#data-freshness');
    if (!el) return;
    const t = (freshState && freshState.ts) ? Date.parse(freshState.ts) : NaN;
    if (!Number.isFinite(t)) { el.textContent = ''; return; }
    el.textContent = 'data ' + fmtFreshAge(Date.now() - t);
  }
  setInterval(renderFreshness, 30000);

  // Feed the HUD sync dial from the backend; hand it back to the built-in poll when the backend is down.
  let syncDialLiveDown = false;
  async function tickSyncDialLive() {
    if (!liveApiBase()) return;
    const sy = await fetchSyncStatusLive();
    if (sy) {
      try {
        if (window.BrainUniverse && typeof BrainUniverse.setSyncDial === 'function') {
          const busy = (sy.state === 'delivering' || sy.state === 'peek' || sy.state === 'busy');
          BrainUniverse.setSyncDial(sy.dial.percent, sy.words || 'sync', busy);
        }
      } catch (e) {}
      syncDialLiveDown = false;
    } else if (!syncDialLiveDown) {
      try {
        if (window.BrainUniverse && typeof BrainUniverse.releaseSyncDial === 'function') BrainUniverse.releaseSyncDial();
      } catch (e) {}
      syncDialLiveDown = true;
    }
  }
  tickSyncDialLive();
  setInterval(tickSyncDialLive, 30000);

  function appendBeatUpdates(st) {
    const list = $('#updates-list');
    if (!list || !st) return;
    updateBeatPill(st);
    freshState = st;
    renderFreshness();
    const demands = Array.isArray(st.demands) ? st.demands.filter(Boolean).slice(0, 5) : [];
    if (!demands.length) return; // silence holds: quiet beats add nothing
    // Drop the Loading/token placeholder once real entries exist.
    if (!list.querySelector('li:not(.muted)')) {
      const ph = list.querySelector('li.muted');
      if (ph) ph.remove();
    }
    const frag = document.createDocumentFragment();
    for (const d of demands) {
      const li = document.createElement('li');
      li.className = 'beat-entry';
      li.textContent = String(d).slice(0, 160); // textContent only: untrusted beat text
      frag.appendChild(li);
    }
    // Closing entry for the batch: compact beat summary, plain words, no F-IDs.
    let fix = 0, links = 0;
    for (const d of demands) {
      if (/^UNACCEPTABLE/i.test(d)) fix++;
      else if (/^MISSING LINK/i.test(d)) links++;
    }
    const parts = [];
    if (fix) parts.push(fix + ' fix demand' + (fix === 1 ? '' : 's'));
    if (links) parts.push(links + ' missing link' + (links === 1 ? '' : 's'));
    const sum = document.createElement('li');
    sum.className = 'beat-summary';
    sum.textContent = 'Beat ' + st.beat + ' — ' + (parts.length ? parts.join(', ') : 'noted');
    frag.appendChild(sum);
    list.appendChild(frag);
    initUpdatesAutoScroll();
    if (updatesAutoScroll) scrollUpdatesToBottom();
    bumpUpdatesBadge();
  }

  // ===========================================================================
  // Mobile UI: updates pill, expandable header, search icon, settings extras
  // ===========================================================================
  const isMobile = () => window.matchMedia('(max-width: 640px)').matches;

  function updateUpdatesBadge(count) {
    const badge = $('#updates-badge');
    const pill = $('#updates-pill');
    if (!badge || !pill) return;
    if (!isMobile()) { pill.hidden = true; return; }
    pill.hidden = false;
    // On first load, mark all as seen (no badge). Only new ones after that count.
    let lastSeen = localStorage.getItem('updates-last-seen');
    if (lastSeen === null) {
      localStorage.setItem('updates-last-seen', String(count));
      badge.textContent = '';
      return;
    }
    const newCount = Math.max(0, count - parseInt(lastSeen, 10));
    badge.textContent = newCount > 0 ? newCount : '';
  }

  function initUpdatesToggle() {
    const btn = document.getElementById('updates-toggle');
    const stack = document.getElementById('bottom-stack');
    if (!btn || !stack) return;
    btn.addEventListener('click', () => {
      const open = stack.classList.toggle('updates-open');
      btn.setAttribute('aria-expanded', String(open));
      if (open) scrollUpdatesToBottom();
    });
    document.addEventListener('click', (e) => {
      if (stack.classList.contains('updates-open') && !(e.target && e.target.closest && e.target.closest('#bottom-stack'))) {
        stack.classList.remove('updates-open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function initTimeButton() {
    const btn = document.getElementById('open-time');
    if (!btn) return;
    const close = () => { document.body.classList.remove('time-open'); btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', () => {
      const open = document.body.classList.toggle('time-open');
      btn.setAttribute('aria-expanded', String(open));
    });
    let downInside = false;
    document.addEventListener('pointerdown', (e) => {
      downInside = !!(e.target && e.target.closest && (e.target.closest('#s5-slider-wrap') || e.target.closest('#open-time')));
    }, true);
    document.addEventListener('click', (e) => {
      if (downInside) { downInside = false; return; }
      if (document.body.classList.contains('time-open') && !(e.target && e.target.closest && (e.target.closest('#s5-slider-wrap') || e.target.closest('#open-time')))) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('time-open')) close();
    });
  }

  function initMobileUI() {
    if (!isMobile()) return;

    // Updates pill toggle.
    const pill = $('#updates-pill');
    const log = $('#updates-log');
    if (pill && log) {
      pill.hidden = false;
      pill.addEventListener('click', () => {
        const expanded = log.classList.toggle('expanded');
        pill.style.display = expanded ? 'none' : 'flex';
        if (expanded) {
          // Mark as seen.
          const list = $('#updates-list');
          const count = list ? list.children.length : 0;
          localStorage.setItem('updates-last-seen', String(count));
          $('#updates-badge').textContent = '';
          // Fresh open lands on the newest entry.
          updatesAutoScroll = true;
          scrollUpdatesToBottom();
        }
      });
      // Close when tapping outside (but not when tapping the beat panel/pill).
      document.addEventListener('click', (e) => {
        const hud = document.querySelector('.hud');
        const beatPillEl = $('#beat-pill');
        if (log.classList.contains('expanded') &&
            !log.contains(e.target) && !pill.contains(e.target) &&
            !(hud && hud.contains(e.target)) &&
            !(beatPillEl && beatPillEl.contains(e.target))) {
          log.classList.remove('expanded');
          pill.style.display = 'flex';
        }
      });
    }

    // Beat pill: compact beat status; tap to expand the HUD panel above,
    // tap outside to dismiss (his standing mobile pattern: no close buttons).
    const beatPill = $('#beat-pill');
    if (beatPill) {
      beatPill.hidden = false;
      const hudEl = () => document.querySelector('.hud');
      beatPill.addEventListener('click', (e) => {
        e.stopPropagation();
        const hud = hudEl();
        if (!hud) return;
        const expanded = hud.classList.toggle('expanded');
        beatPill.style.display = expanded ? 'none' : 'flex';
        const dot = $('#beat-dot');
        if (dot) dot.classList.remove('new'); // seen: clear the dot
      });
      document.addEventListener('click', (e) => {
        const hud = hudEl();
        const log = $('#updates-log');
        const pill = $('#updates-pill');
        if (hud && hud.classList.contains('expanded') &&
            !hud.contains(e.target) && !beatPill.contains(e.target) &&
            !(log && log.contains(e.target)) &&
            !(pill && pill.contains(e.target))) {
          hud.classList.remove('expanded');
          beatPill.style.display = 'flex';
        }
      });
    }

    // Brand header expandable → show the legend. Tap outside to collapse.
    const brand = document.querySelector('.brand');
    const domains = $('#brand-domains');
    if (brand && domains) {
      brand.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = domains.classList.toggle('open');
        domains.hidden = !open;
        if (open) buildMobileLegend();
      });
      // Auto-collapse when tapping outside.
      document.addEventListener('click', (e) => {
        if (domains.classList.contains('open') &&
            !domains.contains(e.target) && !brand.contains(e.target)) {
          domains.classList.remove('open');
          domains.hidden = true;
        }
      }, true);
    }

    // Search icon button.
    const topbarActions = document.querySelector('.topbar-actions');
    if (topbarActions && !$('#search-toggle')) {
      const searchBtn = document.createElement('button');
      searchBtn.className = 'btn btn-icon';
      searchBtn.id = 'search-toggle';
      searchBtn.type = 'button';
      searchBtn.setAttribute('aria-label', 'Search');
      searchBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
      searchBtn.addEventListener('click', toggleMobileSearch);
      searchBtn.hidden = true;
      topbarActions.insertBefore(searchBtn, topbarActions.firstChild);
    }

    // Show mobile settings extras.
    const extras = $('#mobile-settings-extras');
    if (extras) {
      extras.hidden = false;
      // Wire view toggle (label switches 2D/3D).
      const viewBtn = $('#settings-view-toggle');
      const mainViewBtn = $('#view-toggle');
      if (viewBtn && mainViewBtn) {
        const updateViewLabel = () => {
          const is3d = document.body.classList.contains('view-3d');
          viewBtn.textContent = is3d ? 'Switch to 2D' : 'Switch to 3D';
        };
        updateViewLabel();
        viewBtn.addEventListener('click', () => {
          mainViewBtn.click();
          setTimeout(updateViewLabel, 100);
        });
        // Also update when the main button is clicked elsewhere.
        mainViewBtn.addEventListener('click', () => setTimeout(updateViewLabel, 100));
      }
      // Wire sync (show progress in settings panel).
      const syncBtn = $('#settings-sync-now');
      const mainSyncBtn = $('#sync-now');
      if (syncBtn && mainSyncBtn) {
        syncBtn.addEventListener('click', () => {
          // Don't close settings — show progress here.
          // Trigger the main sync but mirror its label updates.
          const mainLabel = mainSyncBtn.querySelector('span');
          const syncLabel = syncBtn.querySelector('span') || syncBtn;
          const origText = syncLabel.textContent;
          // Poll the main button's label and mirror it.
          const mirror = setInterval(() => {
            if (mainSyncBtn.disabled) {
              syncLabel.textContent = mainLabel ? mainLabel.textContent : 'Syncing…';
              syncBtn.disabled = true;
            } else {
              syncLabel.textContent = origText;
              syncBtn.disabled = false;
              clearInterval(mirror);
            }
          }, 500);
          mainSyncBtn.click();
        });
      }
    }
  }

  function buildMobileLegend() {
    const container = $('#brand-domains');
    if (!container) return;
    container.innerHTML = '';

    // Try the 3D universe legend first.
    if (window.BrainUniverse && window.BrainUniverse.getLegend) {
      const legend = window.BrainUniverse.getLegend();
      if (legend) {
        const clone = legend.cloneNode(true);
        const origRows = legend.querySelectorAll('.u-legend-row');
        const cloneRows = clone.querySelectorAll('.u-legend-row');
        cloneRows.forEach((cloneRow, i) => {
          const origRow = origRows[i];
          if (origRow) {
            cloneRow.setAttribute('aria-pressed', origRow.getAttribute('aria-pressed'));
            cloneRow.classList.toggle('u-off', origRow.classList.contains('u-off'));
            cloneRow.addEventListener('click', () => origRow.click());
          }
        });
        clone.querySelectorAll('.u-legend-sec').forEach((sec) => {
          const header = sec.querySelector('.u-legend-title');
          const body = sec.querySelector('.u-legend-rows');
          if (!header || !body) return;
          header.addEventListener('click', () => {
            const collapsed = body.classList.toggle('collapsed');
            header.setAttribute('aria-expanded', String(!collapsed));
            const caret = header.querySelector('.u-legend-caret');
            if (caret) caret.textContent = collapsed ? '▸' : '▾';
          });
        });
        container.appendChild(clone);
        return;
      }
    }

    // Fallback for 2D view: build legend from node types.
    if (typeof graphData !== 'undefined' && graphData && graphData.nodes) {
      const TYPE_COLORS_2D = {
        cluster: '#8b7cff', idea: '#38d6c4', target: '#ffb547',
        person: '#ff7eb6', project: '#6aa7ff', topic: '#9be564',
      };
      const domainToType = { people: 'person', projects: 'project', topics: 'topic', places: 'target', patterns: 'idea', library: 'cluster' };
      const tCount = new Map();
      for (const n of graphData.nodes) {
        const t = n.type || domainToType[n.domain] || 'unknown';
        tCount.set(t, (tCount.get(t) || 0) + 1);
      }
      const box = document.createElement('div');
      box.className = 'u-legend';
      const title = document.createElement('h3');
      title.className = 'u-legend-title';
      title.textContent = 'Types';
      box.appendChild(title);
      // Track hidden types.
      if (!window._hiddenTypes) window._hiddenTypes = new Set();
      for (const [type, color] of Object.entries(TYPE_COLORS_2D)) {
        const count = tCount.get(type) || 0;
        if (count === 0) continue;
        const btn = document.createElement('button');
        btn.className = 'u-legend-row' + (window._hiddenTypes.has(type) ? ' u-off' : '');
        btn.type = 'button';
        btn.setAttribute('aria-pressed', window._hiddenTypes.has(type) ? 'false' : 'true');
        const sw = document.createElement('i');
        sw.className = 'u-swatch';
        sw.style.background = color;
        const name = document.createElement('span');
        name.className = 'u-legend-name';
        name.textContent = type;
        const cnt = document.createElement('small');
        cnt.className = 'u-legend-count';
        cnt.textContent = count;
        btn.append(sw, name, cnt);
        btn.addEventListener('click', () => {
          const isOff = btn.classList.toggle('u-off');
          btn.setAttribute('aria-pressed', isOff ? 'false' : 'true');
          if (isOff) window._hiddenTypes.add(type);
          else window._hiddenTypes.delete(type);
          if (typeof apply2dTypeFilter === 'function') apply2dTypeFilter();
        });
        box.appendChild(btn);
      }
      container.appendChild(box);
      return;
    }

    container.innerHTML = '<p class="muted">Legend not available.</p>';
  }

  function toggleMobileSearch() {
    let panel = $('#mobile-search-panel');
    if (panel) {
      panel.remove();
      return;
    }
    // Compact dropdown below the topbar — tap outside to dismiss.
    panel = document.createElement('div');
    panel.id = 'mobile-search-panel';
    panel.style.cssText = 'position:fixed;top:56px;left:12px;right:12px;z-index:50;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.5);max-height:45vh;display:flex;flex-direction:column;overflow:hidden;';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search facts, relations…';
    input.style.cssText = 'width:100%;padding:12px 14px;border:none;border-bottom:1px solid var(--border);background:transparent;color:var(--text);font-size:16px;outline:none;';
    const results = document.createElement('div');
    results.id = 'mobile-search-results';
    results.style.cssText = 'overflow-y:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;';
    results.classList.add('no-scrollbar');

    input.addEventListener('input', () => {
      const q = input.value.toLowerCase().trim();
      results.innerHTML = '';
      if (q.length < 2) return;
      // Search graph nodes.
      const matches = [];
      const merged = expandedSearch(q);
      if (window.BrainUniverse && window.BrainUniverse.searchNodes) {
        matches.push(...merged.nodes);
      }
      // Search relations too ("contradicts", "blocks", "F-0308"…).
      let relMatches = [];
      if (window.BrainUniverse && window.BrainUniverse.searchRelations) {
        try { relMatches = merged.rels; } catch (e) { /* noop */ }
      }
      const closePanel = () => { panel.remove(); document.removeEventListener('click', outsideCloser, true); };
      for (const m of matches.slice(0, 20)) {
        const div = document.createElement('div');
        div.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;';
        div.innerHTML = '<div style="font-weight:600;font-size:14px;"></div><div class="muted" style="font-size:12px;"></div>';
        div.querySelector('div').textContent = m.label || m.id;
        div.querySelector('.muted').textContent = m.id;
        div.addEventListener('click', () => {
          closePanel();
          if (window.BrainUniverse && window.BrainUniverse.focusNode) {
            window.BrainUniverse.focusNode(m.id);
          }
        });
        results.appendChild(div);
      }
      if (relMatches.length) {
        const head = document.createElement('div');
        head.style.cssText = 'padding:8px 14px 4px;font-size:10px;letter-spacing:1.5px;color:var(--text-3);font-weight:600;';
        head.textContent = 'RELATIONS';
        results.appendChild(head);
        for (const r of relMatches) {
          const div = document.createElement('div');
          div.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;';
          div.innerHTML = '<div style="font-size:13px;"></div><div class="muted" style="font-size:12px;margin-top:2px;"></div>';
          div.querySelector('div').innerHTML = '';
          const s1 = document.createElement('span'); s1.textContent = (r.fromLabel || r.from).slice(0, 40);
          const tp = document.createElement('span');
          tp.textContent = ' ' + r.type + ' → ';
          tp.style.cssText = 'color:var(--idea);font-weight:700;font-size:11px;';
          const s2 = document.createElement('span'); s2.textContent = (r.toLabel || r.to).slice(0, 40);
          div.querySelector('div').append(s1, tp, s2);
          div.querySelector('.muted').textContent = r.from + ' → ' + r.to;
          div.addEventListener('click', () => {
            closePanel();
            if (window.BrainUniverse && window.BrainUniverse.focusNode) {
              window.BrainUniverse.focusNode(r.from);
            }
          });
          results.appendChild(div);
        }
      }
      if (matches.length === 0 && relMatches.length === 0) {
        results.innerHTML = '<div class="muted" style="padding:16px;text-align:center;">No matches</div>';
      }
    });

    panel.appendChild(input);
    panel.appendChild(results);
    document.body.appendChild(panel);
    input.focus();
    // Tap outside the panel to dismiss.
    const outsideCloser = (e) => {
      if (!panel.contains(e.target)) {
        panel.remove();
        document.removeEventListener('click', outsideCloser, true);
      }
    };
    // Delay so the opening tap doesn't immediately close it.
    setTimeout(() => document.addEventListener('click', outsideCloser, true), 100);
  }

  // ==== KB:begin ====
  // Knowledge Base booklet view. Text only: sections render via textContent.
  // Gate: the button is revealed after graphData = data in loadGraph; the
  // published knowledge-base.json wears the graph's AES-GCM envelope and is
  // decrypted here with sessionDataKey. Nothing is stored; wipeSession resets.
  let kbSections = null;   // cached [{id,title,body}], in memory only
  let kbLastId = null;     // last viewed section id, in memory only
  let kbGen = 0;           // bumped on reset so late async results are dropped

  function kbReset() {
    kbGen++;
    kbSections = null;
    kbLastId = null;
    const panel = $('#kb-panel');
    if (panel) panel.hidden = true;
    const body = $('#kb-body');
    if (body) body.textContent = '';
    const nav = $('#kb-nav');
    if (nav) nav.textContent = '';
    const btn = $('#open-kb');
    if (btn) btn.hidden = true;
  }

  // Resolves to sections, null (stay silent: locked), or false (show unavailable).
  async function kbLoadSections() {
    const res = await guardedFetch('knowledge-base.json', { cache: 'no-store' });
    if (!res.ok) return false;
    const body = await res.json();
    let doc;
    if (isEnvelope(body)) {
      if (!sessionDataKey) return null;
      doc = await decryptWithKey(body, sessionDataKey);
    } else if (!sessionDataKey) {
      doc = body; // true local preview: the graph itself loaded as a plain object
    } else {
      return false; // envelope graph but plain KB: fail closed
    }
    const list = doc && doc.sections;
    if (!Array.isArray(list) || !list.length) return false;
    const ok = list.every((x) => x && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.body === 'string');
    return ok ? list : false;
  }

  function kbShowSection(id) {
    const sec = (kbSections || []).find((x) => x.id === id) || (kbSections || [])[0];
    if (!sec) return;
    kbLastId = sec.id;
    for (const b of $('#kb-nav').children) {
      const on = b.dataset.id === sec.id;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
    const body = $('#kb-body');
    body.textContent = sec.body;
    body.scrollTop = 0;
  }

  function kbRenderNav() {
    const nav = $('#kb-nav');
    nav.textContent = '';
    for (const sec of kbSections) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kb-nav-item';
      b.dataset.id = sec.id;
      b.textContent = sec.title;
      b.addEventListener('click', () => kbShowSection(sec.id));
      nav.append(b);
    }
  }

  function kbUnavailable() {
    $('#kb-nav').textContent = '';
    $('#kb-body').textContent = 'Knowledge Base unavailable';
  }

  async function kbRefreshLive(gen) {
    const line = $('#kb-live');
    line.textContent = '';
    let st = null;
    try { st = await loadLiveStateLive(); } catch { st = null; }
    if (gen !== kbGen) return;
    const t = (st && st.ts) ? Date.parse(st.ts) : NaN;
    line.textContent = Number.isFinite(t)
      ? 'live · data ' + fmtFreshAge(Date.now() - t)
      : 'live status unavailable';
  }

  async function openKb() {
    if (!graphData) return; // locked: nothing to open
    const gen = kbGen;
    const panel = $('#kb-panel');
    if (!kbSections) {
      let list;
      try { list = await kbLoadSections(); } catch { list = false; }
      if (gen !== kbGen || !graphData) return;
      if (list === null) return; // envelope without a session key: do nothing
      if (list === false) {
        panel.hidden = false;
        kbUnavailable();
        $('#kb-live').textContent = '';
        $('#close-kb').focus();
        return;
      }
      kbSections = list;
    }
    kbRenderNav();
    kbShowSection(kbLastId);
    panel.hidden = false;
    $('#close-kb').focus();
    kbRefreshLive(gen);
  }

  function closeKb() {
    const panel = $('#kb-panel');
    if (panel.hidden) return;
    panel.hidden = true;
    $('#open-kb').focus();
  }

  $('#open-kb').addEventListener('click', openKb);
  $('#close-kb').addEventListener('click', closeKb);
  document.addEventListener('keydown', (e) => {
    const panel = $('#kb-panel');
    if (panel.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeKb(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(panel.querySelectorAll('button')).filter((b) => !b.hidden);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // ==== KB:end ====

  // ==== S4:begin ====
  // S4 brain bar. One owner (askBar), one bar, both surfaces. The brain answers
  // whole, with citations; a thinking indicator shows while it works and the
  // nodes it used light only after the answer arrives. Everything from the
  // response is rendered with textContent / text nodes. The last answer lives
  // in memory only.
  const askBar = {};
  askBar.lastAnswer = null;
  askBar.busy = false;
  const ASK_ASLEEP_WORDS = 'brain asleep — asking works on your home network';
  const ASK_SLOW_WORDS = 'brain is slow, try again';
  const ASK_FALLBACK_WORDS = 'the brain could not answer that — try again';
  const ASK_TIMEOUT_MS = 125000;
  const ASK_UNVERIFIED_WORDS = 'unverified against retrieval';
  const ASK_THINKER_WORDS = "answered by the brain's small local model, from its own notes";
  const ASK_REFUSAL_WORDS = {
    empty_question: 'Ask me something first.',
    rate_limited: 'One question per 10 seconds, please.',
    busy: 'The brain is answering someone else right now. Try again in a moment.',
    identity_mismatch: 'The brain could not confirm its own identity, so it is not answering.',
    memory_stale_refuse: 'The brain\'s memory is too old to answer from safely.',
    corpus_unavailable: 'The brain cannot reach its notes right now.',
    seat_disabled: 'That kind of question is switched off here.',
    seat_timeout: 'The brain took too long to answer. Try again.',
    citation_invalid: 'The brain could not back its answer with its notes, so it is not showing one.',
    history_corrupt: 'The brain\'s chat history is damaged. It has been flagged.',
    thinker_unavailable: 'The brain\'s small local model is not available right now.',
    forbidden: 'The brain does not take questions from this page.',
    method_not_allowed: 'The brain could not take that request.',
    bad_request: 'That question could not be sent. Try shorter words.',
  };

  // Pure and DOM-free: which nodes to pulse once, which to leave lit, and which
  // citations stay text. A citation with no graph node is text only; a
  // citation the retrieval never returned is unverified and is never lit.
  askBar.planLighting = function (response, graphIds) {
    const out = { pulse: [], lit: [], textOnly: [], unverified: [] };
    if (!response || typeof response !== 'object' || response.refusal_reason || response.error) return out;
    const inGraph = (id) => !!graphIds && (typeof graphIds.has === 'function' ? graphIds.has(id) : (Array.isArray(graphIds) && graphIds.indexOf(id) !== -1));
    const hitRows = (response.retrieval_debug && Array.isArray(response.retrieval_debug.hits)) ? response.retrieval_debug.hits : [];
    const hitIds = hitRows.map((h) => (h && typeof h.fid === 'string') ? h.fid : '').filter((id) => id);
    const citeRows = Array.isArray(response.citations) ? response.citations : [];
    const citeIds = citeRows.map((c) => (c && typeof c.fid === 'string') ? c.fid : '').filter((id) => id);
    hitIds.forEach((id) => { if (inGraph(id) && out.pulse.indexOf(id) === -1) out.pulse.push(id); });
    citeIds.forEach((id) => {
      if (!inGraph(id)) { if (out.textOnly.indexOf(id) === -1) out.textOnly.push(id); return; }
      if (hitIds.indexOf(id) === -1) { if (out.unverified.indexOf(id) === -1) out.unverified.push(id); return; }
      if (out.lit.indexOf(id) === -1) out.lit.push(id);
    });
    return out;
  };

  askBar.refusalWords = function (body) {
    const key = body && typeof body === 'object' ? String(body.refusal_reason || body.error || '') : '';
    return Object.prototype.hasOwnProperty.call(ASK_REFUSAL_WORDS, key) ? ASK_REFUSAL_WORDS[key] : ASK_FALLBACK_WORDS;
  };

  askBar.warningWords = function (w) {
    const raw = String(w);
    const stale = /^memory_stale_(\d+)h$/.exec(raw);
    if (stale) return 'The brain\'s memory is about ' + stale[1] + ' hours old.';
    if (raw === 'chat_log_not_written') return 'This question was not saved to the chat history.';
    return raw.replace(/_/g, ' ');
  };

  askBar.graphIds = function () {
    const nodes = (graphData && Array.isArray(graphData.nodes)) ? graphData.nodes : [];
    return new Set(nodes.map((n) => String(n.id)));
  };

  // Asleep = no live contact with the brain (the same signal vitals.js reads).
  askBar.isAsleep = function () {
    if (!liveApiBase()) return true;
    let v = null;
    try { v = window.__brainVitals && window.__brainVitals.read(); } catch (e) { v = null; }
    const dimmed = document.querySelector('#universe.sleeping, #graph.sleeping');
    return !v || !v.live || !!dimmed;
  };

  askBar.focusFid = function (fid) {
    if (viewMode === '3d' && window.BrainUniverse && window.BrainUniverse.focusNode) return window.BrainUniverse.focusNode(fid);
    const n = graph.byId.get(fid);
    if (n) { selectNode(n); return true; }
    return false;
  };

  askBar.setCaption = function (text, withDot) {
    const cap = $('#askbar-caption');
    cap.textContent = '';
    if (withDot) { const d = document.createElement('span'); d.className = 'askbar-dot'; d.setAttribute('aria-hidden', 'true'); cap.appendChild(d); }
    cap.appendChild(document.createTextNode(text));
  };

  askBar.openPanel = function () { $('#askbar-panel').hidden = false; };
  askBar.closePanel = function () { $('#askbar-panel').hidden = true; };

  // Panel for a refusal or failure: plain words, no answer text, no citations.
  askBar.showWords = function (words) {
    askBar.openPanel();
    askBar.setCaption(words, false);
    $('#askbar-answer').textContent = '';
    $('#askbar-thinker').textContent = '';
    $('#askbar-warnings').textContent = '';
    $('#askbar-cites').textContent = '';
  };

  askBar.renderAnswer = function (body, plan) {
    askBar.openPanel();
    const hitRows = (body.retrieval_debug && Array.isArray(body.retrieval_debug.hits)) ? body.retrieval_debug.hits : [];
    const hitSet = new Set(hitRows.map((h) => h && h.fid));
    askBar.setCaption('looked at ' + hitRows.length + ' notes', false);
    $('#askbar-answer').textContent = body.answer;
    $('#askbar-thinker').textContent = ASK_THINKER_WORDS;
    const warnList = $('#askbar-warnings');
    warnList.textContent = '';
    (Array.isArray(body.warnings) ? body.warnings : []).forEach((w) => {
      const li = document.createElement('li');
      li.appendChild(document.createTextNode(askBar.warningWords(w)));
      warnList.appendChild(li);
    });
    const list = $('#askbar-cites');
    list.textContent = '';
    const cites = Array.isArray(body.citations) ? body.citations : [];
    if (!cites.length && hitRows.length) {
      const li = document.createElement('li');
      li.className = 'askbar-cite-meta';
      li.appendChild(document.createTextNode('the brain has nothing cited on that'));
      list.appendChild(li);
    }
    cites.forEach((c) => {
      const fid = String((c && c.fid) || '');
      const li = document.createElement('li');
      li.className = 'askbar-cite';
      const meta = document.createElement('div');
      meta.className = 'askbar-cite-meta';
      if (plan.lit.indexOf(fid) !== -1) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'askbar-cite-btn';
        b.appendChild(document.createTextNode(fid));
        b.setAttribute('aria-label', 'Show ' + fid + ' in the graph');
        b.addEventListener('click', () => { askBar.focusFid(fid); });
        meta.appendChild(b);
      } else {
        meta.appendChild(document.createTextNode(fid));
      }
      if (c && c.confidence !== undefined && c.confidence !== null) meta.appendChild(document.createTextNode(' · confidence ' + String(c.confidence)));
      li.appendChild(meta);
      if (c && c.snippet) {
        const sn = document.createElement('p');
        sn.className = 'askbar-cite-snippet';
        sn.appendChild(document.createTextNode(String(c.snippet)));
        li.appendChild(sn);
      }
      if (!hitSet.has(fid)) {
        const m = document.createElement('p');
        m.className = 'askbar-cite-mark';
        m.appendChild(document.createTextNode(ASK_UNVERIFIED_WORDS));
        li.appendChild(m);
      } else if (plan.textOnly.indexOf(fid) !== -1) {
        const m = document.createElement('p');
        m.className = 'askbar-cite-mark';
        m.appendChild(document.createTextNode('no node for this one in the graph, shown as text'));
        li.appendChild(m);
      }
      list.appendChild(li);
    });
  };

  // The one place the bar asks. Asleep returns early with no request at all.
  askBar.submit = async function () {
    if (askBar.busy) return;
    if (askBar.isAsleep()) { askBar.refresh(); return; }
    const input = $('#askbar-input');
    const question = String(input.value || '').trim();
    if (!question) { askBar.showWords(ASK_REFUSAL_WORDS.empty_question); return; }
    askBar.busy = true;
    askBar.refresh();
    askBar.openPanel();
    askBar.setCaption('thinking…', true);
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { ctl.abort(); } catch (e) { /* already done */ } }, ASK_TIMEOUT_MS);
    let ok = false;
    let body = null;
    try {
      const res = await fetch(liveApiBase() + '/api/portal-ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question }),
        credentials: 'omit',
        cache: 'no-store',
        signal: ctl.signal,
      });
      ok = res.ok;
      try { body = await res.json(); } catch (e) { body = null; }
      clearTimeout(timer);
    } catch (e) {
      clearTimeout(timer);
      // A network failure keeps whatever was last confirmed; nothing is invented.
      if (timedOut) askBar.setCaption(ASK_SLOW_WORDS, false);
      else askBar.setCaption(ASK_ASLEEP_WORDS, false);
      askBar.busy = false;
      askBar.refresh();
      return;
    }
    askBar.busy = false;
    askBar.refresh();
    askBar.onResponse(ok, body);
  };

  // The only function that lights nodes. A refusal or failure plans nothing,
  // so the same single call clears the lights and nothing is lit.
  askBar.onResponse = function (ok, body) {
    const answered = ok && body && typeof body === 'object' && !body.refusal_reason && !body.error
      && typeof body.answer === 'string' && body.thinker === 'localmind';
    const plan = askBar.planLighting(answered ? body : null, askBar.graphIds());
    if (answered) {
      askBar.lastAnswer = body;
      askBar.renderAnswer(body, plan);
    } else {
      askBar.showWords(askBar.refusalWords(body));
    }
    if (window.BrainUniverse && window.BrainUniverse.lightCitationNodes) window.BrainUniverse.lightCitationNodes(plan.lit, plan.pulse);
  };

  askBar.refresh = function () {
    const bar = $('#askbar');
    if (!bar) return;
    const v = (() => { try { return window.__brainVitals && window.__brainVitals.read(); } catch (e) { return null; } })();
    bar.hidden = !(v && v.unlocked);
    const asleep = askBar.isAsleep();
    $('#askbar-asleep').hidden = !asleep;
    $('#askbar-input').disabled = asleep || askBar.busy;
    $('#askbar-go').disabled = asleep || askBar.busy;
  };

  (function initAskBar() {
    const bar = $('#askbar');
    if (!bar) return;
    $('#askbar-go').addEventListener('click', () => { askBar.submit(); });
    $('#askbar-close').addEventListener('click', () => { askBar.closePanel(); $('#askbar-input').focus(); });
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#askbar-panel').hidden) { e.preventDefault(); askBar.closePanel(); return; }
      if (e.key === 'Enter' && e.target === $('#askbar-input') && !e.isComposing) { e.preventDefault(); askBar.submit(); }
    });
    askBar.refresh();
    setInterval(askBar.refresh, 1000);
  })();
  // ==== S4:end ====

  // ==== S5:begin ====
  // S5 growth slider + sleep replay. One owner (sliderSleep). The slider walks
  // the recorded history rows: membership over time on today's layout, never a
  // historical layout. Row counts come from the row itself. The sleep face is a
  // labelled replay of a verified row, never a live indicator. History carries
  // ids only; nothing here reads a label off a row.
  var sliderSleep = {};
  const REPLAY_VERIFIED_BEATS = [765];
  const S5_UNAVAILABLE_WORDS = 'History unavailable';
  const S5_NO_RECORD_WORDS = 'No verified consolidation record for this row.';
  const S5_HISTORY_URL = 'graph-history.jsonl';
  const S5_ID_RE = /^(F-\d+|C-\d+|core|domain-[a-z0-9-]+)$/;

  // Slider thumb value -> row index. Always a row, never a beat number.
  sliderSleep.inputToRow = function (value, n) {
    const count = Math.floor(Number(n));
    if (!(count >= 1)) throw new RangeError('no rows');
    const v = Math.round(Number(value));
    if (!Number.isFinite(v)) throw new RangeError('bad slider value');
    return Math.min(count - 1, Math.max(0, v));
  };

  // Pure and DOM-free. Nodes: born minus died, cumulative to this row. Edges:
  // cumulative born triples whose endpoints are both visible, intersected with
  // the current graph's edge triples when the caller supplies them (died edges
  // are not recorded, so the born set alone is an upper bound).
  sliderSleep.planVisible = function (rows, rowIndex, graph) {
    const vis = new Set();
    const seen = new Set();
    const cum = [];
    for (let i = 0; i <= rowIndex; i++) {
      const r = rows[i];
      for (const id of r.born_nodes) vis.add(id);
      for (const id of r.died_nodes) vis.delete(id);
      for (const e of r.born_edges) {
        const k = e[0] + '>' + e[1] + '>' + e[2];
        if (!seen.has(k)) { seen.add(k); cum.push(e); }
      }
    }
    const keys = graph && graph.edgeKeys;
    const visibleEdges = cum.filter((e) => vis.has(e[0]) && vis.has(e[1])
      && (!keys || keys.has(e[0] + '>' + e[1] + '>' + e[2])));
    const row = rows[rowIndex];
    return { visibleNodes: [...vis], visibleEdges, counts: row.counts, bornThisRow: row.born_nodes };
  };

  // One stated timezone for every date shown.
  sliderSleep.formatDate = function (at) {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Vancouver', year: 'numeric', month: 'short', day: 'numeric',
    }).format(d);
  };

  sliderSleep.formatParts = function (row, idx, total, drawn, prevBeat) {
    const tag = idx === 0 ? 'genesis' : (idx === total - 1 ? 'now' : '');
    const date = sliderSleep.formatDate(row.at);
    let head = 'Beat ' + row.beat;
    if (tag) head += ' · ' + tag;
    if (date) head += ' · ' + date + ' PT';
    if (idx > 0 && Number.isFinite(prevBeat)) head += ' · +' + (row.beat - prevBeat) + ' beats since previous row';
    const d = drawn || { nodes: row.counts.nodes, edges: row.counts.edges };
    let counts = 'recorded ' + row.counts.nodes + ' nodes · ' + d.nodes + ' drawn'
      + ' · recorded ' + row.counts.edges + ' edges · ' + d.edges + ' drawn';
    if (d.nodes < row.counts.nodes || d.edges < row.counts.edges) counts += ' (removed items cannot be drawn)';
    return { head, counts };
  };

  sliderSleep.formatLabel = function (row, idx, total, drawn, prevBeat) {
    const p = sliderSleep.formatParts(row, idx, total, drawn, prevBeat);
    return p.head + ' — ' + p.counts;
  };

  sliderSleep.canReplay = function (rows, idx) {
    const r = rows && rows[idx];
    return !!(r && !r.genesis && r.born_nodes.length > 0 && REPLAY_VERIFIED_BEATS.indexOf(r.beat) !== -1);
  };

  sliderSleep.replayLabel = function (row) {
    return 'Replay — consolidation recorded at beat ' + row.beat + ' (' + sliderSleep.formatDate(row.at)
      + '): these ' + row.born_nodes.length + ' nodes were born in it.';
  };

  // Replay state. The glow-in is one simultaneous call, so no timers exist;
  // the only deferred work is the frame-coalesced slider apply, cancelled on exit.
  sliderSleep.replay = { on: false, row: -1, priorDim: false };

  sliderSleep.applyRow = function (index, rows, uni, graph) {
    const plan = sliderSleep.planVisible(rows, index, graph);
    // Catching up: graph nodes with no birth row exist only at the head.
    if (sliderSleep.status === 'catching-up' && index === rows.length - 1 && graph) {
      const have = new Set(plan.visibleNodes);
      for (const id of graph.ids) if (!have.has(id)) plan.visibleNodes.push(id);
    }
    uni.setVisibleNodeIds(plan.visibleNodes, plan.visibleEdges);
    return plan;
  };

  sliderSleep.exitReplay = function (index, rows, uni, graph) {
    const rp = sliderSleep.replay;
    if (!rp.on) return false;
    rp.on = false;
    rp.row = -1;
    uni.clearGlow(); // gives back the emphasis the replay displaced
    uni.setSleepDim(rp.priorDim);
    if (rows && rows[index]) sliderSleep.applyRow(index, rows, uni, graph);
    return true;
  };

  sliderSleep.setRow = function (index, rows, uni, graph) {
    if (sliderSleep.replay.on) sliderSleep.exitReplay(index, null, uni, graph); // the row below re-applies visibility
    return sliderSleep.applyRow(index, rows, uni, graph);
  };

  sliderSleep.startReplay = function (index, rows, uni, graph) {
    const rp = sliderSleep.replay;
    if (!sliderSleep.canReplay(rows, index)) return false;
    if (rp.on) {
      if (rp.row === index) return true; // double press: nothing new to snapshot
      sliderSleep.exitReplay(index, rows, uni, graph);
    }
    rp.priorDim = typeof uni.isSleepDim === 'function' ? !!uni.isSleepDim() : false;
    rp.on = true;
    rp.row = index;
    uni.setSleepDim(true);
    uni.glowNodes(rows[index].born_nodes);
    return true;
  };

  // Parse + validate the history text. Null on anything malformed.
  sliderSleep.parseHistory = function (text) {
    if (typeof text !== 'string') return null;
    const rows = [];
    let prev = -Infinity;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch (e) { return null; }
      if (!r || typeof r !== 'object' || !Number.isFinite(r.beat) || r.beat <= prev) return null;
      if (!Array.isArray(r.born_nodes) || !Array.isArray(r.died_nodes) || !Array.isArray(r.born_edges)) return null;
      if (!r.counts || !Number.isFinite(r.counts.nodes) || !Number.isFinite(r.counts.edges)) return null;
      if (typeof r.at !== 'string') return null;
      if (r.born_nodes.concat(r.died_nodes).some((id) => typeof id !== 'string' || !S5_ID_RE.test(id))) return null;
      if (r.born_edges.some((e) => !Array.isArray(e) || e.length < 3 || !S5_ID_RE.test(e[0]) || !S5_ID_RE.test(e[1]))) return null;
      prev = r.beat;
      rows.push(r);
    }
    if (!rows.length || rows[0].genesis !== true) return null;
    return rows;
  };

  // Runtime check: every row reconstructs to its recorded node count, and the
  // last row is exactly today's graph. Graph data can run ahead of history.
  sliderSleep.checkRows = function (rows, graphIds) {
    const vis = new Set();
    for (const r of rows) {
      for (const id of r.born_nodes) vis.add(id);
      for (const id of r.died_nodes) vis.delete(id);
      if (vis.size !== r.counts.nodes) return false;
    }
    if (vis.size !== graphIds.size) return false;
    for (const id of vis) if (!graphIds.has(id)) return false;
    return true;
  };

  // Classify the history against today's graph. 'invalid': a row's recorded
  // node count lies, or history names an id the graph lacks. 'catching-up':
  // rows are true but the graph is ahead (missing = graph ids not yet placed
  // in time). 'ready': exact. Edge counts are not per-row checked.
  sliderSleep.assessHistory = function (rows, graphIds) {
    const vis = new Set();
    for (const r of rows) {
      for (const id of r.born_nodes) vis.add(id);
      for (const id of r.died_nodes) vis.delete(id);
      if (vis.size !== r.counts.nodes) return { state: 'invalid', missing: 0 };
    }
    for (const id of vis) if (!graphIds.has(id)) return { state: 'invalid', missing: 0 };
    let missing = 0;
    for (const id of graphIds) if (!vis.has(id)) missing++;
    return { state: missing === 0 ? 'ready' : 'catching-up', missing };
  };

  sliderSleep.graphFacts = function (data) {
    const idOfRef = (x) => String((x && typeof x === 'object') ? x.id : x);
    const nodes = (data && Array.isArray(data.nodes)) ? data.nodes : [];
    const edges = (data && Array.isArray(data.edges)) ? data.edges : [];
    return {
      ids: new Set(nodes.map((n) => String(n.id))),
      edgeKeys: new Set(edges.map((e) => idOfRef(e.source) + '>' + idOfRef(e.target) + '>' + e.type)),
    };
  };

  // ---- DOM controller (browser only; the pure parts above run anywhere) ----
  sliderSleep.dom = function (id) { return document.getElementById(id); };
  sliderSleep.reduced = function () {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  };
  sliderSleep.uni = function () { return window.BrainUniverse || null; };

  sliderSleep.drawnCounts = function (index) {
    const plan = sliderSleep.planVisible(sliderSleep.rows, index, sliderSleep.graph);
    let nodes = 0;
    for (const id of plan.visibleNodes) if (sliderSleep.graph.ids.has(id)) nodes++;
    if (sliderSleep.status === 'catching-up' && index === sliderSleep.rows.length - 1) nodes += sliderSleep.missing;
    return { nodes, edges: plan.visibleEdges.length };
  };

  sliderSleep.render = function () {
    const slider = sliderSleep.dom('s5-slider');
    const rowEl = sliderSleep.dom('s5-row-label');
    const countsEl = sliderSleep.dom('s5-counts');
    const btn = sliderSleep.dom('s5-replay');
    const note = sliderSleep.dom('s5-replay-label');
    const rows = sliderSleep.rows;
    if (!rows) {
      slider.disabled = true;
      btn.disabled = true;
      btn.textContent = 'Replay sleep';
      rowEl.textContent = sliderSleep.status === 'loading' ? 'Beat history' : S5_UNAVAILABLE_WORDS;
      countsEl.textContent = '';
      slider.removeAttribute('aria-valuetext');
      note.hidden = true;
      return;
    }
    const idx = sliderSleep.index;
    const parts = sliderSleep.formatParts(rows[idx], idx, rows.length, sliderSleep.drawnCounts(idx),
      idx > 0 ? rows[idx - 1].beat : NaN);
    rowEl.textContent = parts.head;
    countsEl.textContent = parts.counts;
    if (sliderSleep.status === 'catching-up') {
      countsEl.textContent += ' · History catching up: ' + sliderSleep.missing + ' newest nodes not yet placed in time';
    }
    slider.setAttribute('aria-valuetext', parts.head + ' — ' + parts.counts);
    if (sliderSleep.status === 'catching-up') slider.setAttribute('aria-valuetext', parts.head + ' — ' + countsEl.textContent);
    const rp = sliderSleep.replay;
    const ok = sliderSleep.canReplay(rows, idx);
    btn.disabled = !ok && !rp.on;
    btn.textContent = rp.on ? 'Stop replay' : 'Replay sleep';
    note.hidden = false;
    if (rp.on) note.textContent = sliderSleep.replayLabel(rows[idx]);
    else if (!ok) note.textContent = S5_NO_RECORD_WORDS;
    else note.hidden = true;
  };

  sliderSleep.exit = function () {
    if (!sliderSleep.rows || !sliderSleep.replay.on) return;
    const uni = sliderSleep.uni();
    if (uni) sliderSleep.exitReplay(sliderSleep.index, sliderSleep.rows, uni, sliderSleep.graph);
    else sliderSleep.replay.on = false;
    sliderSleep.render();
  };

  sliderSleep.go = function (index) {
    const uni = sliderSleep.uni();
    if (!uni || !sliderSleep.rows) return;
    sliderSleep.index = index;
    sliderSleep.setRow(index, sliderSleep.rows, uni, sliderSleep.graph);
    sliderSleep.render();
  };

  sliderSleep.onInput = function () {
    const rows = sliderSleep.rows;
    if (!rows) return;
    const idx = sliderSleep.inputToRow(sliderSleep.dom('s5-slider').value, rows.length);
    if (idx === sliderSleep.index && !sliderSleep.replay.on) return;
    if (sliderSleep.replay.on) {
      const uni = sliderSleep.uni();
      if (uni) sliderSleep.exitReplay(idx, null, uni, sliderSleep.graph); // moving the slider ends the replay
      else sliderSleep.replay.on = false;
    }
    sliderSleep.pending = idx;
    sliderSleep.index = idx;
    sliderSleep.render(); // label follows the hand at once; the universe follows once per frame
    if (sliderSleep.reduced() || typeof requestAnimationFrame !== 'function') { sliderSleep.flush(); return; }
    if (!sliderSleep.raf) sliderSleep.raf = requestAnimationFrame(sliderSleep.flush);
  };

  sliderSleep.flush = function () {
    sliderSleep.raf = 0;
    if (sliderSleep.pending == null) return;
    const idx = sliderSleep.pending;
    sliderSleep.pending = null;
    sliderSleep.go(idx);
  };

  sliderSleep.cancelFrame = function () {
    if (sliderSleep.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(sliderSleep.raf);
    sliderSleep.raf = 0;
    sliderSleep.pending = null;
  };

  // One plain same-origin GET of the history file. Absent (public site) or bad
  // history leaves the slider disabled; no other request is made here.
  sliderSleep.load = async function (session) {
    sliderSleep.rows = null;
    sliderSleep.status = 'loading';
    sliderSleep.render();
    let rows = null;
    try {
      const res = await fetch(historyLiveUrl() || S5_HISTORY_URL, { cache: 'no-store', credentials: 'same-origin' });
      if (res.ok) rows = sliderSleep.parseHistory(await res.text());
    } catch (e) { rows = null; }
    if (sliderSleep.session !== session) return; // locked or reloaded meanwhile
    const facts = sliderSleep.graphFacts(session);
    let state = 'unavailable';
    if (rows) {
      const a = sliderSleep.assessHistory(rows, facts.ids);
      if (a.state === 'invalid') rows = null;
      else { state = a.state; sliderSleep.missing = a.missing; }
    }
    // The strict equality check only governs an exact ('ready') history.
    if (state !== 'catching-up')
    if (rows && !sliderSleep.checkRows(rows, facts.ids)) rows = null;
    sliderSleep.graph = facts;
    sliderSleep.rows = rows;
    // U2 sparks: the latest row's born edges earn a birth-glow weight (universe.js reads this Set).
    if (rows) window.__brainFreshEdges = new Set(rows[rows.length - 1].born_edges.map((e) => e[0] + '|' + e[1] + '|' + e[2]));
    sliderSleep.status = rows ? 'ready' : 'unavailable';
    if (rows && state === 'catching-up') sliderSleep.status = 'catching-up';
    sliderSleep.index = rows ? rows.length - 1 : 0;
    const slider = sliderSleep.dom('s5-slider');
    if (rows) {
      slider.min = '0';
      slider.max = String(rows.length - 1);
      slider.step = '1';
      slider.value = String(rows.length - 1);
      slider.disabled = false;
    }
    sliderSleep.render();
  };

  sliderSleep.tick = function () {
    const wrap = sliderSleep.dom('s5-slider-wrap');
    if (!wrap) return;
    const uni = sliderSleep.uni();
    const ready = !!(graphData && viewMode === '3d' && uni && uni.isReady && uni.isReady());
    wrap.hidden = !ready;
    if (!ready) {
      sliderSleep.cancelFrame();
      if (!graphData) { sliderSleep.session = null; sliderSleep.rows = null; sliderSleep.replay.on = false; }
      return;
    }
    if (sliderSleep.session !== graphData) {
      sliderSleep.session = graphData;
      sliderSleep.replay.on = false;
      sliderSleep.load(graphData);
      return;
    }
    if (!sliderSleep.rows) return;
    // The 3D view was rebuilt (view toggle): put the chosen row back.
    const last = sliderSleep.rows.length - 1;
    if (sliderSleep.index < last && !uni.isFiltered()) {
      const wasReplay = sliderSleep.replay.on;
      sliderSleep.replay.on = false;
      sliderSleep.applyRow(sliderSleep.index, sliderSleep.rows, uni, sliderSleep.graph);
      if (wasReplay) sliderSleep.startReplay(sliderSleep.index, sliderSleep.rows, uni, sliderSleep.graph);
      sliderSleep.render();
    }
  };

  sliderSleep.boot = function () {
    const slider = sliderSleep.dom('s5-slider');
    const btn = sliderSleep.dom('s5-replay');
    if (!slider || !btn) return;
    sliderSleep.rows = null;
    sliderSleep.status = 'loading';
    sliderSleep.index = 0;
    slider.addEventListener('input', sliderSleep.onInput);
    btn.addEventListener('click', () => {
      const uni = sliderSleep.uni();
      if (!uni || !sliderSleep.rows) return;
      if (sliderSleep.replay.on) { sliderSleep.exit(); return; }
      sliderSleep.startReplay(sliderSleep.index, sliderSleep.rows, uni, sliderSleep.graph);
      sliderSleep.render();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sliderSleep.replay.on) { sliderSleep.cancelFrame(); sliderSleep.exit(); }
    });
    window.addEventListener('pagehide', () => { sliderSleep.cancelFrame(); sliderSleep.exit(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { sliderSleep.cancelFrame(); sliderSleep.exit(); }
    });
    sliderSleep.render();
    setInterval(sliderSleep.tick, 1000);
  };
  if (typeof document !== 'undefined') sliderSleep.boot();
  // ==== S5:end ====

  // ==== S6:begin ====
  // S6 voice loop, minimal. One owner (voiceLoop). Ears are the phone keyboard's
  // own mic key into the native input; there is no dictation code here. The mouth
  // is the device's own speech synth, started only by a tap on the Speak button,
  // reading only the rendered answer text as it is at tap time. Default voice,
  // rate and pitch. Primary rules: the click-time no-op and the stop-only watch.
  // The S4 wrappers further down are secondary (button sync and extra stops).
  var voiceLoop = voiceLoop || {};
  if (!voiceLoop.booted) {
    voiceLoop.booted = true;
    voiceLoop.state = 'idle';
    voiceLoop.current = null;
    voiceLoop.spoken = '';
    voiceLoop.watchHandle = null;
    const VOICE_UNAVAILABLE_WORDS = 'Speaking unavailable on this device';
    const voiceEl = (id) => document.getElementById(id);

    // Pure and DOM-free: speak starts or restarts, every other event ends speech.
    voiceLoop.nextState = function (state, event) {
      return event === 'speak' ? 'speaking' : 'idle';
    };

    voiceLoop.synthFor = function (synth) {
      if (synth !== undefined) return synth;
      return (typeof speechSynthesis !== 'undefined') ? speechSynthesis : null;
    };
    voiceLoop.available = function (synth) {
      return !!voiceLoop.synthFor(synth) && typeof SpeechSynthesisUtterance !== 'undefined';
    };

    // The text a tap may speak, read now from the rendered element; null = no-op.
    voiceLoop.readable = function () {
      const bar = voiceEl('askbar');
      const panel = voiceEl('askbar-panel');
      const input = voiceEl('askbar-input');
      const answer = voiceEl('askbar-answer');
      if (!panel || !answer || panel.hidden || (bar && bar.hidden) || (input && input.disabled)) return null;
      const text = answer.textContent;
      return (typeof text === 'string' && text.trim()) ? text : null;
    };

    voiceLoop.syncButton = function () {
      const btn = voiceEl('askbar-speak');
      if (!btn) return;
      if (!voiceLoop.available()) {
        btn.disabled = true;
        btn.textContent = VOICE_UNAVAILABLE_WORDS;
        return;
      }
      const speaking = voiceLoop.state === 'speaking';
      btn.textContent = speaking ? 'Stop' : 'Speak';
      btn.disabled = speaking ? false : voiceLoop.readable() === null;
    };

    // Stop-only watch: runs only while speaking, and can only call voiceLoop.stop.
    voiceLoop.startWatch = function () {
      if (voiceLoop.watchHandle !== null) return;
      voiceLoop.watchHandle = setInterval(() => {
        if (voiceLoop.state !== 'speaking') return;
        const bar = voiceEl('askbar');
        const panel = voiceEl('askbar-panel');
        const input = voiceEl('askbar-input');
        const answer = voiceEl('askbar-answer');
        if (!panel || !answer || panel.hidden || (bar && bar.hidden) || (input && input.disabled)
          || answer.textContent !== voiceLoop.spoken) voiceLoop.stop(undefined, 'hide');
      }, 400);
    };
    voiceLoop.stopWatch = function () {
      if (voiceLoop.watchHandle === null) return;
      clearInterval(voiceLoop.watchHandle);
      voiceLoop.watchHandle = null;
    };

    voiceLoop.setState = function (event) {
      voiceLoop.state = voiceLoop.nextState(voiceLoop.state, event);
      if (voiceLoop.state === 'speaking') voiceLoop.startWatch(); else voiceLoop.stopWatch();
      voiceLoop.syncButton();
    };

    // The one speak() call site. Cancel first so utterances never queue.
    voiceLoop.speak = function (text, synth) {
      const s = voiceLoop.synthFor(synth);
      if (!s || typeof SpeechSynthesisUtterance === 'undefined' || typeof text !== 'string' || !text.trim()) return false;
      try { s.cancel(); } catch (e) { /* nothing to cancel */ }
      const u = new SpeechSynthesisUtterance(text);
      voiceLoop.current = u;
      voiceLoop.spoken = text;
      u.onend = () => { if (voiceLoop.current === u) { voiceLoop.current = null; voiceLoop.setState('end'); } };
      u.onerror = () => { if (voiceLoop.current === u) { voiceLoop.current = null; voiceLoop.setState('error'); } };
      voiceLoop.setState('speak');
      try { s.speak(u); } catch (e) { voiceLoop.current = null; voiceLoop.setState('error'); return false; }
      return true;
    };

    // Every stop trigger lands here: cancel, forget the utterance, go idle.
    voiceLoop.stop = function (synth, event) {
      const s = voiceLoop.synthFor(synth);
      voiceLoop.current = null;
      if (s) { try { s.cancel(); } catch (e) { /* already silent */ } }
      voiceLoop.setState(event || 'stop');
    };

    // Secondary: wrap, never edit, an S4 function. Preserves this, arguments and
    // return value; stops before the original; syncs after, even on a throw.
    voiceLoop.wrap = function (target, name, event) {
      const original = target[name];
      if (typeof original !== 'function' || original.s6Wrapped) return false;
      const wrapped = function () {
        voiceLoop.stop(undefined, event);
        try { return original.apply(this, arguments); } finally { voiceLoop.syncButton(); }
      };
      wrapped.s6Wrapped = true;
      target[name] = wrapped;
      return true;
    };

    const voiceTargets = ['submit', 'closePanel', 'renderAnswer', 'showWords'];
    if (typeof askBar !== 'undefined' && askBar && voiceTargets.every((n) => typeof askBar[n] === 'function')) {
      voiceLoop.wrap(askBar, 'submit', 'submit');
      voiceLoop.wrap(askBar, 'closePanel', 'close');
      voiceLoop.wrap(askBar, 'renderAnswer', 'render');
      voiceLoop.wrap(askBar, 'showWords', 'render');
    }

    const voiceBtn = voiceEl('askbar-speak');
    if (voiceBtn) {
      voiceBtn.addEventListener('click', () => {
        if (voiceLoop.state === 'speaking') { voiceLoop.stop(); return; }
        if (!voiceLoop.available()) return;
        const text = voiceLoop.readable();
        if (text === null) return;
        voiceLoop.speak(text);
      });
    }
    window.addEventListener('pagehide', () => { voiceLoop.stop(undefined, 'hide'); });
    window.addEventListener('pageshow', () => { voiceLoop.stop(undefined, 'pageshow'); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') voiceLoop.stop(undefined, 'hide');
    });
    voiceLoop.syncButton();
  }
  // ==== S6:end ====

  // ==== S7:begin ====
  // S7 One Bar shell. One owner (oneBar). The bottom bar is the bar: an icon opens
  // it, typing shows live results above it. #askbar's hidden property belongs to
  // askBar.refresh(); S7 only flips the body.onebar-collapsed class.
  const oneBar = {};
  oneBar.isUnlocked = function () {
    try {
      const v = window.__brainVitals && window.__brainVitals.read();
      return !!(v && v.unlocked);
    } catch (e) { return false; }
  };
  oneBar.setOpen = function (open) {
    document.body.classList.toggle('onebar-collapsed', !open);
    $('#onebar-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) $('#askbar-input').focus();
    else oneBar.clear();
  };
  oneBar.clear = function () {
    const box = $('#onebar-results');
    while (box.firstChild) box.removeChild(box.firstChild);
    box.hidden = true;
  };
  oneBar.row = function (main, sub, onPick) {
    const row = document.createElement('div');
    row.className = 'onebar-row';
    const a = document.createElement('div');
    a.className = 'onebar-row-main';
    a.textContent = main;
    const b = document.createElement('div');
    b.className = 'onebar-row-sub';
    b.textContent = sub;
    row.append(a, b);
    row.addEventListener('click', () => {
      oneBar.clear();
      onPick();
    });
    return row;
  };
  oneBar.render = function () {
    const box = $('#onebar-results');
    const q = $('#askbar-input').value.toLowerCase().trim();
    if (q.length < 2) { oneBar.clear(); return; }
    const U = window.BrainUniverse;
    let nodes = [];
    let rels = [];
    const merged = expandedSearch(q);
    try { if (U && U.searchNodes) nodes = merged.nodes; } catch (e) { /* noop */ }
    try { if (U && U.searchRelations) rels = merged.rels; } catch (e) { /* noop */ }
    while (box.firstChild) box.removeChild(box.firstChild);
    const focus = (id) => { if (U && U.focusNode) U.focusNode(id); };
    for (const m of nodes.slice(0, 20)) {
      box.appendChild(oneBar.row(m.label || m.id, m.id, () => focus(m.id)));
    }
    if (rels.length) {
      const head = document.createElement('div');
      head.className = 'onebar-group';
      head.textContent = 'RELATIONS';
      box.appendChild(head);
      for (const r of rels) {
        const main = (r.fromLabel || r.from).slice(0, 40) + ' ' + r.type + ' \u2192 ' + (r.toLabel || r.to).slice(0, 40);
        box.appendChild(oneBar.row(main, r.from + ' \u2192 ' + r.to, () => focus(r.from)));
      }
    }
    if (!nodes.length && !rels.length) {
      const none = document.createElement('div');
      none.className = 'onebar-empty';
      none.textContent = 'No matches';
      box.appendChild(none);
    }
    box.hidden = false;
  };
  oneBar.tick = function () {
    $('#onebar-toggle').hidden = !oneBar.isUnlocked();
  };
  (function initOneBar() {
    const toggle = $('#onebar-toggle');
    const input = $('#askbar-input');
    if (!toggle || !input || !$('#onebar-results')) return;
    toggle.addEventListener('click', () => {
      oneBar.setOpen(document.body.classList.contains('onebar-collapsed'));
    });
    input.addEventListener('input', oneBar.render);
    $('#askbar-go').addEventListener('click', oneBar.clear);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.body.classList.contains('onebar-collapsed')) return;
      if (!$('#askbar-panel').hidden) return;
      oneBar.setOpen(false);
    });
    oneBar.tick();
    setInterval(oneBar.tick, 1000);
  })();
  // ==== S7:end ====

  // ===========================================================================
  // Boot
  // ===========================================================================
  document.body.classList.add('onebar-collapsed');
  resize();
  updateCounter();
  refreshTokenDot();
  loadGraph();
  loadAliases();
  loadUpdatesLog();
  initUpdatesAutoScroll();
  initMobileUI();
  initUpdatesToggle();
  initTimeButton();
})();
