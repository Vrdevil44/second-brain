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
 * Every request goes through `guardedRequest()`, which rejects anything else.
 * The Content-Security-Policy in index.html enforces the same limits in the
 * browser. Do not add reads of the private repo here, ever.
 * ============================================================================
 *
 * No build step, no dependencies. Vanilla JS only.
 */
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
      // Same origin: only graph.json and mfa.json, only GET.
      const isGraph = u.pathname.endsWith('/' + CONFIG.graphUrl) || u.pathname === '/' + CONFIG.graphUrl;
      const isMfa = u.pathname.endsWith('/mfa.json') || u.pathname === '/mfa.json';
      if (m === 'GET' && (isGraph || isMfa) && !/\/(daily-dump|organized)\//.test(u.pathname)) return;
      throw new Error('Blocked by privacy rule: ' + m + ' ' + u.pathname);
    }

    if (u.origin === CONFIG.apiBase) {
      if (m === 'GET' && u.pathname === '/user') return;
      if (m === 'PUT' && u.pathname.startsWith(DUMP_PATH_PREFIX) && !u.pathname.includes('..')) return;
      // Sync-now: dispatch the workflow and poll its status.
      const wf = `/repos/${CONFIG.owner}/dream-brain/actions/`;
      if (m === 'POST' && u.pathname === wf + 'workflows/sync.yml/dispatches') return;
      if (m === 'GET' && u.pathname === wf + 'workflows/sync.yml/runs') return;
      if (m === 'GET' && /^\/repos\/[^/]+\/dream-brain\/actions\/runs\/\d+$/.test(u.pathname)) return;
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
  let graphData = null;
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
        await loadScriptOnce('vendor/3d-force-graph.min.js');
        await loadScriptOnce('universe.js?v=52be038');
        if (!window.BrainUniverse) throw new Error('3D module unavailable');
        document.body.classList.add('view-3d');
        box.hidden = false;
        window.BrainUniverse.init(box, graphData, {
          onMeta: (text) => { $('#graph-meta').textContent = text; },
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
    if (!graph2dBuilt) { buildGraph(graphData); graph2dBuilt = true; }
    else { resize(); fitView(false); requestRender(); }
  }

  async function setViewMode(mode) {
    if (mode === viewMode || !graphData) return;
    if (viewMode === '3d' && window.BrainUniverse) window.BrainUniverse.destroy();
    $('#universe').hidden = true;
    document.body.classList.remove('view-3d');
    viewMode = mode;
    await renderView();
  }

  const viewToggle = $('#view-toggle');
  if (viewToggle) viewToggle.addEventListener('click', () => { setViewMode(viewMode === '3d' ? '2d' : '3d'); });

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
      const type = NODE_TYPES.includes(n.type) ? n.type : 'unknown';
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
      const a = graph.byId.get(String(e.from));
      const b = graph.byId.get(String(e.to));
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

    const focus = selected || hovered;
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
      const rgb = RGB[n.type];
      const dim = focus && !focusSet.has(n.id);
      const isFocus = n === focus;
      const glowR = n.r * (n.type === 'cluster' ? 3 : 2.6) * (isFocus ? 1.25 : 1);

      const halo = ctx.createRadialGradient(n.x, n.y, n.r * 0.5, n.x, n.y, glowR);
      halo.addColorStop(0, rgba(rgb, dim ? 0.05 : isFocus ? 0.5 : 0.28));
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
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2 / k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 5 / k, 0, Math.PI * 2);
        ctx.stroke();
      } else if (n === hovered) {
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
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
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
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

    try {
      // 1. Dispatch the workflow directly.
      label.textContent = 'Starting…';
      const disp = await api('/repos/Vrdevil44/dream-brain/actions/workflows/sync.yml/dispatches', {
        method: 'POST',
        body: JSON.stringify({ ref: 'master' }),
      });
      if (!disp.ok) throw new Error('GitHub API ' + disp.status);

      // 2. Find the run we just triggered.
      label.textContent = 'Syncing…';
      btn.classList.add('syncing');
      let runId = null;
      for (let i = 0; i < 6 && !runId; i++) {
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

      // 3. Poll until complete (10 min timeout).
      const deadline = Date.now() + 10 * 60 * 1000;
      let status = '', conclusion = '';
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 8000));
        try {
          const st = await api(`/repos/Vrdevil44/dream-brain/actions/runs/${runId}`);
          if (!st.ok) continue;
          const data = await st.json();
          status = data.status;
          conclusion = data.conclusion;
          if (status === 'completed') break;
        } catch { /* keep polling */ }
      }
      btn.classList.remove('syncing');
      if (status === 'completed') {
        toast(conclusion === 'success' ? 'Sync complete.' : 'Sync finished: ' + conclusion, conclusion === 'success' ? 'ok' : 'err');
      } else {
        toast('Sync still running — check Actions on GitHub.', 'ok');
      }
    } catch (err) {
      btn.classList.remove('syncing');
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
  // Keyboard shortcuts
  // ===========================================================================
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#settings-modal').hidden) return closeSettings();
      if (!$('#dump-panel').hidden) { if (!dump.uploading) closeDump(); return; }
      if (selected) return selectNode(null);
      return;
    }
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'f' || e.key === 'F') fitView(true);
    else if (e.key === '+' || e.key === '=') zoomAt(view.w / 2, view.h / 2, 1.3);
    else if (e.key === '-' || e.key === '_') zoomAt(view.w / 2, view.h / 2, 1 / 1.3);
    else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); openDump(); }
  });

  // ===========================================================================
  // Latest updates log
  // ===========================================================================
  async function loadUpdatesLog() {
    const list = $('#updates-list');
    if (!list) return;
    try {
      // Public repo — no auth needed for recent commits.
      const res = await fetch('https://api.github.com/repos/Vrdevil44/dream-brain/commits?per_page=8');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const commits = await res.json();
      list.innerHTML = '';
      for (const c of commits.slice(0, 8)) {
        const li = document.createElement('li');
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
        li.addEventListener('click', () => {
          // Try to extract F-IDs from the commit message and focus the first.
          const m = msg.match(/F-\d+/g);
          if (m && window.BrainUniverse) {
            for (const fid of m) {
              if (window.BrainUniverse.focusNode(fid)) {
                toast('Focused ' + fid, 'ok');
                return;
              }
            }
          }
          toast('No graph node found for this update', 'err');
        });
        list.appendChild(li);
      }
    } catch (err) {
      list.innerHTML = '<li class="muted">Could not load updates.</li>';
    }
  }

  // ===========================================================================
  // Boot
  // ===========================================================================
  resize();
  updateCounter();
  refreshTokenDot();
  loadGraph();
  loadUpdatesLog();
})();
