/*
 * Second Brain portal
 *
 * ============================================================================
 * HARD PRIVACY RULE
 * This page must NEVER fetch, list, or display raw content from `daily-dump/`
 * or `organized/`. The ONLY data it may load is `graph.json`, which holds
 * sanitized cluster data (labels, types, sizes and links, no raw notes).
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
    repo: 'about-vibhu',
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
  };
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
      // Same origin: only graph.json, only GET.
      const isGraph = u.pathname.endsWith('/' + CONFIG.graphUrl) || u.pathname === '/' + CONFIG.graphUrl;
      if (m === 'GET' && isGraph && !/\/(daily-dump|organized)\//.test(u.pathname)) return;
      throw new Error('Blocked by privacy rule: ' + m + ' ' + u.pathname);
    }

    if (u.origin === CONFIG.apiBase) {
      if (m === 'GET' && u.pathname === '/user') return;
      if (m === 'PUT' && u.pathname.startsWith(DUMP_PATH_PREFIX) && !u.pathname.includes('..')) return;
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

  // ---- Load + sanitize graph.json -------------------------------------------
  async function loadGraph() {
    const status = $('#graph-status');
    status.textContent = 'Loading graph…';
    try {
      const res = await guardedFetch(CONFIG.graphUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      buildGraph(data);
      status.textContent = '';
      status.classList.remove('error');
      if (!graph.nodes.length) status.textContent = 'The graph is empty. Dump something and the nightly organizer will fill it in.';
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
      const type = ['cluster', 'idea', 'target'].includes(n.type) ? n.type : 'unknown';
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
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function frame(t) {
    rafId = 0;
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

  function apiErrorMessage(status, body) {
    const msg = body && body.message ? String(body.message) : '';
    if (status === 0) return 'Network error. Check your connection and try again.';
    if (status === 401) return 'GitHub rejected the token (401). Update it in Settings.';
    if (status === 403) {
      if (/rate limit/i.test(msg)) return 'GitHub rate limit hit. Wait a few minutes and retry.';
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

  function openSettings() {
    tokenInput.value = getToken();
    $('#token-error').textContent = '';
    setConnection('', '');
    $('#settings-modal').hidden = false;
    setTimeout(() => tokenInput.focus(), 30);
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
    refreshTokenDot();
    refreshTokenWarning();
    toast('Token saved in this browser', 'ok');
    closeSettings();
  });

  $('#token-clear').addEventListener('click', () => {
    setToken('');
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
      const res = await guardedFetch(CONFIG.apiBase + '/user', { headers: githubHeaders(t), cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(res.status, body));
      setConnection('Connected as @' + body.login + '. Remember to Save.', 'ok');
    } catch (e) {
      setConnection(e.message === 'Failed to fetch' ? apiErrorMessage(0) : e.message, 'err');
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
  // Boot
  // ===========================================================================
  resize();
  updateCounter();
  refreshTokenDot();
  loadGraph();
})();
