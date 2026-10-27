/* Second Brain: 3D universe view.
 *
 * Loaded ONLY after the visitor has unlocked the encrypted graph (injected by
 * app.js). Same-origin, no network calls. The decrypted graph is held in
 * memory only; nothing here persists anything to browser storage or the URL.
 *
 * Exposes window.BrainUniverse = { init(container, graphData, api), destroy() }.
 * Requires window.ForceGraph3D (vendor/3d-force-graph.min.js, Three.js bundled).
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
(function () {
  'use strict';

  // ---- Fresh nodes (new/updated in last 60s) -----------------------------------
  // Nodes that just arrived via sync glow brightly for 60 seconds so they're
  // unmissable, regardless of when you logged in.
  const freshNodes = new Map(); // id -> timestamp
  const FRESH_MS = 60 * 1000;
  const FRESH_COLOR = '#ffffff';

  function markFresh(ids) {
    const now = Date.now();
    for (const id of ids) freshNodes.set(id, now);
    // Schedule cleanup + recolor after the glow expires.
    setTimeout(() => {
      let changed = false;
      for (const [id, ts] of freshNodes) {
        if (now - ts >= FRESH_MS - 100) { freshNodes.delete(id); changed = true; }
      }
      if (changed && S.graph) { S.graph.refresh(); updateFocus(); }
    }, FRESH_MS + 500);
    if (S.graph) { S.graph.refresh(); updateFocus(); }
  }

  function isFresh(id) {
    const ts = freshNodes.get(id);
    if (!ts) return false;
    if (Date.now() - ts > FRESH_MS) { freshNodes.delete(id); return false; }
    return true;
  }

  // ---- Palettes ---------------------------------------------------------------
  // Domains: Okabe-Ito colorblind-safe palette (the dark blue and black are
  // skipped; they vanish on a dark background).
  const DOMAIN_COLORS = {
    people: '#f472b6',
    projects: '#60a5fa',
    topics: '#34d399',
    places: '#facc15',
    patterns: '#fb923c',
    library: '#f97316',
    core: '#a5f3fc',
  };
  // Relation types: categorical palette, one hue per type.
  const TYPE_COLORS = {
    'CONTEXT': '#9aa0b4',
    'CAUSED-BY': '#ff6b6b',
    'CAUSES': '#ff9f43',
    'ENABLES': '#2ed573',
    'BLOCKS': '#d63031',
    'REFINES': '#48dbfb',
    'SUPPORTS': '#1dd1a1',
    'CHALLENGES': '#feca57',
    'CONTRADICTS': '#ff4d94',
    'INSTANCE': '#a29bfe',
    'COMPONENT': '#74b9ff',
    'DOMAIN': '#eaf6ff', // visual scaffolding: core -> hub -> facts (his call 2026-10-17)
  };
  const DOMAINS = Object.keys(DOMAIN_COLORS);
  const TYPES = Object.keys(TYPE_COLORS);
  const FALLBACK_NODE = '#a3a6b8';
  const FALLBACK_LINK = '#6e7187';
  const BG = '#07080d';
  const DBLCLICK_MS = 280;
  const DIM_HOVER = 0.10; // dim factor while a hover (not a pin) anchors the focus
  const DIM = 0.15; // opacity factor for nodes/links outside the focus neighborhood
  // Hairball recession: end-to-end links read at ~LINK_OPACITY_END effective
  // opacity in the default (no-focus) view. The lib multiplies the global
  // linkOpacity scalar by each colour's alpha, so the factor is the ratio.
  const LINK_OPACITY_GLOBAL = 0.55; // must match .linkOpacity(0.55) below
  const LINK_OPACITY_END = 0.30;
  const LINK_END_ALPHA = LINK_OPACITY_END / LINK_OPACITY_GLOBAL;
  const isDomainLink = (l) => !!l && (l.type || '').toUpperCase() === 'DOMAIN';

  let S = null; // live state; null when not initialised

  // ---- Tiny DOM helpers (textContent only: labels are untrusted text) ---------
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- DYNAMIC UI v1 helpers --------------------------------------------------
  // Every visual maps to a real signal. These resolve graph entities for the
  // live-construction layer (activity events name F-IDs; the UI speaks words).
  function nodeById(id) {
    if (!S || !S.graph || id == null) return null;
    return S.graph.graphData().nodes.find((x) => String(x.id) === String(id)) || null;
  }
  function linkNode(e) {
    if (!e) return null;
    return (typeof e === 'object') ? e : nodeById(e);
  }
  // Strip F-IDs from heartbeat labels: the UI speaks plain words, never IDs.
  function stripFids(s) {
    return String(s || '').replace(/F-\d+/g, '').replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.;:])/g, '$1').replace(/\(\s*\)/g, '').trim();
  }
  // Multiply an rgba()/hex color's alpha (for the imperceptible domain breath).
  function scaleAlpha(color, k) {
    const m = String(color).match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
    if (m) {
      const a = Math.min(1, Math.max(0, (+m[4]) * k));
      return 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + a.toFixed(3) + ')';
    }
    return hexToRgba(String(color), Math.min(1, Math.max(0.02, k)));
  }
  // One plain-words line for an activity event (the ticker + HUD activity row).
  function activityWords(a, st) {
    if (!a) return '';
    if (a.kind === 'think' && st && st.core && Array.isArray(st.core.focus) && st.core.focus.length) {
      return 'think — focus: ' + st.core.focus.slice(0, 3)
        .map((f) => String(f.label || '').slice(0, 42)).join(', ');
    }
    const w = stripFids(a.label || a.kind);
    return w || a.kind;
  }

  function escHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // Seeded 0..1 hash (FNV-1a): deterministic per key, stable across page loads.
  // Used for organic variety — node sizes, opacity, packet speeds — so the brain
  // looks alive, never uniform.
  function hash01(str) {
    let h = 2166136261;
    const s = String(str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  }

  // Stable edge key for per-link seeded variation (endpoints may be objects or ids).
  function linkKey(l) {
    const a = l && l.source, b = l && l.target;
    const sa = (a && a.id !== undefined) ? a.id : a, sb = (b && b.id !== undefined) ? b.id : b;
    return String(sa) + '>' + String(sb);
  }

  // ---- Premium glow treatment -------------------------------------------------
  // The vendored 3d-force-graph keeps Three.js module-private (no THREE global),
  // so halo meshes are cloned from a live default node object: its constructor,
  // a unit-normalised sphere geometry, and a MeshLambertMaterial prototype.
  // Additive blending is the numeric enum (THREE.AdditiveBlending === 2).
  const BLEND_ADDITIVE = 2;
  const HALO_SCALE = 3.2;   // halo radius = core radius * 3.2
  const HALO_OPACITY = 0.16;
  let glowTpl = null; // { Mesh, geo, matProto } — captured async, see init()

  function captureGlowTemplate() {
    if (glowTpl || !S || !S.graph) return false;
    const nodes = S.graph.graphData().nodes;
    for (const n of nodes) {
      const o = n.__threeObj;
      if (o && o.isMesh && o.geometry && o.material) {
        const geo = o.geometry.clone();
        geo.computeBoundingSphere();
        const r = (geo.boundingSphere && geo.boundingSphere.radius) || 1;
        geo.scale(1 / r, 1 / r, 1 / r); // unit sphere; per-node scale applied on the mesh
        glowTpl = { Mesh: o.constructor, geo, matProto: o.material };
        return true;
      }
    }
    return false;
  }

  function haloColor(node) {
    if (isFresh(node.id)) return FRESH_COLOR;
    return DOMAIN_COLORS[node.domain] || FALLBACK_NODE;
  }

  // ---- Premium glow craft (his bar 2026-10-17: Apple/Jarvis, not a toy) ----
  // Layered gradient halos: 3 nested additive shells approximate a radial
  // gradient falloff (hot core → soft edge) with plain meshes — no
  // postprocessing, no new deps. This is the craft that makes glow premium.
  const HALO_LAYERS = [
    { s: 1.7, k: 1.0 },   // inner hot core
    { s: 2.8, k: 0.45 },  // mid glow
    { s: 4.6, k: 0.18 },  // outer soft falloff
  ];
  // The core gets an extra shell — denser, hotter, unmistakably the heart.
  const CORE_LAYERS = [
    { s: 1.5, k: 1.0 },
    { s: 2.2, k: 0.75 },
    { s: 3.4, k: 0.45 },
    { s: 5.2, k: 0.20 },
  ];
  function haloGroup() {
    // window.THREE is partially exposed by the 3d-force-graph UMD bundle
    // (Group is available; Sprite/ShaderMaterial are not).
    const T = (typeof window !== 'undefined' && window.THREE) || {};
    return T.Group ? new T.Group() : null;
  }
  function setHaloOpacity(halo, o) {
    if (!halo) return;
    const kids = halo.children && halo.children.length ? halo.children : [halo];
    for (const c of kids) {
      if (c.material) c.material.opacity = Math.min(0.65, o * (c.userData.k == null ? 1 : c.userData.k));
    }
  }
  function setHaloColor(halo, color) {
    if (!halo) return;
    const kids = halo.children && halo.children.length ? halo.children : [halo];
    for (const c of kids) if (c.material) c.material.color.set(color);
  }
  function haloHex(halo) {
    const kids = halo && halo.children && halo.children.length ? halo.children : (halo ? [halo] : []);
    const m = kids.length && kids[0].material;
    return m ? '#' + m.color.getHexString() : '';
  }

  // nodeThreeObject builder: layered additive halo shells around the default
  // core sphere (nodeThreeObjectExtend(true) keeps the core library-managed,
  // so its colour-alpha dimming path is untouched).
  function buildHalo(node) {
    const grp = haloGroup();
    const R = 4 * Math.cbrt(Math.max(1, Number(node.val) || 1)); // nodeRelSize(4)
    const mkShell = (layer) => {
      const mat = glowTpl.matProto.clone();
      mat.color.set(haloColor(node));
      mat.transparent = true;
      mat.opacity = 0; // rest state: no bubble — halos only light up for live events,
      mat.blending = BLEND_ADDITIVE; // selection, fresh nodes, and the breathing core
      mat.depthWrite = false;
      const m = new glowTpl.Mesh(glowTpl.geo, mat);
      m.scale.setScalar(R * layer.s);
      m.raycast = function () {}; // halos must not steal hover/click picking
      m.userData.k = layer.k;
      return m;
    };
    if (grp) {
      // Halo shells: CORE ONLY (his call — the halo was landing on random domain nodes).
      if (node.id === 'core') {
        for (const layer of CORE_LAYERS) grp.add(mkShell(layer));
      }
      grp.traverse((o) => { o.raycast = function () {}; });
      node._halo = (node.id === 'core') ? grp : null;
      return grp;
    }
    // Fallback: single shell (should never happen — Group is exposed).
    const m = mkShell(HALO_LAYERS[0]);
    node._halo = m;
    return m;
  }

  // (starfield removed 2026-10-18 — background is pure void per his call)

  // f = focus factor (1 = normal, DIM = outside the focused neighborhood).
  function nodeColor(n, f) {
    // Fresh nodes (just synced) glow white-hot for 60s — unmissable.
    if (isFresh(n.id)) return FRESH_COLOR;
    const c = DOMAIN_COLORS[n.domain] || FALLBACK_NODE;
    // 4D: dormant/merged host nodes dim exactly like superseded facts.
    const a = (n.status === 'superseded' || n.life ? 0.35 : 1) * (f == null ? 1 : f);
    return a === 1 ? c : hexToRgba(c, a);
  }

  const idOf = (x) => (x && typeof x === 'object' ? x.id : x);

  // ---- Data -------------------------------------------------------------------
  function prepare(data) {
    const nodes = [];
    const byId = new Map();
    // Domain galaxy seeding: each domain gets a home on a large sphere, so the
    // first paint already reads as colored clusters instead of scattered dust.
    // (131 of ~191 facts have no relations; without seeding they'd drift
    // randomly.) Offsets are hashed from the node id, so the layout is stable
    // across loads. The force simulation still refines from here.
    const SEED_R = 300, SEED_J = 170;
    const centers = {};
    DOMAINS.forEach((d, i) => {
      const a = (i / DOMAINS.length) * Math.PI * 2;
      const b = Math.acos(1 - (2 * (i + 0.5)) / DOMAINS.length);
      centers[d] = {
        x: SEED_R * Math.sin(b) * Math.cos(a),
        y: SEED_R * Math.cos(b) * 0.7,
        z: SEED_R * Math.sin(b) * Math.sin(a),
      };
    });
    const hash01 = (s) => {
      let x = 2166136261;
      for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
      return ((x >>> 0) % 10000) / 10000;
    };
    // 4D: node lifecycle hooks. data.lifecycle carries {node, kind, state?, redirectsTo?}
    // per fact-hosting node page — ids and states only, never fact text. Dormant or
    // merged host pages dim exactly like superseded facts (0.35): same visual
    // language, no new decoration. Read-time dormancy is never published (F3),
    // so `state` here is explicit frontmatter state only.
    const lifecycle = new Map();
    for (const e of Array.isArray(data && data.lifecycle) ? data.lifecycle : []) {
      if (!e || e.node == null) continue;
      lifecycle.set(String(e.node), {
        kind: String(e.kind || ''),
        state: String(e.state || 'active'),
        redirectsTo: e.redirectsTo == null ? '' : String(e.redirectsTo),
      });
    }
    for (const n of Array.isArray(data && data.nodes) ? data.nodes : []) {
      if (!n || n.id == null) continue;
      const id = String(n.id);
      if (byId.has(id)) continue;
      const c = centers[n.domain] || { x: 0, y: 0, z: 0 };
      // Gravity: the core's pull. High-gravity nodes start near the center so
      // the mesh visibly settles around the mind; low-gravity drifts outward.
      // Subtle and stable: initial bias only, the force sim does the rest.
      const grav = Math.min(1, Math.max(0, Number(n.gravity) || 0.10));
      const gR = 300 * (1.25 - grav); // grav 1 -> r=75, grav 0.1 -> r=345
      const th = hash01(id + ':gt') * Math.PI * 2;
      const ph = Math.acos(2 * hash01(id + ':gp') - 1);
      const node = {
        id,
        name: String(n.label == null ? id : n.label),
        val: Math.max(1, Number(n.size) || 1) * (1 + 0.6 * grav), // marginally larger when heavy; never a bubble
        gravity: grav,
        color: DOMAIN_COLORS[n.domain] || FALLBACK_NODE,
        domain: String(n.domain || ''),
        node: String(n.node || ''), // host node page id (4D lifecycle lookup)
        status: String(n.status || ''),
        date: String(n.date || ''),
        cmt: String(n.cmt || ''), // fact.v2 share-time comment; not rendered yet
        x: c.x * 0.25 + gR * Math.sin(ph) * Math.cos(th) + (hash01(id + ':x') - 0.5) * SEED_J,
        y: c.y * 0.25 + gR * Math.sin(ph) * Math.sin(th) + (hash01(id + ':y') - 0.5) * SEED_J,
        z: c.z * 0.25 + gR * Math.cos(ph) + (hash01(id + ':z') - 0.5) * SEED_J,
      };
      // THE core is pinned to the absolute center: it is the origin every
      // beat's pulse emanates from, and the gravity well the mesh settles
      // around. fx/fy/fz are honored by the force sim as fixed positions.
      if (id === 'core') { node.fx = 0; node.fy = 0; node.fz = 0; }
      // 4D: lifecycle state of the host node page. '' = no lifecycle dim.
      const lc = lifecycle.get(node.node);
      node.life = lc && (lc.state === 'dormant' || lc.state === 'merged') ? lc.state : '';
      node.redirectsTo = lc && lc.redirectsTo ? lc.redirectsTo : '';
      node.color = nodeColor(node);
      nodes.push(node);
      byId.set(id, node);
    }
    const edges = [];
    const seen = new Set();
    for (const e of Array.isArray(data && data.edges) ? data.edges : []) {
      if (!e) continue;
      const source = String(idOf(e.source));
      const target = String(idOf(e.target));
      const type = String(e.type || 'CONTEXT');
      if (!byId.has(source) || !byId.has(target)) continue;
      const key = source + '\u0000' + type + '\u0000' + target;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source, target, type });
    }
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      adj.get(e.source).push({ edge: e, other: e.target, dir: 'out' });
      if (e.target !== e.source) adj.get(e.target).push({ edge: e, other: e.source, dir: 'in' });
    }
    // The "core" is the mesh's centre of gravity — the heaviest node,
    // where each beat's pulse originates and which breathes when idle.
    // (A visual anchor only. The real core is the thinking mind, never a node.)
    // His call 2026-10-17: the ONE central core is the node with id 'core' —
    // never a domain hub, no matter how many neighbors it has.
    let coreId = nodes.some((n) => n.id === 'core') ? 'core' : null;
    if (!coreId) {
      let bestScore = -1;
      for (const n of nodes) {
        const deg = (adj.get(n.id) || []).length;
        const score = (n.gravity || 0.1) * 100000 + deg * 1000 + Math.min(999, n.val);
        if (score > bestScore) { bestScore = score; coreId = n.id; }
      }
    }
    // The core's confirmed facts ride the payload (never as nodes): tapping
    // the ONE central core lists them. Sanitized at build time.
    const coreFacts = Array.isArray(data && data.coreFacts)
      ? data.coreFacts.filter((f) => f && f.id && f.text).map((f) => ({ id: String(f.id), text: String(f.text), date: String(f.date || '') }))
      : [];
    return { nodes, byId, edges, adj, coreId, coreFacts };
  }

  // Which nodes/links are on screen given filters + isolation.
  function computeVisible() {
    const { nodes, edges, byId } = S.data;
    let vNodes = nodes.filter((n) => S.domains.has(n.domain) || !DOMAIN_COLORS[n.domain]);
    let ids = new Set(vNodes.map((n) => n.id));
    let vEdges = edges.filter((e) => S.types.has(e.type) && ids.has(e.source) && ids.has(e.target));
    if (S.isolated && ids.has(S.isolated)) {
      const keep = new Set([S.isolated]);
      for (const e of vEdges) {
        if (e.source === S.isolated) keep.add(e.target);
        if (e.target === S.isolated) keep.add(e.source);
      }
      vNodes = vNodes.filter((n) => keep.has(n.id));
      ids = keep;
      vEdges = vEdges.filter((e) => keep.has(e.source) && keep.has(e.target));
    } else {
      S.isolated = null;
    }
    return { vNodes, vEdges, byId };
  }

  function applyData() {
    if (!S) return;
    const { vNodes, vEdges } = computeVisible();
    S.visible = new Set(vNodes.map((n) => n.id));
    // Adjacency over what is actually on screen; focus hops follow this, so
    // filters/isolation change the neighborhood the same way they change the view.
    S.visAdj = new Map(vNodes.map((n) => [n.id, new Set()]));
    for (const e of vEdges) {
      S.visAdj.get(e.source).add(e.target);
      S.visAdj.get(e.target).add(e.source);
    }
    // Node objects persist (keeps x/y/z); links are rebuilt because the engine
    // rewrites source/target into object refs.
    const links = vEdges.map((e) => ({
      source: e.source, target: e.target, type: e.type,
      color: TYPE_COLORS[e.type] || FALLBACK_LINK,
    }));
    S.graph.graphData({ nodes: vNodes, links });
    // Pin the core at the absolute center (his vision 2026-10-16) — node
    // objects persist across applyData calls, so this is idempotent.
    for (const n of vNodes) {
      if (n.id === 'core') { n.fx = 0; n.fy = 0; n.fz = 0; break; }
    }
    if (S.api && typeof S.api.onMeta === 'function') {
      const iso = S.isolated ? ' · isolated' : '';
      S.api.onMeta(vNodes.length + ' facts · ' + vEdges.length + ' relations' + iso);
    }
    if (S.resetBtn) S.resetBtn.hidden = !S.isolated;
    refreshSuggestions();
    updateFocus();
    sparksOnData(links); // U2: rebuild spark pools + node map from the rendered links
    if (S.panelNode && !S.panel.hidden) renderNodePanel(S.panelNode); // refresh hidden-by-filter rows
  }

  // ---- Focus (magnetic dimming) -----------------------------------------------
  // Dimming rides on colour alpha: 3d-force-graph multiplies nodeOpacity /
  // linkOpacity (global scalars) by each colour's alpha, so per-element
  // dimming has to go through the colour accessors.
  function computeFocusSet() {
    // Hover takes temporary priority (live 1-hop preview); a click pins the
    // selection at its chosen depth. Hover-out falls back to the pinned node.
    const anchor = S.hovered || S.selected;
    if (!anchor || !S.visible.has(anchor)) return null;
    const depth = S.hovered ? 1 : S.focusDepth;
    const set = new Map([[anchor, 0]]);
    let frontier = [anchor];
    for (let hop = 1; hop <= depth; hop++) {
      const next = [];
      for (const id of frontier) {
        for (const o of S.visAdj.get(id) || []) {
          if (!set.has(o)) { set.set(o, hop); next.push(o); }
        }
      }
      frontier = next;
    }
    return set;
  }

  // Opacity factor for a node: 1 when in focus (or no focus), DIM otherwise.
  function focusOpacity(id, dim = DIM) {
    return !S || !S.focusSet || S.focusSet.has(id) ? 1 : dim;
  }

  // Focus-aware link particles: dimmed links show no particles (their
  // materials take the link colour with alpha dropped, so they'd otherwise
  // render full-bright on a dimmed link).
  function particleCount(l) {
    if (fxSession.drawing.size && fxSession.drawing.has(linkKey(l))) return 1;
    if (sparksOn()) return 0; // U2: the custom spark layer replaces ambient particles
    if (!S || !S.focusSet) return 1;
    return (S.focusSet.has(idOf(l.source)) && S.focusSet.has(idOf(l.target))) ? 1 : 0;
  }

  // The focus light-up, shared by selection and by lightning strikes (U2 v2.1):
  // link colour at factor f (1 = solid, lower = dimmed/decaying) and the halo
  // emphasis a node earns. A strike feeds the same functions a transient factor.
  function focusLinkColor(l, f) { return f >= 1 ? l.color : hexToRgba(l.color, f); }
  function focusHaloBoost(id) {
    if (S.selected === id) return 1.6;
    const lv = strikeNodeLevel(id);
    return lv > 0 ? 1.6 * lv : 1;
  }

  function updateFocus() {
    if (!S || !S.graph) return;
    S.focusSet = computeFocusSet();
    const dim = S.hovered ? DIM_HOVER : DIM;
    // Re-setting an accessor makes the lib re-digest node/link materials.
    S.graph
      .nodeColor((n) => nodeColor(n, focusOpacity(n.id, dim)))
      .linkColor((l) => {
        const f = !S.focusSet || (S.focusSet.has(idOf(l.source)) && S.focusSet.has(idOf(l.target))) ? 1 : dim;
        let c = focusLinkColor(l, f);
        // Domain breath: links inside the most active domain oscillate ±0.03 —
        // almost imperceptible, and only when there is real recent activity.
        const bd = S.live && S.live.breathDomain;
        if (bd && !S.live.hold) {
          const a = linkNode(l.source), b = linkNode(l.target);
          if (a && b && a.domain === bd && b.domain === bd) {
            const t = (performance.now() - (S.live.breathT0 || performance.now())) / 1000;
            c = scaleAlpha(c, 1 + 0.03 * Math.sin(t * 0.9));
          }
        }
        if (!S.focusSet && !isDomainLink(l)) c = scaleAlpha(c, LINK_END_ALPHA); // recession: default view only
        return c;
      })
      .linkDirectionalParticles((l) => particleCount(l));
    sparksRefreshVisibility(); // U2: focus neighbourhood lines solid, the rest hidden
    // Halo dimming rides alongside the core's colour-alpha dimming.
    // The per-frame painter owns the halos (breathing core,
    // echo glows); node/link colour accessors above still run.
    const nodes = S.graph.graphData().nodes;
    if (S.live && S.live.on) { paintLiveHalos(nodes); return; }
    applyRestHalos(nodes, dim);
  }

  function applyRestHalos(nodes, dim) {
    for (const n of nodes) {
      if (!n._halo) continue;
      // Rest state: halo off. Only the selected node, struck nodes and fresh nodes earn a glow.
      const show = (S.selected === n.id) || isFresh(n.id) || strikeNodeLevel(n.id) > 0;
      if (!show) { setHaloOpacity(n._halo, 0); continue; }
      const a = (n.status === 'superseded' || n.life ? 0.35 : 1) * focusOpacity(n.id, dim);
      const boost = focusHaloBoost(n.id);
      const fresh = isFresh(n.id) ? 1.9 : 1;
      setHaloOpacity(n._halo, Math.min(0.5, HALO_OPACITY * a * boost * fresh));
    }
  }

  // Tap semantics: new node -> focus 1-hop; same selected node -> toggle 2-hop.
  function tapNode(id) {
    if (!S) return;
    if (S.selected === id) {
      S.focusDepth = S.focusDepth === 1 ? 2 : 1;
      renderNodePanel(S.data.byId.get(id));
      updateFocus();
    } else {
      select(id, false);
    }
  }

  function toggleDepth() {
    if (S && S.selected) tapNode(S.selected);
  }

  // ---- Camera -----------------------------------------------------------------
  function flyTo(node) {
    if (!S || !node) return;
    const dist = 110;
    const mag = Math.hypot(node.x || 0, node.y || 0, node.z || 0);
    const pos = mag > 0.001
      ? { x: node.x * (1 + dist / mag), y: node.y * (1 + dist / mag), z: node.z * (1 + dist / mag) }
      : { x: 0, y: 0, z: dist };
    S.graph.cameraPosition(pos, { x: node.x || 0, y: node.y || 0, z: node.z || 0 }, 900);
  }

  // ---- Selection / isolation --------------------------------------------------
  function select(id, fly) {
    if (!S) return;
    const node = S.data.byId.get(id);
    if (!node) return;
    if (!S.visible.has(id)) return;
    if (S.selected !== id) S.focusDepth = 1;
    S.selected = id;
    renderNodePanel(node);
    updateFocus();
    if (fly) {
      const live = S.graph.graphData().nodes.find((n) => n.id === id);
      flyTo(live || node);
    }
  }

  function isolate(id) {
    if (!S) return;
    S.isolated = id;
    applyData();
    select(id, false);
    // Re-settle the smaller layout, then frame it.
    S.fitOnStop = true;
    S.graph.d3ReheatSimulation();
  }

  function resetIsolation() {
    if (!S || !S.isolated) return;
    S.isolated = null;
    applyData();
    S.fitOnStop = true;
    S.graph.d3ReheatSimulation();
  }

  // Centroid of the nodes currently on screen — the "middle of the network".
  function graphCenter() {
    if (!S || !S.graph) return { x: 0, y: 0, z: 0 };
    const nodes = S.graph.graphData().nodes;
    if (!nodes.length) return { x: 0, y: 0, z: 0 };
    let x = 0, y = 0, z = 0;
    for (const n of nodes) { x += n.x || 0; y += n.y || 0; z += n.z || 0; }
    return { x: x / nodes.length, y: y / nodes.length, z: z / nodes.length };
  }

  // Distance from the camera to its current orbit target. Used to tell overview
  // (zoomed out) apart from exploration (zoomed in close to a node).
  function cameraDistToTarget() {
    if (!S || !S.graph) return Infinity;
    try {
      const cam = S.graph.camera();
      const t = S.graph.controls().target;
      const dx = cam.position.x - t.x, dy = cam.position.y - t.y, dz = cam.position.z - t.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    } catch (e) { return Infinity; }
  }

  // Zoom threshold: beyond this distance we're in overview (orbit around the
  // core is fine); within it the user is exploring — hands off the camera.
  const OVERVIEW_DIST = 300;

  // Clears selection, closes the panel, restores full opacity.
  function closePanel() {
    if (!S) return;
    S.selected = null;
    S.hovered = null;
    S.hoverLink = null;
    S.focusDepth = 1;
    S.panelNode = null;
    S.panel.hidden = true;
    S.tip.hidden = true;
    armResume();
    // Return the orbit target to the middle of the network ONLY when zoomed out
    // (overview). When zoomed in exploring a node, leave the target where the
    // user put it — exploration-first, no sticky snap-back (his call 2026-10-17).
    if (cameraDistToTarget() > OVERVIEW_DIST) {
      const cam = S.graph.camera();
      S.graph.cameraPosition(
        { x: cam.position.x, y: cam.position.y, z: cam.position.z },
        graphCenter(),
        800
      );
    }
    updateFocus();
  }

  // ---- Detail panel -----------------------------------------------------------
  function chip(text, color) {
    const c = h('span', 'u-chip', text);
    if (color) c.style.setProperty('--chip', color);
    return c;
  }

  function panelHead(title) {
    S.panel.textContent = '';
    const head = h('div', 'u-panel-head');
    head.append(h('span', 'u-panel-kicker', title));
    const close = h('button', 'u-btn u-btn-icon', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close details');
    close.addEventListener('click', closePanel);
    head.append(close);
    S.panel.append(head);
  }

  function neighborButton(id, extra) {
    const n = S.data.byId.get(id);
    const label = n ? n.name : id;
    const b = h('button', 'u-neighbor');
    b.type = 'button';
    const dot = h('i', 'u-dot');
    dot.style.background = n ? (DOMAIN_COLORS[n.domain] || FALLBACK_NODE) : FALLBACK_NODE;
    b.append(dot, h('span', 'u-neighbor-label', label));
    if (extra) b.append(h('small', 'u-neighbor-dir', extra));
    if (n && S.visible.has(id)) {
      b.addEventListener('click', () => select(id, true));
    } else {
      b.disabled = true;
      b.title = 'Hidden by current filters';
    }
    return b;
  }

  // One row per neighbor; parallel edges of different types share the row.
  function neighborRow(id, rels) {
    const row = neighborButton(id, rels.map((r) => (r.dir === 'out' ? '→ ' : '← ') + r.edge.type).join(' · '));
    row.dataset.relations = rels.map((r) => r.edge.type).join(',');
    return row;
  }

  function renderNodePanel(node) {
    S.panelNode = node;
    panelHead('Fact ' + node.id);
    S.panel.append(h('h2', 'u-title', node.name));

    const chips = h('div', 'u-chips');
    if (node.domain) chips.append(chip(node.domain, DOMAIN_COLORS[node.domain]));
    if (node.status) chips.append(chip(node.status));
    if (node.date) chips.append(chip(node.date));
    S.panel.append(chips);

    // THE core: tapping the center lists every confirmed fact it holds.
    // One core, one list — the self, readable.
    if (node.id === 'core' && S.data.coreFacts && S.data.coreFacts.length) {
      const sec = h('section', 'u-group');
      sec.append(h('h3', 'u-group-title', 'Core facts (' + S.data.coreFacts.length + ')'));
      for (const cf of S.data.coreFacts) {
        const row = h('div', 'u-why');
        row.append(h('div', 'u-neighbor-dir', cf.id + (cf.date ? ' · ' + cf.date : '')));
        row.append(h('div', '', cf.text));
        sec.append(row);
      }
      S.panel.append(sec);
    }

    // 4D: merged nodes show a redirect to the target node (read-only, same
    // muted text style as the rest of the panel — no new decoration).
    if (node.life === 'merged' && node.redirectsTo) {
      S.panel.append(h('p', 'u-muted', 'This node was merged into ' + node.redirectsTo + '.'));
    }

    const actions = h('div', 'u-actions');
    const focus = h('button', 'u-btn', 'Focus');
    focus.type = 'button';
    focus.addEventListener('click', () => select(node.id, true));
    const iso = h('button', 'u-btn', S.isolated === node.id ? 'Show all' : 'Isolate');
    iso.type = 'button';
    iso.addEventListener('click', () => (S.isolated === node.id ? resetIsolation() : isolate(node.id)));
    actions.append(focus, iso);
    if (S.selected === node.id) {
      const depth = h('button', 'u-btn', S.focusDepth === 1 ? 'Show 2 hops' : 'Show 1 hop');
      depth.type = 'button';
      depth.addEventListener('click', toggleDepth);
      actions.append(depth);
    }
    S.panel.append(actions);

    const rels = S.data.adj.get(node.id) || [];
    if (!rels.length) {
      S.panel.append(h('p', 'u-muted', 'No relations recorded.'));
    } else {
      const byNeighbor = new Map();
      for (const r of rels) {
        if (r.other === node.id) continue; // self-loop
        if (!byNeighbor.has(r.other)) byNeighbor.set(r.other, []);
        byNeighbor.get(r.other).push(r);
      }
      const rank = (list) => Math.min(...list.map((r) => {
        const i = TYPES.indexOf(r.edge.type);
        return i < 0 ? TYPES.length : i;
      }));
      const nameOf = (id) => (S.data.byId.get(id) || { name: id }).name;
      const ordered = [...byNeighbor.entries()].sort((a, b) => (
        rank(a[1]) - rank(b[1]) || nameOf(a[0]).localeCompare(nameOf(b[0]))));
      const sec = h('section', 'u-group');
      sec.append(h('h3', 'u-group-title', 'Neighbors (' + ordered.length + ')'));
      for (const [id, list] of ordered) sec.append(neighborRow(id, list));
      S.panel.append(sec);
    }
    S.panel.hidden = false;
  }

  // The declaring fact of an edge is always its source: build-graph emits source -> target exactly as
  // written in the source fact's "-> TYPE [F-ID]" segment, so no separate provenance field is needed.
  function renderEdgePanel(link) {
    const a = idOf(link.source);
    const b = idOf(link.target);
    S.panelNode = null;
    panelHead('Relation');
    const title = h('h2', 'u-title');
    const sw = h('i', 'u-swatch');
    sw.style.background = TYPE_COLORS[link.type] || FALLBACK_LINK;
    title.append(sw, document.createTextNode(link.type));
    S.panel.append(title);

    // Every edge between the pair, either direction; the clicked one first.
    const all = (S.data.adj.get(a) || []).filter((r) => r.other === b).map((r) => r.edge);
    const clicked = all.findIndex((e) => e.source === a && e.target === b && e.type === link.type);
    if (clicked > 0) all.unshift(all.splice(clicked, 1)[0]);
    const why = h('section', 'u-group');
    why.append(h('h3', 'u-group-title', all.length > 1 ? 'Why (' + all.length + ' relations)' : 'Why'));
    for (const e of all.length ? all : [link]) {
      const src = S.data.byId.get(String(idOf(e.source)));
      const row = h('div', 'u-why');
      row.dataset.relation = e.type;
      row.append(h('div', 'u-neighbor-dir', e.type + ' · ' + idOf(e.source) + ' → ' + idOf(e.target)));
      const text = src ? [...src.name].slice(0, 140).join('') : 'Unrecorded';
      row.append(h('p', 'u-muted', text));
      if (src && src.date) row.append(h('small', 'u-neighbor-dir', 'Declared by ' + src.id + ' · recorded ' + src.date));
      why.append(row);
    }
    S.panel.append(why);

    const grp = h('section', 'u-group');
    grp.append(h('h3', 'u-group-title', 'From'), neighborButton(a));
    grp.append(h('h3', 'u-group-title', 'To'), neighborButton(b));
    S.panel.append(grp);
    S.panel.hidden = false;
  }

  // ---- Click handling (single vs double) --------------------------------------
  function onNodeClick(node) {
    if (!S || !node) return;
    if (S.clickTimer && S.clickNode === node.id) {
      clearTimeout(S.clickTimer);
      S.clickTimer = null;
      S.clickNode = null;
      isolate(node.id);
      return;
    }
    if (S.clickTimer) clearTimeout(S.clickTimer);
    S.clickNode = node.id;
    S.clickTimer = setTimeout(() => {
      if (!S) return;
      S.clickTimer = null;
      S.clickNode = null;
      tapNode(node.id);
    }, DBLCLICK_MS);
  }

  function onBackgroundClick() {
    if (!S) return;
    closePanel(); // background tap clears the selection / focus
    const now = Date.now();
    if (now - S.lastBgClick < DBLCLICK_MS) {
      S.lastBgClick = 0;
      resetIsolation();
    } else {
      S.lastBgClick = now;
    }
  }

  // ---- Search -----------------------------------------------------------------
  function matches(q) {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const out = [];
    for (const n of S.data.nodes) {
      if (!S.visible.has(n.id)) continue;
      if (n.name.toLowerCase().includes(needle) || n.id.toLowerCase().includes(needle)) {
        out.push(n);
        if (out.length >= 8) break;
      }
    }
    return out;
  }

  function refreshSuggestions() {
    if (!S || !S.suggest) return;
    S.suggest.textContent = '';
    const list = matches(S.search.value);
    S.suggest.hidden = !list.length;
    for (const n of list) {
      const li = h('li');
      const b = h('button', 'u-suggest-item');
      b.type = 'button';
      const dot = h('i', 'u-dot');
      dot.style.background = DOMAIN_COLORS[n.domain] || FALLBACK_NODE;
      b.append(dot, h('span', 'u-neighbor-label', n.name), h('small', 'u-neighbor-dir', n.id));
      b.addEventListener('click', () => pickSearch(n));
      li.append(b);
      S.suggest.append(li);
    }
  }

  function pickSearch(n) {
    if (!S) return;
    S.suggest.hidden = true;
    select(n.id, true);
  }

  // ---- Filters / legend -------------------------------------------------------
  function onFilterChange() {
    S.isolated = null; // any filter change restores the full (filtered) graph
    applyData();
    if (S.selected && !S.visible.has(S.selected)) closePanel();
    S.fitOnStop = true;
    S.graph.d3ReheatSimulation();
  }

  function legendRow(kind, key, color, count) {
    const set = kind === 'domain' ? S.domains : S.types;
    const b = h('button', 'u-legend-row');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'true');
    const sw = h('i', 'u-swatch' + (kind === 'type' ? ' u-swatch-line' : ''));
    sw.style.background = color;
    b.append(sw, h('span', 'u-legend-name', key), h('small', 'u-legend-count', String(count)));
    b.addEventListener('click', () => {
      const on = !set.has(key);
      if (on) set.add(key); else set.delete(key);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('u-off', !on);
      onFilterChange();
    });
    return b;
  }

  function buildLegend() {
    const box = h('div', 'u-legend');
    const dCount = new Map();
    for (const n of S.data.nodes) dCount.set(n.domain, (dCount.get(n.domain) || 0) + 1);
    const tCount = new Map();
    for (const e of S.data.edges) tCount.set(e.type, (tCount.get(e.type) || 0) + 1);

    // Collapsible legend sections (his call 2026-10-16): tap the header to
    // expand/collapse. Same visual language — header becomes a button, rows
    // hide with the section. No redesign.
    function collapsibleSection(title, rows) {
      const sec = h('div', 'u-legend-sec');
      const head = h('button', 'u-legend-title');
      head.type = 'button';
      head.setAttribute('aria-expanded', 'true');
      head.append(h('span', null, title), h('span', 'u-legend-caret', '▾'));
      const body = h('div', 'u-legend-rows');
      for (const r of rows) body.append(r);
      head.addEventListener('click', () => {
        const collapsed = body.classList.toggle('collapsed');
        head.setAttribute('aria-expanded', String(!collapsed));
        head.querySelector('.u-legend-caret').textContent = collapsed ? '▸' : '▾';
      });
      sec.append(head, body);
      body.classList.add('collapsed');
      head.setAttribute('aria-expanded', 'false');
      head.querySelector('.u-legend-caret').textContent = '▸';
      return sec;
    }

    const dRows = DOMAINS.map((d) => legendRow('domain', d, DOMAIN_COLORS[d], dCount.get(d) || 0));
    const tRows = TYPES.map((t) => legendRow('type', t, TYPE_COLORS[t], tCount.get(t) || 0));
    box.append(collapsibleSection('Domains', dRows));
    box.append(collapsibleSection('Relations', tRows));
    return box;
  }

  // ---- Lifecycle --------------------------------------------------------------
  function size() {
    return { w: S.container.clientWidth || window.innerWidth, h: S.container.clientHeight || window.innerHeight };
  }

  function onResize() {
    if (!S) return;
    const d = size();
    S.graph.width(d.w).height(d.h);
  }

  // Track the input in hand (mouse/pen/touch). Default (nothing seen yet) allows hover.
  function onModality(e) {
    if (!S || !e.pointerType) return;
    const prev = S.modality;
    S.modality = e.pointerType;
    if (prev === 'touch' && S.modality !== 'touch' && (S.hovered || S.hoverLink)) {
      S.hovered = null; // drop stale touch-era hover state
      S.hoverLink = null;
      S.tip.hidden = true;
      S.stage.style.cursor = '';
      updateFocus();
    }
  }

  // ---- Idle auto-rotate resume (design doc A10) ----
  const ROTATE_SPEED = 0.55;
  const IDLE_RESUME_MS = 3500;
  const ROTATE_RAMP_MS = 1000;

  function stopRotation() {
    if (!S) return;
    if (S.idleTimer) { clearTimeout(S.idleTimer); S.idleTimer = null; }
    if (S.rampRaf) { cancelAnimationFrame(S.rampRaf); S.rampRaf = null; }
    if (S.ctl) S.ctl.autoRotate = false;
  }

  // (Re)start the quiet-period countdown. Rotation only returns when nothing is
  // hovered, nothing is selected/focused and the detail panel is closed; hover end
  // and closePanel() re-arm the timer.
  function armResume() {
    if (!S || !S.ctl) return;
    if (S.idleTimer) clearTimeout(S.idleTimer);
    S.idleTimer = setTimeout(() => {
      if (!S) return;
      S.idleTimer = null;
      if (S.pointerHeld || S.hovered || S.hoverLink || S.selected || S.panelNode || !S.panel.hidden) return;
      const ctl = S.ctl;
      const t0 = performance.now();
      ctl.autoRotateSpeed = 0;
      ctl.autoRotate = true;
      const step = (now) => {
        if (!S) return;
        const k = Math.min(1, (now - t0) / ROTATE_RAMP_MS);
        ctl.autoRotateSpeed = ROTATE_SPEED * k;
        S.rampRaf = k < 1 ? requestAnimationFrame(step) : null;
      };
      S.rampRaf = requestAnimationFrame(step);
    }, IDLE_RESUME_MS);
  }

  // ---- S3 space-explorer keys: held-key fly loop (B3) + Tab walk (D4) ----
  // Driven by the ONE key map (window.BRAIN_KEYMAP, owned by app.js — D3).
  const FLY_ACTIONS_3D = new Set(['fly-up', 'fly-down', 'fly-left', 'fly-right']);
  const REDUCED_3D = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const heldFly3D = new Set();
  let flyRaf3D = 0;
  function orbitStep3D(dYaw, dPitch, dZoom) {
    const ctl = S && S.ctl;
    if (!ctl || !ctl.object || !ctl.target) return;
    const cam = ctl.object, tgt = ctl.target;
    let ox = cam.position.x - tgt.x, oy = cam.position.y - tgt.y, oz = cam.position.z - tgt.z;
    if (dYaw) {
      const c = Math.cos(dYaw), s = Math.sin(dYaw);
      const nx = ox * c + oz * s, nz = -ox * s + oz * c;
      ox = nx; oz = nz;
    }
    if (dPitch) {
      const hd = Math.hypot(ox, oz) || 1e-6;
      const c = Math.cos(dPitch), s = Math.sin(dPitch);
      const nhd = hd * c - oy * s;
      oy = hd * s + oy * c;
      const k = nhd / hd;
      ox *= k; oz *= k;
    }
    if (dZoom && dZoom !== 1) { ox *= dZoom; oy *= dZoom; oz *= dZoom; }
    cam.position.set(tgt.x + ox, tgt.y + oy, tgt.z + oz);
    cam.lookAt(tgt);
    if (typeof ctl.update === 'function') ctl.update();
  }
  function flyTick3D() {
    flyRaf3D = 0;
    if (!heldFly3D.size || !S) return;
    const yawStep = REDUCED_3D ? 0.008 : 0.03;
    const pitchStep = REDUCED_3D ? 0.006 : 0.022;
    let yaw = 0, pitch = 0;
    for (const a of heldFly3D) {
      if (a === 'fly-up') pitch += pitchStep;
      else if (a === 'fly-down') pitch -= pitchStep;
      else if (a === 'fly-left') yaw += yawStep;
      else if (a === 'fly-right') yaw -= yawStep;
    }
    if (yaw || pitch) orbitStep3D(yaw, pitch, 1);
    flyRaf3D = requestAnimationFrame(flyTick3D);
  }
  function holdFly3D(action, on) {
    if (on) heldFly3D.add(action); else heldFly3D.delete(action);
    if (heldFly3D.size && !flyRaf3D) flyRaf3D = requestAnimationFrame(flyTick3D);
    else if (!heldFly3D.size && flyRaf3D) { cancelAnimationFrame(flyRaf3D); flyRaf3D = 0; }
  }
  function clearFly3D() { heldFly3D.clear(); if (flyRaf3D) { cancelAnimationFrame(flyRaf3D); flyRaf3D = 0; } }

  // D4 relation order (3D): neighbours of the selected node in link order,
  // then remaining nodes in stable build order.
  function relationOrder3D() {
    const order = [], seen = new Set();
    if (!S || !S.graph) return order;
    const data = S.graph.graphData();
    const sel = S.selected;
    if (sel) {
      for (const l of (data.links || [])) {
        const aid = l.source && l.source.id !== undefined ? l.source.id : l.source;
        const bid = l.target && l.target.id !== undefined ? l.target.id : l.target;
        const other = aid === sel ? bid : (bid === sel ? aid : null);
        if (other !== null && other !== undefined && !seen.has(other)) { seen.add(other); order.push(other); }
      }
      seen.add(sel);
    }
    for (const n of (data.nodes || [])) {
      if (!seen.has(n.id)) { seen.add(n.id); order.push(n.id); }
    }
    return order;
  }
  function walkNodes3D(e, dir) {
    const order = relationOrder3D();
    if (!order.length) return;
    const cur = S.selected ? order.indexOf(S.selected) : -1;
    let next = null;
    if (dir > 0) {
      if (cur >= order.length - 1) return; // past the last node: native Tab order (no trap)
      next = order[cur + 1];
    } else {
      if (cur <= 0) return; // before the first node: native Shift+Tab order (no trap)
      next = order[cur - 1];
    }
    e.preventDefault();
    tapNode(next);
    const region = document.getElementById('universe');
    if (region && typeof region.focus === 'function') region.focus({ preventScroll: true });
  }

  // B5: dismiss the topmost portal panel (owned by app.js, via the S3 bridge).
  // Returns true when something was dismissed.
  function dismissTopPanel3D() {
    const bridge = window.__brainS3 || {};
    if (bridge.keymapOpen && bridge.keymapOpen()) { bridge.closeKeymap(); return true; }
    if (bridge.settingsOpen && bridge.settingsOpen()) { bridge.closeSettings(); return true; }
    if (bridge.dumpOpen && bridge.dumpOpen()) { if (!bridge.dumpUploading || !bridge.dumpUploading()) bridge.closeDump(); return true; }
    return false;
  }

  function onKeyDown(e) {
    const is3DView = document.body.classList.contains('view-3d');
    if (!is3DView) return; // B1: the 2D handler owns keys in 2D view — one keypress, one action
    const t = e.target;
    if (e.key === 'Escape') {
      if (dismissTopPanel3D()) return; // B5: ? overlay -> settings/dump panel
      const te = (t && t.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(te) || (t && t.isContentEditable)) return; // form fields handle their own Escape
      closePanel();
      return;
    }
    if ((t && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable)) || e.metaKey || e.ctrlKey || e.altKey) return; // B6: never while typing or with modifiers
    const KM = window.BRAIN_KEYMAP;
    const entry = KM && (KM[e.code] || KM[e.key]);
    if (!entry) return; // unbound key: ignore — auto-rotate untouched (B6)
    if (S && S.ctl) { stopRotation(); armResume(); } // real action keys only (B6)
    const tag = (t && t.tagName) || '';
    if (FLY_ACTIONS_3D.has(entry.action)) {
      e.preventDefault();
      if (!e.repeat) holdFly3D(entry.action, true); // B3: rAF loop, not OS key-repeat
      return;
    }
    if (e.key === 'Tab') {
      // D4: the Tab walk applies only while focus is on the universe region itself.
      if (document.activeElement !== document.getElementById('universe')) return; // native order elsewhere — no trap
      walkNodes3D(e, e.shiftKey ? -1 : 1);
      return;
    }
    if (entry.action === 'zoom-in') { e.preventDefault(); orbitStep3D(0, 0, 1 / 1.25); return; }
    if (entry.action === 'zoom-out') { e.preventDefault(); orbitStep3D(0, 0, 1.25); return; }
    if (entry.action === 'focus-node') {
      if (S && S.selected && window.BrainUniverse && window.BrainUniverse.focusNode) {
        e.preventDefault(); window.BrainUniverse.focusNode(S.selected);
      }
      return;
    }
    if (entry.action === 'open-node') {
      if (/^(BUTTON|A|SUMMARY)$/.test(tag)) return; // B4: native activation wins
      if (S && S.selected) { e.preventDefault(); tapNode(S.selected); }
      return;
    }
    if (entry.action === 'keymap') { e.preventDefault(); const b3 = window.__brainS3 || {}; if (b3.openKeymap) b3.openKeymap(); return; }
    if (entry.action === 'dump') { e.preventDefault(); const b3 = window.__brainS3 || {}; if (b3.openDump) b3.openDump(); return; } // D1: U opens the dump
  }

  function onKeyUp3D(e) {
    const KM = window.BRAIN_KEYMAP;
    const entry = KM && (KM[e.code] || KM[e.key]);
    if (entry && FLY_ACTIONS_3D.has(entry.action)) holdFly3D(entry.action, false);
  }

  function onPointerMove(e) {
    if (!S || S.tip.hidden) return;
    const r = S.container.getBoundingClientRect();
    S.tip.style.left = (e.clientX - r.left + 14) + 'px';
    S.tip.style.top = (e.clientY - r.top + 14) + 'px';
  }

  function init(container, graphData, api) {
    if (!container || typeof window.ForceGraph3D !== 'function') {
      console.error('BrainUniverse: container or ForceGraph3D missing');
      return;
    }
    if (S) destroy();

    S = {
      container, api: api || {}, data: prepare(graphData),
      domains: new Set(DOMAINS), types: new Set(TYPES),
      visible: new Set(), isolated: null, selected: null,
      clickTimer: null, clickNode: null, lastBgClick: 0,
      focusDepth: 1, focusSet: null, visAdj: new Map(), panelNode: null,
      fitOnStop: true, paused: false, hovered: null, hoverLink: null,
    };

    container.textContent = '';
    const stage = h('div', 'u-stage');
    container.append(stage);
    S.stage = stage;

    // Overlay UI
    const ui = h('div', 'u-ui');
    S.ui = ui;
    const searchWrap = h('div', 'u-search');
    S.search = h('input', 'u-search-input');
    S.search.type = 'search';
    S.search.placeholder = 'Search facts…';
    S.search.autocomplete = 'off';
    S.search.spellcheck = false;
    S.search.setAttribute('aria-label', 'Search facts');
    S.suggest = h('ul', 'u-suggest');
    S.suggest.hidden = true;
    S.search.addEventListener('input', refreshSuggestions);
    S.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = matches(S.search.value)[0];
        if (first) pickSearch(first);
      } else if (e.key === 'Escape') {
        S.search.value = '';
        refreshSuggestions();
      }
    });
    searchWrap.append(S.search, S.suggest);

    S.legendBox = buildLegend();

    const controls = h('div', 'u-controls');
    // Pause/Reheat/Fit removed — not useful (his call 2026-10-10).
    S.resetBtn = h('button', 'u-btn', 'Reset');
    S.resetBtn.type = 'button';
    S.resetBtn.hidden = true;
    S.resetBtn.addEventListener('click', resetIsolation);
    controls.append(S.resetBtn);
    // No Live button — there is no mode to enter. The single view is alive
    // (his call 2026-10-13): the ambient systems start with the scene.

    S.panel = h('aside', 'u-panel');
    S.panel.hidden = true;
    S.tip = h('div', 'u-tip');
    S.tip.hidden = true;

    const left = h('div', 'u-left');
    left.append(searchWrap, S.legendBox);
    ui.append(left, controls, S.panel, S.tip);
    container.append(ui);

    // Graph
    const d = size();
    S.graph = window.ForceGraph3D({ controlType: 'orbit' })(stage)
      .width(d.w).height(d.h)
      .backgroundColor('rgba(0,0,0,0)') // transparent: deep-space background shows through
      .showNavInfo(false)
      .nodeId('id')
      .nodeVal((n) => {
        // His call 2026-10-17: core largest, domain hubs medium, end nodes smallest.
        if (!n) return 4;
        if (n.id === 'core') return 8;
        if (n.id && String(n.id).startsWith('domain-')) return 6;
        return (n.size || 4);
      })
      .nodeColor('color')
      // Node variety (his call): seeded size jitter so the brain looks organic,
      // not uniform. Opacity stays full — nodes must glow like stars, never faint.
      .nodeRelSize(4)
      .nodeOpacity(1)
      .nodeResolution(16)
      .nodeLabel(() => '') // library tooltip stays off (prime suspect for the hover shift-down); we render our own hover tip instead
      .linkColor((l) => {
        // His call 2026-10-17: core->hub stays visible (0.38);
        // end->domain (fact->hub) slightly fainter (0.25);
        // end-to-end relations untouched.
        if (l && (l.type || '').toUpperCase() === 'DOMAIN') {
          const s = l.source, tg = l.target;
          const sId = s && (s.id || s), tId = tg && (tg.id || tg);
          if (sId === 'core' || tId === 'core') return 'rgba(234, 246, 255, 0.38)';
          return 'rgba(234, 246, 255, 0.25)';
        }
        if (l) return scaleAlpha(l.color || '#9aa0b4', LINK_END_ALPHA);
        return l.color || '#9aa0b4';
      })
      .linkOpacity(0.55)
      .linkWidth((l) => {
        // His call 2026-10-17: core -> domain hubs slightly thicker (highways);
        // domain -> end nodes and end <-> end stay thin (streets), as before.
        // DOMAIN links are faint flow channels, not bright spokes.
        const t = l && l.type;
        if (t === 'DOMAIN') {
          const s = l.source, tg = l.target;
          const sId = s && (s.id || s), tId = tg && (tg.id || tg);
          // Core <-> domain hub: slightly thicker. Domain hub <-> fact: thin.
          if (sId === 'core' || tId === 'core') return 1.2;
        }
        return 0.6;
      })
      .linkDirectionalParticles((l) => {
        // Flow particles only on core <-> domain highways.
        if (l && l.type === 'DOMAIN') {
          const s = l.source, tg = l.target;
          const sId = s && (s.id || s), tId = tg && (tg.id || tg);
          if (sId === 'core' || tId === 'core') return 2;
        }
        return particleCount(l);
      })
      .linkDirectionalParticleWidth(1.6)
      // Packet desync (his call): was a constant 0.004 — every packet on every
      // edge marched in lockstep like clockwork. Now a seeded ~4x speed range
      // per edge: packets drift out of phase, like neural firing, not a metronome.
      .linkDirectionalParticleSpeed((l) => 0.0018 + 0.0052 * hash01('ps' + linkKey(l)))
      .linkLabel(() => '') // we render our own tooltip
      .cooldownTime(15000)
      .enableNodeDrag(false) // P2-T3: node micro-drags swallowed taps (clickAfterDrag defaults false); orbit/pan unaffected, nothing uses onNodeDrag
      .onNodeClick(onNodeClick)
      .onBackgroundClick(onBackgroundClick)
      .onNodeHover((node) => {
        if (!S) return;
        // No hover tooltips while the input in hand is touch — tap opens the detail panel
        // instead (his call 2026-10-10). Modality, not capability: a mouse on a touch laptop hovers.
        if (S.modality === 'touch') return;
        const id = node ? node.id : null;
        if (S.hovered === id) return;
        S.hovered = id;
        if (id) stopRotation(); else armResume();
        if (node) {
          S.tip.textContent = node.name;
          S.tip.hidden = false;
        } else if (!S.hoverLink) {
          S.tip.hidden = true;
        }
        S.stage.style.cursor = (node || S.hoverLink) ? 'pointer' : '';
        updateFocus(); // live 1-hop highlight follows the hover
      })
      .onLinkHover((link) => {
        if (!S) return;
        // No hover tooltips while the input in hand is touch (his call 2026-10-10).
        if (S.modality === 'touch') return;
        S.hoverLink = link || null;
        if (link) stopRotation(); else armResume();
        if (!S.hovered) { // node hover takes tip priority
          if (link) {
            S.tip.textContent = link.type;
            S.tip.hidden = false;
          } else {
            S.tip.hidden = true;
          }
        }
        S.stage.style.cursor = (link || S.hovered) ? 'pointer' : '';
      })
      .onLinkClick((link) => { if (S && link) renderEdgePanel(link); })
      .onEngineStop(() => {
        if (!S) return;
        updateFocus(); // re-apply dimming once the layout settles
        // On touch: don't auto-fit — let the user control the view (his call 2026-10-10).
        const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        if (S.fitOnStop && !isTouch) {
          S.fitOnStop = false;
          S.graph.zoomToFit(800, 40);
        } else {
          S.fitOnStop = false;
        }
      }); // end .onEngineStop chain

    // ---- Force tuning: the living-brain layout (his vision 2026-10-16) ----
    // Stronger repulsion -> neurons disperse evenly, the 3D space feels full
    // (bhar bhar) instead of clumping. Confidence gravity -> each node's orbit
    // radius is set by its gravity score: high-confidence facts hug the core,
    // uncertain ones drift to the rim; domain hubs (0.85) form the inner shell.
    try {
      const charge = S.graph.d3Force('charge');
      if (charge && typeof charge.strength === 'function') charge.strength(-110);
    } catch (e) { /* force unavailable — non-fatal */ }
    // His call 2026-10-17: scattered brain, not divisions. DOMAIN edges are
    // flow channels (core->hub->fact pulses), NOT clustering forces.
    // End-to-end relation links dominate the layout; DOMAIN links get
    // near-zero strength so nodes stay scattered by their real relations.
    try {
      const link = S.graph.d3Force('link');
      if (link && typeof link.strength === 'function') {
        link.strength((l) => {
          const t = l && (l.type || '').toUpperCase();
          // DOMAIN: whisper-weak (flow only). Relations: full strength.
          return t === 'DOMAIN' ? 0.05 : 1.0;
        });
      }
    } catch (e) { /* force unavailable — non-fatal */ }
    S.graph.d3Force('brainGravity', (alpha) => {
      if (!S || !S.graph) return;
      const nodes = S.graph.graphData().nodes;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.id === 'core') continue; // core is pinned at center
        const g = typeof n.gravity === 'number' ? n.gravity : 0.10;
        const targetR = 70 + (1 - g) * 320; // core surface ~70, rim ~390
        const x = n.x || 0, y = n.y || 0, z = n.z || 0;
        const r = Math.sqrt(x * x + y * y + z * z) || 0.001;
        const pull = ((r - targetR) / r) * alpha * 0.35;
        n.vx = (n.vx || 0) - x * pull;
        n.vy = (n.vy || 0) - y * pull;
        n.vz = (n.vz || 0) - z * pull;
      }
    });

    S.onResize = onResize;
    window.addEventListener('resize', S.onResize);

    // Pure void background (his call 2026-10-18): NOTHING in the background —
    // no stars, no noise, no movement. Just empty space. The brain is the hero.
    try {
      S.stage.style.backgroundColor = BG;
      S.stage.style.backgroundImage = 'none';
    } catch (e) { /* background is decorative — never break init */ }

    // Gentle auto-rotation until the visitor first grabs the scene.
    try {
      const ctl = S.graph.controls();
      ctl.autoRotate = true;
      ctl.autoRotateSpeed = ROTATE_SPEED;
      S.ctl = ctl;
      // Idle resume: any manual interaction stops rotation; it eases back in after
      // IDLE_RESUME_MS of quiet (see armResume for the exceptions).
      S.onInteractStart = () => { S.pointerHeld = true; stopRotation(); };
      S.onInteractEnd = () => { S.pointerHeld = false; armResume(); };
      S.onInteract = () => { stopRotation(); armResume(); };
      if (typeof ctl.addEventListener === 'function') {
        ctl.addEventListener('start', S.onInteractStart);
        ctl.addEventListener('end', S.onInteractEnd);
      }
      container.addEventListener('pointerdown', S.onInteractStart);
      window.addEventListener('pointerup', S.onInteractEnd);
      window.addEventListener('pointercancel', S.onInteractEnd);
      container.addEventListener('wheel', S.onInteract, { passive: true });
    } catch (e) { /* controls unavailable — non-fatal */ }

    // Glow halos install asynchronously: __threeObj is created in a debounced
    // digest, so poll until a live node object appears (then set the builder
    // and re-digest once). Guarded so a failed WebGL context can't spin forever.
    let glowReady = false, glowTries = 0;
    const glowPoll = () => {
      if (!S) return;
      if (!glowReady && captureGlowTemplate()) {
        glowReady = true;
        S.graph.nodeThreeObject(buildHalo).nodeThreeObjectExtend(true);
        S.graph.refresh();
        updateFocus();
        setTimeout(bootSequence, 600); // halos mounted — the brain wakes
      } else if (!glowReady && ++glowTries < 600) {
        requestAnimationFrame(glowPoll);
      }
    };
    requestAnimationFrame(glowPoll);
    S.onKey = onKeyDown;
    document.addEventListener('keydown', S.onKey);
    S.onKeyUp = onKeyUp3D;
    document.addEventListener('keyup', S.onKeyUp); // B3: release held fly keys
    S.onBlurFly = clearFly3D;
    window.addEventListener('blur', S.onBlurFly); // B3: never drift when focus leaves
    S.onVisFly = () => { if (document.hidden) clearFly3D(); };
    document.addEventListener('visibilitychange', S.onVisFly);
    container.addEventListener('pointermove', onPointerMove);
    // Input modality (capture phase: set before the library's raycast hover callback fires).
    S.onModality = onModality;
    container.addEventListener('pointermove', S.onModality, true);
    container.addEventListener('pointerdown', S.onModality, true);
    if (typeof ResizeObserver === 'function') {
      S.ro = new ResizeObserver(onResize);
      S.ro.observe(container);
    }

    const fxNewEdges = formationSnapshot(graphData);
    applyData();
    // One view, always alive (his call 2026-10-13): the ambient systems start
    // with the scene. No mode to enter.
    startLiving();
    edgeDrawFx(fxNewEdges);
  }

  // ---- Boot sequence (his vision 2026-10-17) ----
  // When the brain opens: the core flashes bright, ripples cascade outward,
  // and the mesh wakes in a wave from the core — high-gravity nodes first,
  // like consciousness spreading. Premium, not a loading spinner.
  let bootDone = false;
  function bootSequence() {
    if (bootDone || !S || !S.live || !S.live.on) return;
    bootDone = true;
    // 1. Core flash: subtle single pulse from the center (his call 2026-10-17:
    //    ripple ONLY on the main core, subtle not heavy).
    interiorPulse(2, 2000, 0.35);
    // 2. Halo wake wave: nodes light up in gravity order (inner → outer),
    //    staggered so the wake visibly spreads from the core.
    const nodes = S.graph.graphData().nodes;
    const wake = nodes
      .filter((n) => n._halo && n.id !== 'core')
      .map((n) => ({ n, g: typeof n.gravity === 'number' ? n.gravity : 0.10 }))
      .sort((a, b) => b.g - a.g);
    wake.forEach((w, i) => {
      const delay = 400 + (wake.length > 1 ? (i / (wake.length - 1)) : 0) * 2200;
      setTimeout(() => {
        if (!S || !S.live || !S.live.on || !w.n._halo) return;
        S.live.glow.set(String(w.n.id), { kind: 'fresh', until: Date.now() + 1400 });
      }, delay);
    });
    // 3. Domain hubs: no boot pulse (his call 2026-10-17 — ripple is core-only).
    //    (Removed the sequential hub glow that was landing on domain nodes.)
  }

  function destroy() {
    if (!S) return;
    sparksStop(true);
    stopLiving(); // clears timers, fx meshes, ticker/HUD; S still set
    const s = S;
    S = null;
    if (s.clickTimer) clearTimeout(s.clickTimer);
    window.removeEventListener('resize', s.onResize);
    document.removeEventListener('keydown', s.onKey);
    document.removeEventListener('keyup', s.onKeyUp);
    window.removeEventListener('blur', s.onBlurFly);
    document.removeEventListener('visibilitychange', s.onVisFly);
    if (s.container) {
      s.container.removeEventListener('pointermove', onPointerMove);
      s.container.removeEventListener('pointermove', s.onModality, true);
      s.container.removeEventListener('pointerdown', s.onModality, true);
      s.container.removeEventListener('pointerdown', s.onInteractStart);
      s.container.removeEventListener('wheel', s.onInteract);
    }
    window.removeEventListener('pointerup', s.onInteractEnd);
    window.removeEventListener('pointercancel', s.onInteractEnd);
    if (s.ctl && typeof s.ctl.removeEventListener === 'function') {
      s.ctl.removeEventListener('start', s.onInteractStart);
      s.ctl.removeEventListener('end', s.onInteractEnd);
    }
    if (s.idleTimer) clearTimeout(s.idleTimer);
    if (s.rampRaf) cancelAnimationFrame(s.rampRaf);
    if (s.ro) s.ro.disconnect();
    try {
      if (s.graph) {
        s.graph.pauseAnimation();
        s.graph.graphData({ nodes: [], links: [] });
        const r = typeof s.graph.renderer === 'function' ? s.graph.renderer() : null;
        if (r && typeof r.dispose === 'function') r.dispose();
        if (typeof s.graph._destructor === 'function') s.graph._destructor();
      }
    } catch (err) {
      console.error(err);
    }
    if (s.container) s.container.textContent = '';
  }

  // Read/drive hooks for the acceptance harness (portal/checks/focus-mode.checks.mjs).
  function getPanelRows() {
    if (!S) return [];
    return [...S.panel.querySelectorAll('.u-neighbor[data-relations]')].map((b) => {
      const types = b.dataset.relations.split(',');
      return {
        label: b.querySelector('.u-neighbor-label').textContent,
        relationType: types[0],
        relationTypes: types,
      };
    });
  }

  // ---- The living view ------------------------------------------------------
  // ONE view, always alive (his call 2026-10-13 — the Live mode is gone).
  // Polls live-state.json (the heartbeat's staged per-beat snapshot) and
  // renders two visual registers:
  //   INTERIOR (the mind itself): each beat = a pulse emanating from the core
  //     node; echo-touched nodes glow color-coded — contradiction ember red,
  //     new link green, fresh info cool blue, demand pulsing amber.
  //   EXTERIOR: quiet now (his call 2026-10-19 — the falling-star comet streaks
  //     are removed). New arrivals land straight as a node flash + glow, then
  //     resolve into the mesh.
  // Idle (no new beat): the core breathes. Never a dead screen.
  // Silent by design: no audio anywhere — the core's voice lives in the text
  // ticker only.
  const LIVE_POLL_MS = 15000;
  const LIVE_GLOW_MS = 90 * 1000;
  const LIVE_COLORS = {
    contradiction: '#ff6b4d',
    newlink: '#3ddc97',
    fresh: '#6ee7ff',
    demand: '#ffb547',
  };
  const STREAK_KNOWLEDGE = '#cfe4ff';
  const STREAK_DEMAND = '#4da3ff';

  function hashDir(seed) {
    let x = 2166136261;
    const s = 'live:' + String(seed);
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    const r = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return (x % 10000) / 10000; };
    const u = r() * 2 - 1, th = r() * Math.PI * 2, q = Math.sqrt(Math.max(0, 1 - u * u));
    return { x: q * Math.cos(th), y: q * Math.sin(th), z: u };
  }

  function liveMesh(color, opacity) {
    if (!glowTpl) return null;
    const mat = glowTpl.matProto.clone();
    mat.color.set(color);
    mat.transparent = true;
    mat.opacity = opacity;
    mat.blending = BLEND_ADDITIVE;
    mat.depthWrite = false;
    const m = new glowTpl.Mesh(glowTpl.geo, mat);
    m.raycast = function () {};
    return m;
  }

  function liveScene() {
    return (S && S.graph && typeof S.graph.scene === 'function') ? S.graph.scene() : null;
  }

  function edgeRadius() {
    const nodes = S.graph.graphData().nodes;
    let r = 200;
    for (const n of nodes) {
      const d = Math.hypot(n.x || 0, n.y || 0, n.z || 0);
      if (d > r) r = d;
    }
    return r;
  }

  function coreNode() {
    if (!S || !S.graph || !S.data.coreId) return null;
    return S.graph.graphData().nodes.find((x) => x.id === S.data.coreId) || null;
  }

  // There is ONE view and it is alive (his call 2026-10-13). startLiving runs
  // once at init and never stops: breathing core, formation rings, ambient
  // pathway pulses, HUD, activity ticker, event-driven blooms/sweeps from
  // live-state.json. Nothing to enter, nothing to exit. stopLiving runs only
  // from destroy() to tear the scene down.
  function startLiving() {
    if (!S || S.live) return; // idempotent
    S.live = {
      on: true, lastBeat: -1, state: null, formation: null, t0: performance.now(), seq: 0,
      glow: new Map(), fx: [], rings: [], timer: 0, raf: 0,
      lastActivityKey: null, lastAmbient: 0, lastBreath: 0, breathDomain: null, hold: false,
    };
    // Ambient life pauses while their hands are on the scene (his rule).
    S._holdOn = () => { if (S.live) S.live.hold = true; };
    S._holdOff = () => { if (S.live) S.live.hold = false; };
    S.stage.addEventListener('pointerdown', S._holdOn);
    window.addEventListener('pointerup', S._holdOff);
    window.addEventListener('pointercancel', S._holdOff);
    // Tap-outside collapses the HUD (no close buttons — his rule).
    S._hudOutside = (e) => {
      if (S.hud && !S.hudCollapsed && !S.hud.contains(e.target)) setHudCollapsed(true);
    };
    document.addEventListener('pointerdown', S._hudOutside);
    S.live.timer = setInterval(pollLive, LIVE_POLL_MS);
    S.live.syncTimer = setInterval(pollSyncDial, 60000);
    S.live.raf = requestAnimationFrame(liveTick);
    updateFocus();
    pollLive();
    pollSyncDial();
  }

  // Sync dial live poll: the bridge relay publishes sync-status.json
  // (unencrypted — counts/percents/words only) on every active sync run.
  // This keeps the HUD dial live within ~a minute; the st.sync merge in
  // live-state.json remains as the fallback. A force sync from the portal
  // button owns the dial while it runs (manual override wins).
  // Sync dial v2 tolerance (additive): unknown step/state values render label-only (words + percent, never an
  // error); `step` is read only when it is a known enum value; avg_bps is read from estimate.avg_bps or a
  // top-level avg_bps. v1 files (no step) render exactly as before.
  const SYNC_STEPS = ['peek', 'stage', 'verify', 'merge', 'publish', 'idle', 'failed'];
  function syncDialFace(sy) {
    const step = SYNC_STEPS.indexOf(sy.step) >= 0 ? sy.step : null;
    const bps = sy.estimate && typeof sy.estimate.avg_bps === 'number' ? sy.estimate.avg_bps : (typeof sy.avg_bps === 'number' ? sy.avg_bps : null);
    return {
      step,
      bps,
      busy: sy.state === 'delivering' || sy.state === 'peek' || sy.state === 'busy',
      failed: sy.state === 'failed',
    };
  }
  function applySyncDial(el, sy, p) {
    const f = syncDialFace(sy);
    el.style.setProperty('--p', p + '%');
    el.title = sy.words || 'sync';
    el.setAttribute('aria-label', 'sync ' + p + '% — ' + (f.step ? f.step + ': ' : '') + (sy.words || ''));
    el.classList.toggle('busy', f.busy);
    el.classList.toggle('failed', f.failed);
    if (f.step) el.dataset.step = f.step; else delete el.dataset.step;
    if (f.bps !== null) el.dataset.bps = String(f.bps); else delete el.dataset.bps;
    el.classList.add('on');
  }

  async function pollSyncDial() {
    if (!S || !S.live || !S.live.on) return;
    try {
      const r = await fetch('sync-status.json', { cache: 'no-store' });
      if (!r.ok) return;
      const sy = await r.json();
      if (!sy || !sy.dial || typeof sy.dial.percent !== 'number') return;
      if (S.hudSyncManualUntil && Date.now() < S.hudSyncManualUntil) return;
      if (!S.hud || !S.hud._sync) return;
      const p = Math.max(0, Math.min(100, sy.dial.percent));
      applySyncDial(S.hud._sync, sy, p);
    } catch (e) { /* keep last dial state */ }
  }

  function stopLiving() {
    if (!S || !S.live) return;
    const L = S.live;
    S.live = null;
    clearInterval(L.timer);
    if (L.syncTimer) clearInterval(L.syncTimer);
    cancelAnimationFrame(L.raf);
    const scene = liveScene();
    for (const f of L.fx) { try { f.dispose(scene); } catch (e) { /* already gone */ } }
    for (const r of (L.rings || [])) { try { scene && scene.remove(r); r.material.dispose(); } catch (e) { /* gone */ } }
    if (S._hudOutside) { document.removeEventListener('pointerdown', S._hudOutside); S._hudOutside = null; }
    if (S._holdOn) { S.stage.removeEventListener('pointerdown', S._holdOn); S._holdOn = null; }
    if (S._holdOff) { window.removeEventListener('pointerup', S._holdOff); window.removeEventListener('pointercancel', S._holdOff); S._holdOff = null; }
    if (S.hud) { S.hud.remove(); S.hud = null; }
    for (const n of S.graph.graphData().nodes) {
      if (n._halo && n._liveKind) { setHaloColor(n._halo, haloColor(n)); n._liveKind = null; }
    }
    updateFocus();
  }

  // True when `incoming` is strictly older than the applied payload (lower beat,
  // or equal beat with an earlier ts). Nothing applied yet -> never older.
  function isOlderLiveState(applied, incoming) {
    if (!applied || typeof applied.beat !== 'number' || !incoming) return false;
    if (incoming.beat !== applied.beat) return incoming.beat < applied.beat;
    const it = Date.parse(incoming.ts), at = Date.parse(applied.ts);
    return it < at;
  }

  async function pollLive() {
    if (!S || !S.live || !S.live.on || S.live.held) return;
    const seq = ++S.live.seq; // discard responses superseded by a newer poll
    let st = null;
    try {
      if (S.api && typeof S.api.loadLiveState === 'function') {
        st = await S.api.loadLiveState();
      } else {
        const r = await fetch('live-state.json', { cache: 'no-store' });
        if (r.ok) {
          const b = await r.json();
          if (b && typeof b.beat === 'number') st = b;
        }
      }
    } catch (e) { /* keep last good state */ }
    if (!S || !S.live || !S.live.on || seq !== S.live.seq) return;
    if (st && !isOlderLiveState({ beat: S.live.appliedBeat, ts: S.live.appliedTs }, st)) {
      S.live.appliedBeat = st.beat;
      S.live.appliedTs = st.ts;
      S.live.state = st;
      S.live.formation = st.formation || null;
      renderHUD(st);
      renderActivity(st);
      membraneFx(st);
      birthFx(st);
      if (st.beat !== S.live.lastBeat) { S.live.lastBeat = st.beat; onBeat(st); }
    }
  }

  // One beat: arrivals land instantly as node flashes (his call 2026-10-19 —
  // the comet-streak flight from beyond the mesh edge is removed), then the
  // INTERIOR response (core pulse + echo glows).
  // Beat entries merge into the Updates feed (his call 2026-10-13): no separate
  // CORE panel — the api bridge hands the beat to the portal, which appends
  // the entries + a closing beat summary as feed items.
  function onBeat(st) {
    if (S.api && typeof S.api.onBeatUpdates === 'function') {
      try { S.api.onBeatUpdates(st); } catch (e) { /* feed must never break the beat */ }
    }
    renderHUD(st);
    const arrivals = Array.isArray(st.arrivals) ? st.arrivals.filter(Boolean).slice(0, 8) : [];
    const touched = Array.isArray(st.touched) ? st.touched.filter(Boolean) : [];
    const applyEcho = () => {
      if (!S || !S.live || !S.live.on) return;
      const until = Date.now() + LIVE_GLOW_MS;
      for (const t of touched) {
        if (t && t.id && LIVE_COLORS[t.kind]) S.live.glow.set(String(t.id), { kind: t.kind, until });
      }
      // The core is HUNGRY: its pulse strengthens with unprocessed data.
      // inbox backlog → more wavefronts, brighter glow. Empty inbox →
      // calm baseline pulse. (his ask 2026-10-16: core ki bhookh dikhe)
      const inbox = Number(st.inbox) || 0;
      const hunger = Math.min(1, inbox / 40);
      interiorPulse(3 + Math.round(hunger * 4), 2800, 0.55 + hunger * 0.3);
      updateFocus();
    };
    if (!arrivals.length) { applyEcho(); return; }
    arrivals.forEach((a, i) => {
      setTimeout(() => { if (S && S.live && S.live.on) spawnArrival(a); }, i * 650);
    });
    setTimeout(applyEcho, arrivals.length * 650 + 1500);
  }

  // Brain-status HUD: the site's always-visible status line. Core formation
  // stage (plain words), current focus (plain words, never F-IDs), beat /
  // facts / demands / last-think, and the latest activity as one fading line.
  // No close button (his law): tap the header to collapse/expand; tapping
  // anywhere outside collapses it. Starts collapsed on mobile.
  function setHudCollapsed(collapsed) {
    S.hudCollapsed = !!collapsed;
    if (S.hud) {
      S.hud.classList.toggle('collapsed', S.hudCollapsed);
      S.hud._head.setAttribute('aria-expanded', String(!S.hudCollapsed));
    }
  }
  function hudActivityLine(text) {
    if (!S || !S.hud || !S.hud._act) return;
    const el = S.hud._act;
    el.textContent = '';
    // Restart the fade each time the line changes (a visible breath of life).
    el.classList.remove('hud-activity-flash');
    void el.offsetWidth;
    el.append(h('span', 'hud-activity-kind', 'CORE'), h('span', null, String(text || '').slice(0, 140)));
    el.classList.add('hud-activity-flash');
  }
  function relTime(iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    return Math.round(m / 60) + 'h ago';
  }
  function renderHUD(st) {
    if (!st) { if (S.hud) { S.hud.remove(); S.hud = null; } return; }
    const core = st.core, fm = st.formation;
    let hud = S.hud;
    if (!hud) {
      hud = h('div', 'hud');
      hud._head = h('button', 'hud-head');
      hud._head.type = 'button';
      hud._head.setAttribute('aria-expanded', 'true');
      hud._stage = h('span', 'hud-stage');
      hud._prog = h('span', 'hud-progress');
      hud._sync = h('span', 'hud-sync');
      hud._sync.setAttribute('role', 'img');
      hud._beat = h('span', 'hud-beat');
      hud._head.append(hud._stage, hud._sync, hud._beat);
      hud._head.insertBefore(hud._prog, hud._sync);
      hud._head.addEventListener('click', (e) => { e.stopPropagation(); setHudCollapsed(!S.hudCollapsed); });
      hud._body = h('div', 'hud-body');
      hud._focus = h('ul', 'hud-focus');
      hud._status = h('div', 'hud-status');
      hud._act = h('div', 'hud-activity');
      hud._body.append(hud._focus, hud._status, hud._act);
      hud.append(hud._head, hud._body);
      // Bottom-anchored stack (his call 2026-10-13): the beat bar lives
      // directly above the LATEST UPDATES panel, never near the header/search.
      const stack = document.getElementById('bottom-stack');
      const logEl = document.getElementById('updates-log');
      if (stack && logEl) stack.insertBefore(hud, logEl);
      else if (stack) stack.appendChild(hud);
      else S.ui.append(hud);
      S.hud = hud;
      if (S.hudCollapsed == null) {
        setHudCollapsed(!!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches));
      } else {
        hud.classList.toggle('collapsed', S.hudCollapsed);
      }
    }
    hud._stage.textContent = (fm && fm.words) || (core ? 'the core is awake' : 'listening');
    // Formation progress: shown only while fresh. The asleep gate is CSS
    // (body:has(.sleeping) .hud-progress) off the same class vitals.js toggles.
    const prog = fm && fm.progress_0_1;
    hud._prog.textContent = (typeof prog === 'number' && isFinite(prog)) ? Math.round(Math.max(0, Math.min(1, prog)) * 100) + '%' : '';
    hud._beat.textContent = 'beat ' + st.beat;
    // Sync dial: the bridge relay's live sync face (st.sync). Ring fills with
    // percent; amber while syncing, teal when idle. Tooltip carries the words.
    // A force sync from the portal button owns the dial while it runs
    // (setSyncDial) — renderHUD hands off until releaseSyncDial().
    const manual = S.hudSyncManualUntil && Date.now() < S.hudSyncManualUntil;
    const sy = st.sync;
    if (manual) {
      // Force sync owns the dial right now — hands off.
    } else if (sy && sy.dial && typeof sy.dial.percent === 'number') {
      const p = Math.max(0, Math.min(100, sy.dial.percent));
      applySyncDial(hud._sync, sy, p);
    } else {
      hud._sync.classList.remove('on');
    }
    const ul = hud._focus;
    ul.textContent = '';
    if (core && Array.isArray(core.focus)) {
      for (const f of core.focus.slice(0, 3)) {
        const li = h('li');
        li.append(h('span', null, String(f.label || '').slice(0, 90)));
        if (f.why) li.append(h('span', 'why', String(f.why).slice(0, 120)));
        ul.append(li);
      }
    }
    const meta = [st.nodes + ' facts', st.inbox + ' demand' + (st.inbox === 1 ? '' : 's')];
    // Live-feed fix (2026-10-26): the box backend names the facts count 'facts',
    // the staged snapshot names it 'nodes'; accept either, never print undefined.
    const factsCount = Number.isFinite(st.nodes) ? st.nodes : (Number.isFinite(st.facts) ? st.facts : null);
    meta.length = 0;
    if (factsCount !== null) meta.push(factsCount + ' facts');
    if (Number.isFinite(st.inbox)) meta.push(st.inbox + ' demand' + (st.inbox === 1 ? '' : 's'));
    if (core && typeof core.open_questions === 'number' && core.open_questions > 0) {
      meta.push(core.open_questions + ' open question' + (core.open_questions === 1 ? '' : 's'));
    }
    if (core && core.last_think) meta.push('think ' + relTime(core.last_think));
    hud._status.textContent = meta.join(' · ');
    const acts = Array.isArray(st.activity) ? st.activity : [];
    if (acts.length) hudActivityLine(activityWords(acts[acts.length - 1], st));
  }

  // (paintBadge removed with the Live badge — unified view, his call 2026-10-13.
  // The HUD carries beat/facts/demands now.)

  function arrivalTarget(a) {
    const nodes = S.graph.graphData().nodes;
    if (a && a.id) {
      const n = nodes.find((x) => x.id === String(a.id));
      if (n && n.x != null) return { x: n.x, y: n.y, z: n.z, nodeId: n.id };
    }
    // No node yet (e.g. inbox proposals): the event flashes at the mesh rim.
    const R = edgeRadius();
    const d = hashDir('rim:' + ((a && a.headline) || 'x'));
    return { x: d.x * R, y: d.y * R, z: d.z * R, nodeId: null };
  }

  function spawnArrival(a) {
    const scene = liveScene();
    const target = arrivalTarget(a);
    if (!scene || !target) return;
    // his call 2026-10-19: no more asteroid streaks. The comet flight from
    // beyond the mesh edge is gone — arrivals land instantly as a node
    // flash + glow. The core pulse ripple stays untouched.
    const isDemand = a && a.type === 'demand';
    const color = isDemand ? STREAK_DEMAND : STREAK_KNOWLEDGE;
    landArrival(a, target, scene, null, color);
  }

  function landArrival(a, target, scene, head, color) {
    const flash = liveMesh(color, 0.9);
    if (flash) {
      flash.position.set(target.x, target.y, target.z);
      scene.add(flash);
      const t0 = performance.now();
      S.live.fx.push({
        update(now) {
          const raw = Math.min(1, (now - t0) / 420);
          const t = easeOutCubic(raw);
          flash.scale.setScalar(8 + t * 46);
          flash.material.opacity = 0.9 * (1 - t);
          return raw < 1;
        },
        dispose(sc) { (sc || scene).remove(flash); flash.material.dispose(); },
      });
    }
    if (head) try { scene.remove(head); head.material.dispose(); } catch (e) { /* already gone */ }
    if (target.nodeId && S.live) {
      const kind = a && a.type === 'demand' ? 'demand' : 'fresh';
      S.live.glow.set(target.nodeId, { kind, until: Date.now() + (kind === 'demand' ? 150000 : 60000) });
      updateFocus();
    }
  }

  // ==== S2:begin ====
  // S2 formation motion, 3D surface only. Every motion below is bound to a real
  // feed field named in formation-trace-s2.md; classes marked NONE there have
  // no code here. Node scale and link width are the only things animated, all
  // through three.js objects (no DOM layout writes). Steps run on the shared
  // live frame loop (requestAnimationFrame), never on timers.
  const FX_BIRTH_MS = 240;
  const FX_BIRTH_EASE = 'cubic-bezier(0.2,0,0,1)';
  const FX_RING_ALPHA = 0.5;
  const FX_DRAW_MS = 900;
  const FX_GHOST_ALPHA = 0.35;
  const FX_PULSE_S = 5.5;

  // The one shared concurrency counter (limit 24 live animating objects).
  // A birth with its ring is one slot. Over the limit an event folds: the exact
  // final state is applied at once, never dropped.
  const formationBudget = { limit: 24, active: 0, folded: 0, loggedFolded: 0, lastLogAt: 0 };

  // Session memory for the appear-once rule. prevNodes / prevEdges are the
  // previous graph payload observed in this session.
  const fxSession = {
    payloads: 0, prevNodes: null, prevEdges: null, newNodes: new Set(),
    announced: new Set(), born: new Set(), drawn: new Set(), drawing: new Map(),
  };

  // Reduced motion is read live at every call, never cached.
  function fxReduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function budgetTake() {
    if (formationBudget.active < formationBudget.limit) { formationBudget.active++; return true; }
    formationBudget.folded++;
    return false;
  }
  function budgetFree(n) {
    formationBudget.active = Math.max(0, formationBudget.active - (n || 1));
  }
  // Aggregate fold line, at most once a second.
  function budgetLog(now) {
    const b = formationBudget;
    if (b.folded === b.loggedFolded || now - b.lastLogAt < 1000) return;
    console.log('[formation] folded ' + (b.folded - b.loggedFolded) + ' event(s) to final state (budget ' + b.limit + ', total folded ' + b.folded + ')');
    b.loggedFolded = b.folded;
    b.lastLogAt = now;
  }

  // CSS-style cubic-bezier curve, solved by bisection on x.
  function fxBezier(spec) {
    const q = /cubic-bezier\(([^)]+)\)/.exec(spec)[1].split(',').map(Number);
    const x1 = q[0], y1 = q[1], x2 = q[2], y2 = q[3];
    const at = (a, b, t) => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let lo = 0, hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (at(x1, x2, mid) < x) lo = mid; else hi = mid;
      }
      return at(y1, y2, (lo + hi) / 2);
    };
  }
  const fxBirthEase = fxBezier(FX_BIRTH_EASE);

  // Diff this graph payload against the previous one observed in this session.
  // Payload 1 (initial load) settles silently; only payload N >= 2 can yield
  // new ids or edges. Revisiting the same data yields an empty diff.
  function formationSnapshot(data) {
    const nodes = new Set(), edges = new Set();
    for (const n of (data && data.nodes) || []) if (n && n.id != null) nodes.add(String(n.id));
    for (const e of (data && data.edges) || []) if (e) edges.add(String(e.source) + '>' + String(e.target));
    fxSession.payloads += 1;
    fxSession.newNodes = new Set();
    const newEdges = [];
    if (fxSession.payloads >= 2 && fxSession.prevNodes) {
      for (const id of nodes) if (!fxSession.prevNodes.has(id)) fxSession.newNodes.add(id);
      for (const k of edges) if (!fxSession.prevEdges.has(k)) newEdges.push(k);
    }
    fxSession.prevNodes = nodes;
    fxSession.prevEdges = edges;
    return newEdges;
  }

  // node.birth: runs from the live-state apply in pollLive. A node births once,
  // and only if its id was announced in st.arrivals AND is new in the diff
  // against the previous payload. Scale only; the arrival flash and glow stay
  // owned by landArrival. This module owns the single birth ring.
  function birthFx(st) {
    const L = S && S.live;
    if (!L || !st) return;
    for (const a of (Array.isArray(st.arrivals) ? st.arrivals : [])) {
      if (a && a.id != null && fxSession.announced.size < 256) fxSession.announced.add(String(a.id));
    }
    if (!(fxSession.payloads >= 2)) return;
    const scene = liveScene();
    for (const id of fxSession.newNodes) {
      if (!fxSession.announced.has(id) || fxSession.born.has(id)) continue;
      const n = nodeById(id);
      const obj = n && n.__threeObj;
      if (!n || !obj || !S.visible.has(id)) continue; // not on screen yet: try next poll
      fxSession.born.add(id);
      if (fxReduced() || !scene) continue; // instant settle: the node is already at scale 1
      if (!budgetTake()) continue; // fold: exact final state is scale 1, already applied
      const ring = liveMesh(STREAK_KNOWLEDGE, FX_RING_ALPHA);
      if (ring) scene.add(ring);
      obj.scale.setScalar(0.0001);
      const t0 = performance.now();
      let freed = false;
      L.fx.push({
        update(now) {
          const raw = fxReduced() ? 1 : Math.min(1, (now - t0) / FX_BIRTH_MS);
          obj.scale.setScalar(raw >= 1 ? 1 : Math.max(0.0001, fxBirthEase(raw)));
          if (ring) {
            ring.position.set(n.x || 0, n.y || 0, n.z || 0);
            ring.scale.setScalar(6 + 28 * raw);
            ring.material.opacity = FX_RING_ALPHA * (1 - raw);
          }
          return raw < 1;
        },
        dispose(sc) {
          obj.scale.setScalar(1);
          if (ring) { (sc || scene).remove(ring); ring.material.dispose(); }
          if (!freed) { freed = true; budgetFree(1); }
        },
      });
    }
  }

  // node.ghost is NONE in the trace: there is no per-item queue. This is the
  // aggregate membrane indicator only: one beacon at the rim, sized by the
  // st.inbox count, pulsing around alpha 0.35 (static 0.35 under reduced motion).
  function membraneFx(st) {
    const L = S && S.live;
    if (!L || !st) return;
    const inbox = Math.max(0, Number(st.inbox) || 0);
    if (L.membrane) { L.membrane.inbox = inbox; return; }
    const scene = liveScene();
    const mesh = liveMesh(STREAK_KNOWLEDGE, FX_GHOST_ALPHA);
    if (!scene || !mesh) return; // glow template not ready yet: try next poll
    const R = edgeRadius() * 1.08, d = hashDir('membrane');
    mesh.position.set(d.x * R, d.y * R, d.z * R);
    mesh.visible = false;
    scene.add(mesh);
    const m = L.membrane = { inbox };
    L.fx.push({
      update(now) {
        budgetLog(now);
        mesh.visible = m.inbox > 0;
        const pulse = fxReduced() ? 1 : 0.8 + 0.2 * Math.sin((2 * Math.PI * now) / (FX_PULSE_S * 1000));
        mesh.material.opacity = FX_GHOST_ALPHA * pulse;
        mesh.scale.setScalar(5 + 9 * Math.min(1, m.inbox / 40));
        return true;
      },
      dispose(sc) { (sc || scene).remove(mesh); mesh.material.dispose(); },
    });
  }

  // edge.draw: runs from init once a graph payload (N >= 2) is applied. Each
  // new edge key draws in once, width thin to full over 900 ms, ease-out.
  function edgeDrawFx(keys) {
    const L = S && S.live;
    if (!L || !S.graph || !keys || !keys.length) return;
    const graph = S.graph;
    const run = [];
    for (const k of keys) {
      if (fxSession.drawn.has(k)) continue;
      fxSession.drawn.add(k);
      if (fxReduced() || !budgetTake()) continue; // settle or fold: edge is already full width
      run.push(k);
    }
    if (!run.length) return;
    const base = graph.linkWidth();
    for (const k of run) fxSession.drawing.set(k, 0);
    const widthOf = (l) => {
      const w = typeof base === 'function' ? base(l) : base;
      const p = fxSession.drawing.get(linkKey(l));
      return p == null ? w : w * (0.25 + 0.75 * p);
    };
    graph.linkWidth(widthOf);
    updateFocus(); // one leading flow particle on each drawing edge (see particleCount)
    const t0 = performance.now();
    let freed = false;
    L.fx.push({
      update(now) {
        const raw = fxReduced() ? 1 : Math.min(1, (now - t0) / FX_DRAW_MS);
        const p = easeOutCubic(raw);
        for (const k of run) fxSession.drawing.set(k, p);
        graph.linkWidth((l) => widthOf(l));
        return raw < 1;
      },
      dispose() {
        for (const k of run) fxSession.drawing.delete(k);
        try { graph.linkWidth(base); } catch (e) { /* scene already torn down */ }
        if (!freed) { freed = true; budgetFree(run.length); }
        if (S && S.graph === graph) updateFocus();
      },
    });
  }

  // Read-only view of the ambient packet flow (seed, particle count, speed).
  // Hover never touches any of it; the guard compares two reads.
  function ambientFlowSnapshot() {
    const out = { seed: 'ps', particles: 0, speed: 0 };
    if (!S || !S.graph) return out;
    for (const l of S.graph.graphData().links || []) {
      out.particles += particleCount(l);
      out.speed += 0.0018 + 0.0052 * hash01('ps' + linkKey(l));
    }
    return out;
  }
  // ==== S2:end ====

  // ---- Motion craft (his bar 2026-10-17: designed, not programmed) ----
  // Linear tweens read as mechanical; eased curves read as alive.
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOutBack = (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

  function interiorPulse(waves, dur, opacity) {
    const scene = liveScene();
    const core = coreNode();
    if (!scene || !core) return;
    // staggered wavefronts — a rhythmic pulse readable across the mesh
    const W = waves == null ? 3 : waves, D = dur || 2800, O = opacity == null ? 0.55 : opacity;
    for (let w = 0; w < W; w++) {
      setTimeout(() => {
        if (!S || !S.live || !S.live.on) return;
        const sc = liveScene(), c = coreNode();
        if (!sc || !c) return;
        const ring = liveMesh('#eaf6ff', O);
        if (!ring) return;
        ring.position.set(c.x, c.y, c.z);
        sc.add(ring);
        const t0 = performance.now();
        S.live.fx.push({
          update(now) {
            const raw = Math.min(1, (now - t0) / D);
            const t = easeOutCubic(raw); // designed motion: fast bloom, gentle settle
            const cc = coreNode();
            if (cc) ring.position.set(cc.x, cc.y, cc.z);
            ring.scale.setScalar(20 + t * 280);
            ring.material.opacity = O * (1 - t);
            return raw < 1;
          },
          dispose(s2) { (s2 || sc).remove(ring); ring.material.dispose(); },
        });
      }, w * 350);
    }
  }

  // A thought blooming: slower, deeper than the beat pulse — the mind working.
  function thinkBloom() { interiorPulse(5, 4200, 0.7); }
  // One sweep ring expanding from the core (sync / merge settling in).
  function sweepRing() { interiorPulse(1, 2200, 0.5); }

  // A thin pulse traveling from node A to node B (demand opened: the named
  // nodes reach for each other; ambient: a high-gravity pathway breathing).
  function pulseBetween(idA, idB, color, opacity, dur) {
    const scene = liveScene();
    if (!scene) return;
    const a = nodeById(idA), b = nodeById(idB);
    if (!a || !b || a.x == null || b.x == null) return;
    const O = opacity == null ? 0.5 : opacity, D = dur || 1400;
    const dot = liveMesh(color || '#ffb547', O);
    if (!dot) return;
    dot.scale.setScalar(5);
    scene.add(dot);
    const t0 = performance.now();
    const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
    S.live.fx.push({
      update(now) {
        const t = Math.min(1, (now - t0) / D);
        dot.position.set(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
        dot.material.opacity = O * (1 - t * 0.4);
        return t < 1;
      },
      dispose(s2) { (s2 || scene).remove(dot); dot.material.dispose(); },
    });
  }

  // ---- formation: the core's visible stage -----------------------------------
  // igniting 0 rings → forming 1 → awake 2 → deepening 3. Thin, faint,
  // restrained — the mind condensing, not decoration.
  const FORMATION_STAGES = ['igniting', 'forming', 'awake', 'deepening'];
  function formationIndex() {
    const st = S && S.live && S.live.formation && S.live.formation.stage;
    const i = FORMATION_STAGES.indexOf(st);
    return i < 0 ? 0 : i; // unknown → no rings: nothing formed yet, no fake state
  }
  function updateFormationRings() {
    const L = S.live;
    const scene = liveScene(), core = coreNode();
    if (!scene || !core) return;
    const want = formationIndex();
    while (L.rings.length > want) {
      const r = L.rings.pop();
      try { scene.remove(r); r.material.dispose(); } catch (e) { /* gone */ }
    }
    const t = (performance.now() - L.t0) / 1000;
    while (L.rings.length < want) {
      const ring = liveMesh('#9adcff', 0.08);
      if (!ring) break;
      L.rings.push(ring);
      scene.add(ring);
    }
    L.rings.forEach((ring, i) => {
      const R = 46 + i * 30;
      const breathe = 1 + 0.05 * Math.sin(t * 0.8 + i * 1.7);
      ring.position.set(core.x, core.y, core.z);
      ring.scale.set(R * breathe, R * 0.07 * breathe, R * breathe);
      ring.material.opacity = 0.07 + 0.02 * Math.sin(t * 0.8 + i * 1.7);
    });
  }

  // ---- activity: heartbeat events rendered as visible life ------------------
  function renderActivity(st) {
    const L = S.live;
    if (!L) return;
    const acts = Array.isArray(st.activity) ? st.activity : [];
    let start = 0;
    if (L.lastActivityKey) {
      const ki = acts.findIndex((a) => a && (a.t + '|' + a.kind) === L.lastActivityKey);
      if (ki >= 0) start = ki + 1;
    }
    for (let i = start; i < acts.length; i++) {
      if (acts[i]) { try { activityEvent(acts[i]); } catch (e) { /* never break the frame */ } }
    }
    if (acts.length) L.lastActivityKey = acts[acts.length - 1].t + '|' + acts[acts.length - 1].kind;
  }
  function activityEvent(a) {
    const until = Date.now() + 90000;
    const liveIds = (a.fids || []).filter((id) => nodeById(id));
    switch (a.kind) {
      case 'think':
        thinkBloom();
        break;
      case 'demand_opened':
      case 'contradiction': {
        const kind = a.kind === 'contradiction' ? 'contradiction' : 'demand';
        liveIds.forEach((id, i) => setTimeout(() => {
          if (S && S.live && S.live.on) { S.live.glow.set(String(id), { kind, until }); updateFocus(); }
        }, i * 400)); // lights in touch order — a visible sweep
        if (liveIds.length >= 2) pulseBetween(liveIds[0], liveIds[1], '#ffb547');
        break;
      }
      case 'merge':
      case 'sync': {
        // Settling in: touched nodes light in sequence, a sweep leaves the core.
        const mUntil = Date.now() + 60000;
        liveIds.forEach((id, i) => setTimeout(() => {
          if (S && S.live && S.live.on) { S.live.glow.set(String(id), { kind: 'fresh', until: mUntil }); updateFocus(); }
        }, i * 150));
        sweepRing();
        break;
      }
      // 'beat': the beat already pulses via onBeat — no extra motion.
      // 'demand_resolved': resolution is the absence of demands — nothing to add.
    }
  }

  // Per-frame halo painter: base dimming + echo glows +
  // breathing core. Colours sync here so expiry restores the domain colour.
  function paintLiveHalos(nodes) {
    const t = (performance.now() - S.live.t0) / 1000;
    const nowMs = Date.now();
    // The breath deepens as the core forms — a real signal, not decoration.
    const depth = [0.7, 1.0, 1.3, 1.6][formationIndex()] || 1.0;
    const dim = S.hovered ? DIM_HOVER : DIM; // hover dim must reach halos too
    for (const n of nodes) {
      if (!n._halo) continue;
      const a = (n.status === 'superseded' || n.life ? 0.35 : 1) * focusOpacity(n.id, dim);
      // Rest state: halo off — no bubble. Glow only for live events, selection,
      // fresh nodes, and the breathing core.
      let o = 0;
      let kind = null;
      const g = S.live.glow.get(n.id);
      if (g) {
        if (nowMs > g.until) S.live.glow.delete(n.id);
        else {
          kind = g.kind;
          o = kind === 'demand' ? 0.30 + 0.16 * Math.sin(t * 5.2) : 0.12 + HALO_OPACITY * a * 1.7;
        }
      }
      if (n.id === S.data.coreId) {
        kind = kind || 'core';
        o = Math.min(0.5, o + 0.07 * depth + 0.055 * depth * Math.sin(t * 1.15));
      } else if (!kind) {
        if (S.selected === n.id) o = Math.min(0.5, HALO_OPACITY * a * 1.6);
        else if (isFresh(n.id)) o = Math.min(0.5, HALO_OPACITY * a * 1.9);
        else if (strikeNodeLevel(n.id) > 0) o = Math.min(0.5, HALO_OPACITY * a * focusHaloBoost(n.id));
      }
      if (n._liveKind !== kind) {
        n._liveKind = kind;
        setHaloColor(n._halo, kind && LIVE_COLORS[kind] ? LIVE_COLORS[kind] : haloColor(n));
      }
      setHaloOpacity(n._halo, Math.min(0.6, o));
    }
  }

  // ---- ambient neural aliveness -------------------------------------------------
  // Between events the brain must feel alive, not frozen. Everything here is
  // throttled, faint, and pauses while their hands are on the scene.
  function ambientPulse() {
    const L = S.live;
    if (!L || L.hold) return;
    const nodes = S.graph.graphData().nodes;
    const links = S.graph.graphData().links || [];
    if (!nodes.length || !links.length) return;
    // Top-decile gravity threshold: only the mind's strongest pathways breathe.
    const gs = nodes.map((n) => +n.gravity || 0).sort((a, b) => b - a);
    const thr = gs[Math.max(0, Math.floor(gs.length * 0.1))] || 0;
    if (thr <= 0) return;
    const cands = [];
    for (const l of links) {
      const a = linkNode(l.source), b = linkNode(l.target);
      if (a && b && a.x != null && b.x != null && (+a.gravity || 0) >= thr && (+b.gravity || 0) >= thr) {
        cands.push([a.id, b.id]);
        if (cands.length >= 60) break;
      }
    }
    if (!cands.length) return;
    const [pa, pb] = cands[(Math.random() * cands.length) | 0];
    pulseBetween(pa, pb, '#6ee7ff', 0.16, 3200); // faint, slow
  }
  function breatheDomain() {
    const L = S.live;
    if (!L || !L.state || L.hold) return;
    // Most active domain from the recent activity's named nodes (truthful);
    // falls back to the last beat's touched nodes. None → no breathing.
    const ids = [];
    const acts = Array.isArray(L.state.activity) ? L.state.activity : [];
    for (const a of acts.slice(-24)) for (const id of (a.fids || [])) ids.push(String(id));
    const touched = Array.isArray(L.state.touched) ? L.state.touched : [];
    for (const t of touched) if (t && t.id) ids.push(String(t.id));
    const byId = new Map();
    for (const n of S.graph.graphData().nodes) byId.set(String(n.id), n);
    const counts = {};
    for (const id of ids) { const n = byId.get(id); if (n && n.domain) counts[n.domain] = (counts[n.domain] || 0) + 1; }
    let dom = null, best = 0;
    for (const d in counts) if (counts[d] > best) { best = counts[d]; dom = d; }
    if (dom !== L.breathDomain) { L.breathDomain = dom; L.breathT0 = performance.now(); }
    updateFocus(); // re-runs link colors with the breathing alpha
  }

  function liveTick() {
    if (!S || !S.live || !S.live.on) return;
    const now = performance.now();
    const scene = liveScene();
    const fx = S.live.fx;
    for (let i = fx.length - 1; i >= 0; i--) {
      let alive = false;
      try { alive = fx[i].update(now) !== false; } catch (e) { alive = false; }
      if (!alive) { try { fx[i].dispose(scene); } catch (e) { /* already gone */ } fx.splice(i, 1); }
    }
    try { paintLiveHalos(S.graph.graphData().nodes); } catch (e) { /* never break the frame */ }
    try { updateFormationRings(); } catch (e) { /* never break the frame */ }
    try {
      if (!S.live.hold && now - S.live.lastAmbient > 20000) { S.live.lastAmbient = now; ambientPulse(); }
      if (!S.live.hold && now - S.live.lastBreath > 2000) { S.live.lastBreath = now; breatheDomain(); }
    } catch (e) { /* ambient never breaks the frame */ }
    S.live.raf = requestAnimationFrame(liveTick);
  }

  // Dev hook for staged verification (screenshots): feeds a beat state through
  // the real render path. Same-origin page only; no privileges.
  // The view is always alive (unified view, his call 2026-10-13) — there is no
  // mode to enter or exit; enter() is idempotent and exit() is gone.
  window.BrainLive = {
    enter: () => startLiving(),
    isOn: () => !!(S && S.live),
    coreId: () => (S ? S.data.coreId : null),
    formation: () => (S && S.live ? S.live.formation : null),
    activity: () => (S && S.live && S.live.state && Array.isArray(S.live.state.activity) ? S.live.state.activity : []),
    glows: () => (S && S.live ? [...S.live.glow.entries()].map(([id, g]) => ({ id, kind: g.kind })) : []),
    haloColors(ids) {
      // actual three.js halo material colours for the given node ids ("" if none)
      if (!S || !S.graph) return {};
      const out = {};
      const nodes = S.graph.graphData().nodes;
      for (const id of (ids || [])) {
        const n = nodes.find((x) => x.id === String(id));
        out[id] = (n && n._halo) ? haloHex(n._halo) : '';
      }
      return out;
    },
    hold: (on) => { if (S && S.live) S.live.held = !!on; },
    ambientFlow: () => ambientFlowSnapshot(), // read-only: seed / particle count / speed
    inject(st) {
      if (!S || !S.live || !S.live.on || !st) return false;
      S.live.seq++; // invalidate any in-flight poll so it can't clobber this
      S.live.state = st;
      S.live.lastBeat = st.beat;
      onBeat(st);
      return true;
    },
  };

  window.BrainUniverse = {
    init,
    destroy,
    selectNode: (id) => tapNode(id),
    clearSelection: () => closePanel(),
    // DYNAMIC UI v1: the sync button shows the harvest happening. syncSweep
    // fires when the sync starts (a sweep leaves the core); syncDone fires
    // when it lands — new arrivals flash onto their nodes, the ticker tells the truth.
    syncSweep() {
      if (!S || !S.live || !S.live.on) return false;
      sweepRing();
      hudActivityLine('sync running — harvesting the mesh');
      return true;
    },
    syncDone(diff, newIds) {
      if (!S || !S.live || !S.live.on) return false;
      const ids = Array.isArray(newIds) ? newIds.filter((id) => nodeById(id)) : [];
      if (diff > 0 && ids.length) {
        ids.slice(0, 8).forEach((id, i) => setTimeout(() => {
          if (S && S.live && S.live.on) spawnArrival({ id: String(id), type: 'knowledge', headline: '' });
        }, i * 400));
        hudActivityLine('sync: ' + diff + ' new — settling into the mesh');
      } else {
        hudActivityLine('sync: nothing new — mesh is clean');
      }
      return true;
    },
    getOpacity: (id) => focusOpacity(id),
    getSelectedId: () => (S ? S.selected : null),
    // Force-sync dial: the portal Sync button drives the HUD dial directly
    // while its workflow runs (percent + words). renderHUD leaves the dial
    // alone until releaseSyncDial() hands it back to the relay's st.sync.
    setSyncDial(pct, words, busy) {
      if (!S || !S.hud || !S.hud._sync) return false;
      const el = S.hud._sync;
      const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
      el.style.setProperty('--p', p + '%');
      el.title = String(words || 'sync');
      el.setAttribute('aria-label', 'sync ' + p + '% — ' + String(words || ''));
      el.classList.toggle('busy', !!busy);
      el.classList.add('on');
      S.hudSyncManualUntil = Date.now() + 60000;
      return true;
    },
    releaseSyncDial() {
      if (S) S.hudSyncManualUntil = 0;
      return true;
    },
    getPanelRows,
    markFresh,
    focusNode: (id) => {
      if (!S || !S.graph) return false;
      const node = S.graph.graphData().nodes.find((n) => n.id === id);
      if (!node) return false;
      // Move camera to the node and select it.
      const dist = 120;
      const pos = {
        x: (node.x || 0) + dist * 0.5,
        y: (node.y || 0) + dist * 0.3,
        z: (node.z || 0) + dist,
      };
      S.graph.cameraPosition(pos, { x: node.x || 0, y: node.y || 0, z: node.z || 0 }, 900);
      tapNode(id);
      return true;
    },
    searchNodes: (q) => {
      if (!S || !S.graph) return [];
      const query = q.toLowerCase().trim();
      if (query.length < 2) return [];
      // Word-boundary matching: "car" should not match "caring".
      // Score: exact word match > starts-with > contains.
      const results = [];
      for (const n of S.graph.graphData().nodes) {
        const name = (n.name || '').toLowerCase();
        const id = (n.id || '').toLowerCase();
        const text = name + ' ' + id;
        // Check for whole-word match first.
        const words = text.split(/[^a-z0-9]+/);
        let score = 0;
        if (words.includes(query)) score = 3;
        else if (words.some((w) => w.startsWith(query))) score = 2;
        else if (text.includes(query)) score = 1;
        if (score > 0) results.push({ id: n.id, label: n.name || n.id, score });
      }
      // A4: current before echo before superseded, then match quality; ties keep order.
      const byId = new Map(S.graph.graphData().nodes.map((n) => [n.id, n]));
      const rk = (r) => searchRankOf(byId.get(r.id));
      return results.sort((a, b) => (rk(a) - rk(b)) || (b.score - a.score)).slice(0, 20);
    },
    searchRelations: (q) => {
      // Relation search: "contradicts" finds CONTRADICTS edges, "F-0308"
      // finds everything wired to that fact. Returns both endpoints' labels.
      if (!S || !S.graph) return [];
      const query = q.toLowerCase().trim();
      if (query.length < 2) return [];
      const data = S.graph.graphData();
      // 'DOMAIN' edges are visual scaffolding (core -> hub -> facts), not knowledge — excluded.
      const edges = (data.edges || []).filter((e) => (e.type || '').toUpperCase() !== 'DOMAIN');
      const nodes = data.nodes || [];
      const labelOf = (id) => {
        const n = nodes.find((x) => String(x.id).toUpperCase() === String(id).toUpperCase());
        return n ? (n.name || n.label || n.id) : id;
      };
      const fidM = query.match(/^f-?(\d+)$/);
      const fid = fidM ? 'F-' + fidM[1] : null;
      const results = [];
      const seen = new Set();
      for (const e of edges) {
        const src = String((e.source && e.source.id) || e.source || '');
        const tgt = String((e.target && e.target.id) || e.target || '');
        const type = String(e.type || '').toUpperCase();
        if (!src || !tgt || !type) continue;
        let hit = false;
        if (fid && (src.toUpperCase() === fid || tgt.toUpperCase() === fid)) hit = true;
        else if (type.toLowerCase().includes(query)) hit = true;
        if (!hit) continue;
        const key = src + '|' + type + '|' + tgt;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ from: src, fromLabel: labelOf(src), type, to: tgt, toLabel: labelOf(tgt) });
        if (results.length >= 20) break;
      }
      return results;
    },
    getLegend: () => (S && S.legendBox) ? S.legendBox : null,
    setDomainFilter: (domains) => {
      // Filter visible nodes by domain — for mobile domain toggles.
      if (!S || !S.graph) return;
      // Store and apply on next render; simple implementation hides non-matching.
      S.domainFilter = new Set(domains);
      // Trigger a refresh if the graph supports it.
      if (S.graph.refresh) S.graph.refresh();
    },
  };

  // ==== S4:begin ====
  // S4 brain bar, 3D surface only: citation lighting through the existing
  // live glow map (node objects, never a library fork). The caller passes
  // the nodes the brain looked at (pulsed once) and the nodes it cited (kept
  // lit). Only ids that resolve to a graph node are touched. Entries written
  // here carry a bar flag so a clear never removes a real live event's glow.
  const barGlow = new Set();
  let barTimer = 0;
  function clearBarGlow() {
    clearTimeout(barTimer);
    if (S && S.live) for (const id of barGlow) { const g = S.live.glow.get(id); if (g && g.bar) S.live.glow.delete(id); }
    barGlow.clear();
  }
  function lightCitationNodes(fids, looked) {
    if (!S || !S.live || !S.live.on || !S.graph) return false;
    clearBarGlow();
    const resolve = (xs) => (Array.isArray(xs) ? xs : []).map(String).filter((id) => !!nodeById(id));
    const litIds = resolve(fids);
    const pulseIds = resolve(looked);
    const settle = () => {
      if (!S || !S.live) return;
      for (const id of barGlow) { const g = S.live.glow.get(id); if (g && g.bar) S.live.glow.delete(id); }
      barGlow.clear();
      for (const id of litIds) { S.live.glow.set(id, { kind: 'fresh', until: Number.MAX_SAFE_INTEGER, bar: true }); barGlow.add(id); }
      updateFocus();
    };
    if (!pulseIds.length || fxReduced()) { settle(); return true; }
    const until = Date.now() + 1400;
    for (const id of pulseIds) { S.live.glow.set(id, { kind: 'demand', until, bar: true }); barGlow.add(id); }
    updateFocus();
    barTimer = setTimeout(settle, 1500);
    return true;
  }
  window.BrainUniverse.lightCitationNodes = lightCitationNodes;
  // ==== S4:end ====

  // ==== S5:begin ====
  // S5 growth slider + sleep replay, 3D surface only. Additive hooks: nothing
  // above this block was edited. Hide/show goes through the library's own
  // visibility accessors plus a refresh; the layout data is never re-set, so
  // the simulation is not reheated. State lives on S, so a re-init starts clean.
  const S5_SLEEP_DIM = 0.22; // colour-alpha factor for the whole brain while a replay shows
  const s5uHidden = (id) => !!(S && S.s5vis && !S.s5vis.has(String(id)));

  function s5uEmphasis() {
    if (!S || !S.graph || !S.s5dim) return;
    const baseNode = S.graph.nodeColor();
    const baseLink = S.graph.linkColor();
    if (typeof baseNode !== 'function' || typeof baseLink !== 'function') return;
    const lit = (id) => !!(S.s5glowIds && S.s5glowIds.has(String(id)));
    S.graph
      .nodeColor((n) => (lit(n.id) ? baseNode(n) : scaleAlpha(baseNode(n), S5_SLEEP_DIM)))
      .linkColor((l) => scaleAlpha(baseLink(l), S5_SLEEP_DIM));
  }
  // Re-applied after every focus pass, so dim survives hover/select/live events.
  if (typeof updateFocus === 'function') {
    const s5uBaseFocus = updateFocus;
    updateFocus = function () { s5uBaseFocus(); try { s5uEmphasis(); } catch (e) { /* never break the frame */ } };
  }
  // A live arrival never flashes at a node the slider is hiding.
  if (typeof arrivalTarget === 'function') {
    const s5uBaseTarget = arrivalTarget;
    arrivalTarget = function (a) {
      const t = s5uBaseTarget(a);
      return (t && t.nodeId && s5uHidden(t.nodeId)) ? null : t;
    };
  }

  function setVisibleNodeIds(ids, edges) {
    if (!S || !S.graph) return false;
    const list = (ids instanceof Set || Array.isArray(ids)) ? [...ids] : null;
    const vis = list ? new Set(list.map(String)) : null;
    const keys = vis && Array.isArray(edges)
      ? new Set(edges.map((e) => (Array.isArray(e) ? e.join('>') : String(e)))) : null;
    S.s5vis = vis;
    S.s5keys = keys;
    S.graph
      .nodeVisibility(vis ? (n) => vis.has(String(n.id)) : () => true)
      .linkVisibility(composeLinkVis(vis, keys));
    // Hidden nodes cannot stay selected or hovered.
    if (vis && S.selected && !vis.has(String(S.selected))) closePanel();
    if (vis && S.hovered && !vis.has(String(S.hovered))) { S.hovered = null; if (S.tip) S.tip.hidden = true; }
    S.graph.refresh();
    updateFocus();
    return true;
  }

  function setSleepDim(on) {
    if (!S || !S.graph) return false;
    S.s5dim = !!on;
    updateFocus();
    return true;
  }

  // After-glow rides the existing live glow map (halo painter) and keeps the
  // lit nodes at full colour while the rest dims. Entries are S5-flagged and
  // the glow they displaced is remembered, so clearGlow gives back exactly
  // the prior emphasis and never wipes a real live or brain-bar glow.
  function glowNodes(ids) {
    if (!S || !S.graph || !Array.isArray(ids)) return false;
    S.s5glowIds = S.s5glowIds || new Set();
    S.s5prevGlow = S.s5prevGlow || new Map();
    for (const raw of ids) {
      const id = String(raw);
      if (s5uHidden(id) || !nodeById(id)) continue;
      S.s5glowIds.add(id);
      if (S.live && S.live.glow) {
        if (!S.s5prevGlow.has(id)) S.s5prevGlow.set(id, S.live.glow.get(id) || null);
        S.live.glow.set(id, { kind: 'fresh', until: Number.MAX_SAFE_INTEGER, s5: true });
      }
    }
    updateFocus();
    return true;
  }

  function clearGlow() {
    if (!S || !S.graph) return false;
    if (S.live && S.live.glow && S.s5prevGlow) {
      for (const [id, prev] of S.s5prevGlow) {
        const cur = S.live.glow.get(id);
        if (!cur || !cur.s5) continue;
        if (prev) S.live.glow.set(id, prev); else S.live.glow.delete(id);
      }
    }
    if (S.s5glowIds) S.s5glowIds.clear();
    if (S.s5prevGlow) S.s5prevGlow.clear();
    updateFocus();
    return true;
  }

  if (typeof window !== 'undefined' && window.BrainUniverse) {
    Object.assign(window.BrainUniverse, {
      setVisibleNodeIds,
      setSleepDim,
      glowNodes,
      clearGlow,
      isSleepDim: () => !!(S && S.s5dim),
      isFiltered: () => !!(S && S.s5vis),
      isReady: () => !!(S && S.graph),
    });
  }
  // ==== S5:end ====

  // ==== U2-SPARKS:begin ====
  const SPARKS_MAX_ACTIVE = 80;   // concurrent sparks (v3: quantity up again)
  const SPARKS_MIN_ACTIVE = 20;   // live-cap floor when the frame time sags
  const CORE_SHARE = 0.34;        // share of picks from the core's own spokes
  const REACH_SHARE = 0.10;       // share of picks from relation-less facts' hub spokes
  const FRESH_SHARE = 0.15;       // share of picks from born (fresh) edges
  const FRESH_BOOST = 6;          // born-edge weight multiplier (birth-glow)
  const SPARKS_TICK_MS = 150;     // scheduler tick
  const SPARKS_TRAIL_SEGS = 12;   // trail segments behind each head
  const SPARKS_BOLT_TRAIL_SEGS = 16; // bolt trails are the longest; buffers are sized for them
  const SPARKS_TRAIL_WORLD = 60;  // trail length in world units (capped by edge length)
  const SPARKS_SPEED = 480;       // world units per second
  const SPARKS_CORE_COLOR = '#eaf6ff';
  const SHIMMER_BASE = 0.05;      // relation alpha under the sparks (per-link twinkle on top)
  const SHIMMER_DOMAIN = 0.03;    // DOMAIN scaffolding alpha
  const QUAL_ALPHA = 0.30;        // qualified lines (typed relations, core spokes): permanent thin shine
  const SHIMMER_DIGEST_MS = 1000; // twinkle digest period (1 Hz max)
  const GLOW_REFRESH_MS = 250;    // lit-network re-digest gate (timestamp only, never reset)
  const GLOW_REFRESH_SLOW_MS = 500; // same gate while frames are heavy (ema > 30)
  const STRIKE_GLOW_MS = 900;     // a lit network decays over this long (per-entry expiry)
  const BOLT_GAP_MIN_MS = 600;    // storm: one bolt event every 600-1200 ms
  const BOLT_GAP_MAX_MS = 1200;   // (each event fires 2-3 staggered bolts)
  const BOLT_STAGGER_MS = 120;    // start offset between bolts of one event
  const BOLT_AFTERGLOW_MS = 600;  // travelled edges keep a soft glow this long (k 0.5)
  const BOLT_FLASH_MS = 800;      // the end node flashes this long (k 1)
  const BOLT_NEWEST_EVERY = 5;    // every Nth event aims at a hub's newest fact
  const BOLT_PEER_P = 0.4;        // per event: chance of one extra peer strike
  const STRIKE_PEER_LEVEL = 0.7;  // peer strikes light their endpoints softer than a bolt end
  const STRIKE_MAX_SPARKS = 36;   // concurrent bolt/peer sparks (shared travel buffer, outside the scheduler cap)
  const STRIKE_SPEED_X = 2.6;     // bolt and peer sparks run faster than ambient packets
  const SPARKS_HEX = new Map();
  // U2 SPARKS v2: fast packets with fading trails shoot back and forth along REAL
  // relations only. The permanent lines return as a faint SHIMMER (low alpha, a
  // per-link twinkle) under them. The engine's directional particles cannot
  // ping-pong or trail, so sparks draw on their own LineSegments trail layer.
  // Focused / selected nodes keep their neighbourhood lines solid (opacity 1).
  // The time-slider filter still hides links first (linkVisibility).

  // SPARKS-SCHEDULER:begin
  // Pure: no DOM, no timers, no globals. state = { active: [{s,t,type,ttl,pool}],
  // bag: [nodeId], bagCycle }. Lanes per top-up draw: fresh -> core -> reach -> node bag.
  function sparksStep(state, ctx) {
    const act = state.active;
    const rng = ctx.rng;
    const keyOf = (s, t, type) => s + '|' + t + '|' + type;
    const taken = new Set();
    let w = 0;
    for (let i = 0; i < act.length; i++) {
      act[i].ttl -= 1;
      if (act[i].ttl > 0) act[w++] = act[i];
      else taken.add(keyOf(act[i].s, act[i].t, act[i].type)); // one-tick cooldown: no instant re-pick
    }
    act.length = w;
    for (const a of act) taken.add(keyOf(a.s, a.t, a.type));
    const free = (e) => !taken.has(keyOf(e.source, e.target, e.type));
    const pickFree = (pool) => {
      const n = pool ? pool.length : 0;
      if (!n) return null;
      for (let i = 0; i < 8; i++) {
        const e = pool[Math.floor(rng() * n)];
        if (free(e)) return e;
      }
      const off = Math.floor(rng() * n);
      for (let i = 0; i < n; i++) {
        const e = pool[(off + i) % n];
        if (free(e)) return e;
      }
      return null;
    };
    let freshList = null;
    const pickFresh = () => {
      if (!ctx.fresh || !ctx.fresh.size) return null;
      if (!freshList) {
        freshList = [];
        for (const pool of [ctx.main, ctx.core, ctx.reach]) {
          for (const e of pool || []) if (ctx.fresh.has(keyOf(e.source, e.target, e.type))) freshList.push(e);
        }
      }
      return pickFree(freshList);
    };
    const pickBag = () => {
      let guard = state.bag.length;
      if (!guard && ctx.byNode && ctx.byNode.size) {
        const ids = Array.from(ctx.byNode.keys());
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
        }
        state.bag = ids;
        guard = ids.length;
      }
      while (guard-- > 0 && state.bag.length) {
        const node = state.bag.pop();
        if (!state.bag.length) state.bagCycle++; // the cycle is complete once its last node is offered
        const e = pickFree(ctx.byNode.get(node));
        if (e) return e;
      }
      return null;
    };
    const lanes = { fresh: pickFresh, core: () => pickFree(ctx.core), reach: () => pickFree(ctx.reach), bag: pickBag };
    while (act.length < ctx.cap) {
      const u = rng();
      let first = 'bag';
      if (u < ctx.freshShare) first = 'fresh';
      else if (u < ctx.freshShare + ctx.coreShare) first = 'core';
      else if (u < ctx.freshShare + ctx.coreShare + ctx.reachShare) first = 'reach';
      const order = [first, 'fresh', 'core', 'reach', 'bag'];
      let e = null;
      let pool = first;
      for (const lane of order) {
        e = lanes[lane]();
        if (e) { pool = lane; break; }
      }
      if (!e) break;
      const ttl = 8 + Math.floor(rng() * 13);
      taken.add(keyOf(e.source, e.target, e.type));
      act.push({ s: e.source, t: e.target, type: e.type, ttl, life: ttl, pool });
    }
    return state;
  }
  // SPARKS-SCHEDULER:end

  // SPARKS-QUAL:begin
  // Pure classifier: typed relations, and DOMAIN edges touching the core, are "qualified"
  // (permanent thin shining lines). CONTEXT and hub spokes are not.
  const QUALIFIED_TYPES = new Set(['CAUSES', 'CAUSED-BY', 'SUPPORTS', 'ENABLES', 'REFINES',
    'EXTENDS', 'CHALLENGES', 'BLOCKS', 'UPDATES', 'INSTANCE']);
  function sparksQualified(type, s, t) {
    const ty = String(type || '').toUpperCase();
    if (QUALIFIED_TYPES.has(ty)) return true;
    return ty === 'DOMAIN' && (s === 'core' || t === 'core');
  }
  // SPARKS-QUAL:end

  // SPARKS-BOLT:begin
  // Pure bolt plan: core -> hub, hub -> one fact, and (50%) one more hop along an OUTGOING
  // relation of that fact. Returns an ordered, head-to-tail path of real edges; [] with no
  // core spoke, one leg when the hub has no facts. preferNewest picks the hub's newest fact
  // (ctx.nodeDate); the third hop prefers qualified relations (ctx.isQualified).
  function boltPath(ctx) {
    const rng = ctx.rng;
    const spokes = ctx.coreEdges || [];
    if (!spokes.length) return [];
    rng(); // burn one draw: first outputs of small-seed generators are strongly correlated
    const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
    const spoke = pick(spokes);
    const path = [spoke];
    const hub = spoke.target;
    const facts = (ctx.hubEdges || []).filter((e) => e.source === hub);
    if (!facts.length) return path;
    let leg;
    if (ctx.preferNewest) {
      const dateOf = (e) => String((ctx.nodeDate && ctx.nodeDate.get(e.target)) || '');
      leg = facts[0];
      for (const e of facts) {
        const d = dateOf(e), best = dateOf(leg);
        if (d > best || (d === best && e.target < leg.target)) leg = e;
      }
    } else {
      leg = pick(facts);
    }
    path.push(leg);
    if (rng() < 0.5) {
      const fact = leg.target;
      const outs = ((ctx.relByNode && ctx.relByNode.get(fact)) || [])
        .filter((e) => e.source === fact && String(e.type).toUpperCase() !== 'DOMAIN');
      if (outs.length) {
        const qual = ctx.isQualified ? outs.filter((e) => ctx.isQualified(e.type, e.source, e.target)) : [];
        path.push(pick(qual.length ? qual : outs));
      }
    }
    return path;
  }
  // SPARKS-BOLT:end

  // SPARKS-PEER:begin
  // Pure inter-node strike plan: one uniform random link and its two endpoints; null when empty.
  function peerPlan(ctx) {
    const links = ctx.links || [];
    if (!links.length) return null;
    ctx.rng(); // burn one draw: first outputs of small-seed generators are strongly correlated
    const edge = links[Math.floor(ctx.rng() * links.length) % links.length];
    return { edge, nodes: [edge.source, edge.target] };
  }
  // SPARKS-PEER:end

  // Transient light-up levels (k -> 0 over the entry's own duration, k = strength), quantised
  // to quarters so the lib's colour+opacity material cache stays small. The levels feed
  // the SAME focusLinkColor / focusHaloBoost path that selection uses.
  function strikeLevel(map, id) {
    const SP = S && S.sparks;
    const g = SP && SP[map].get(id);
    if (!g) return 0;
    const rem = g.until - performance.now();
    return rem <= 0 ? 0 : Math.min(1, Math.max(0.25, Math.ceil((rem / (g.dur || STRIKE_GLOW_MS)) * g.k * 4) / 4));
  }
  function strikeNodeLevel(id) { return strikeLevel('glowNodes', id); }
  function strikeEdgeLevel(l) { return strikeLevel('glowEdges', idOf(l.source) + '|' + idOf(l.target) + '|' + l.type); }

  // Read live at every call, never cached (reduced motion: no engine, static shimmer).
  function sparksReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function sparksOn() { return !!(S && S.sparks && S.sparks.running); }

  // Shimmer shows while sparks run, and statically under reduced motion.
  function sparksShimmerActive() { return sparksOn() || sparksReducedMotion(); }

  // The S5 time-slider filter hides links first; everything it leaves visible stays
  // visible while sparks run (the shimmer layer dims them through colour alpha).
  function composeLinkVis(vis, keys) {
    return (l) => {
      if (!vis) return true;
      const s = String(idOf(l.source)), t = String(idOf(l.target));
      return vis.has(s) && vis.has(t) && (!keys || keys.has(s + '>' + t + '>' + l.type));
    };
  }

  // Shimmer colour accessor over the focus accessor `base`. Focus / selection
  // neighbourhood and drawing-session links keep the base (solid) colour; the rest
  // are type-coloured at SHIMMER alpha x twinkle (qualified lines: QUAL_ALPHA x a soft shine). Twinkle: 0.6 + 0.4 sin(t/1400 + phase),
  // phase = hash of the edge key. Reduced motion: static at base alpha. Alpha is
  // quantised so the lib's colour+opacity material cache stays small.
  function sparksShimmerAccessor(base) {
    const f = (l) => {
      if (fxSession.drawing.size && fxSession.drawing.has(linkKey(l))) return base(l);
      const fs = S.focusSet;
      if (fs && fs.has(idOf(l.source)) && fs.has(idOf(l.target))) return base(l);
      if (S.sparks && S.sparks.glowEdges.size) {
        const lv = strikeEdgeLevel(l);
        if (lv > 0) return focusLinkColor(l, lv); // the focus light-up, transient
      }
      if (l.__q === undefined) l.__q = sparksQualified(l.type, String(idOf(l.source)), String(idOf(l.target)));
      let a = l.__q ? QUAL_ALPHA : (isDomainLink(l) ? SHIMMER_DOMAIN : SHIMMER_BASE);
      if (sparksOn() && !sparksReducedMotion()) {
        if (l.__ph === undefined) l.__ph = hash01(linkKey(l) + '|' + l.type) * 6.283185;
        const sn = Math.sin(performance.now() / 1400 + l.__ph);
        a *= l.__q ? 0.85 + 0.15 * sn : 0.6 + 0.4 * sn; // qualified lines: soft shine, not a twinkle
      }
      return hexToRgba(l.color || FALLBACK_LINK, Math.round(a * 500) / 500);
    };
    f.__shimBase = base;
    return f;
  }

  function sparksInstallShimmer() {
    if (!S || !S.graph) return;
    const cur = S.graph.linkColor();
    const base = cur && cur.__shimBase ? cur.__shimBase : cur;
    if (typeof base !== 'function') return;
    S.shimBase = base;
    S.graph.linkColor(sparksShimmerAccessor(base));
  }

  function sparksRefreshVisibility() {
    if (!S || !S.graph || !sparksShimmerActive()) return;
    S.graph.linkVisibility(composeLinkVis(S.s5vis, S.s5keys)); // fresh closure: forces a re-digest
    sparksInstallShimmer();
  }

  // The vendored lib re-digests EVERY link when linkColor is re-set (no per-link
  // subset), so the twinkle re-digests the whole set at 1 Hz, never per frame.
  function sparksShimmerTick() {
    const SP = S && S.sparks;
    if (!SP || !SP.running || document.hidden || !S.graph || !S.shimBase || S.s5dim) return;
    if (sparksReducedMotion()) return;
    if (SP.ema > 40) return; // heavy frames: pause the twinkle, never add a full re-digest spike
    if (performance.now() - SP.glowLast < 800) return; // a glow refresh just re-digested every colour
    S.graph.linkColor(sparksShimmerAccessor(S.shimBase));
  }

  function sparksHexRgb(hex) {
    let c = SPARKS_HEX.get(hex);
    if (!c) {
      const n = parseInt(String(hex).slice(1), 16);
      c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
      SPARKS_HEX.set(hex, c);
    }
    return c;
  }

  const sparksShuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  };

  // Pools, key set and node map come from the CURRENT rendered links; link
  // objects are never held across a refresh.
  function sparksOnData(links) {
    if (!S) return;
    if (!S.sparks) { sparksTryStart(0); }
    const SP = S.sparks;
    if (!SP) return;
    const ctx = SP.ctx;
    const prevNodes = ctx.byNode;
    const byNode = new Map();
    const edges = [];
    const plain = new Set(); // nodes with a non-DOMAIN rendered edge
    ctx.main.length = 0;
    ctx.core.length = 0;
    ctx.reach.length = 0;
    SP.hub.length = 0;
    SP.keys.clear();
    const relByNode = new Map(); // non-DOMAIN relations by endpoint (bolt third hop)
    for (const l of links || []) {
      const e = { source: String(idOf(l.source)), target: String(idOf(l.target)), type: String(l.type) };
      edges.push(e);
      SP.keys.add(e.source + '|' + e.target + '|' + e.type);
      for (const id of [e.source, e.target]) {
        if (!byNode.has(id)) byNode.set(id, []);
        byNode.get(id).push(e);
      }
      if (e.type.toUpperCase() === 'DOMAIN') {
        if (e.source === 'core' || e.target === 'core') ctx.core.push(e);
        else SP.hub.push(e);
      } else {
        ctx.main.push(e);
        plain.add(e.source); plain.add(e.target);
        for (const id of [e.source, e.target]) {
          if (!relByNode.has(id)) relByNode.set(id, []);
          relByNode.get(id).push(e);
        }
      }
    }
    // REACH: hub->fact DOMAIN edges whose fact has no non-DOMAIN rendered edge.
    for (const e of SP.hub) if (!plain.has(e.target)) ctx.reach.push(e);
    ctx.byNode = byNode;
    SP.edges = edges;
    SP.relByNode = relByNode;
    SP.spokes = ctx.core.filter((e) => e.source === 'core');
    // Bag survives rebuilds: keep entries still present, shuffle NEW ids in, cycle untouched.
    const st = SP.state;
    st.bag = st.bag.filter((id) => byNode.has(id));
    for (const id of sparksShuffle(Array.from(byNode.keys()).filter((id) => !prevNodes.has(id)))) {
      st.bag.splice(Math.floor(Math.random() * (st.bag.length + 1)), 0, id);
    }
    SP.nodes.clear();
    SP.nodeDate.clear();
    for (const n of S.graph.graphData().nodes) {
      SP.nodes.set(String(n.id), n);
      if (n.date) SP.nodeDate.set(String(n.id), n.date);
    }
    SP.reachable = new Set(byNode.keys());
    SP.unreachable = 0;
    for (const id of SP.nodes.keys()) if (!SP.reachable.has(id)) SP.unreachable++;
    for (const id of Array.from(SP.sparked)) if (!SP.reachable.has(id)) SP.sparked.delete(id);
  }

  function sparksTryStart(attempt) {
    if (!S || !S.graph || S.sparks) return;
    if (sparksReducedMotion()) return; // reduced motion: engine never starts, shimmer stays static
    if (S.sparksRetry) { clearTimeout(S.sparksRetry); S.sparksRetry = 0; }
    const retry = () => {
      if (attempt < 40) { const s = S; S.sparksRetry = setTimeout(() => { if (S === s) sparksTryStart(attempt + 1); }, 500); }
    };
    if (!glowTpl && !captureGlowTemplate()) { retry(); return; }
    const scene = liveScene();
    if (!scene) { retry(); return; }
    let layer = null;
    try {
      // Constructors come from live objects (the bundle keeps Three.js private).
      let proto = glowTpl.geo.constructor.prototype;
      while (proto && !Object.prototype.hasOwnProperty.call(proto, 'setAttribute')) proto = Object.getPrototypeOf(proto);
      const Geo = proto && proto.constructor;
      const Attr = glowTpl.geo.attributes.position.constructor;
      if (!Geo || !Attr) throw new Error('no buffer constructors');
      // Sized cap x the longest (bolt, 16-segment) trail x 2 vertices per segment.
      const verts = (SPARKS_MAX_ACTIVE + STRIKE_MAX_SPARKS) * Math.max(SPARKS_TRAIL_SEGS, SPARKS_BOLT_TRAIL_SEGS) * 2;
      const geo = new Geo();
      const posA = new Attr(new Float32Array(verts * 3), 3);
      const colA = new Attr(new Float32Array(verts * 3), 3);
      posA.setUsage(35048); colA.setUsage(35048); // DynamicDrawUsage
      geo.setAttribute('position', posA);
      geo.setAttribute('color', colA);
      geo.setDrawRange(0, 0);
      const mat = glowTpl.matProto.clone();
      mat.vertexColors = true;
      mat.transparent = true;
      mat.blending = BLEND_ADDITIVE;
      mat.depthWrite = false;
      mat.opacity = 1;
      // Fade is colour scaled toward black (additive); output the vertex colour flat.
      mat.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>',
          '#include <dithering_fragment>\n gl_FragColor = vec4( vColor, 1.0 );');
      };
      mat.customProgramCacheKey = () => 'u2-sparks';
      const mesh = new glowTpl.Mesh(geo, mat);
      // Draw as GL line segments: the renderer picks the primitive from these flags.
      mesh.isMesh = false; mesh.isLine = true; mesh.isLineSegments = true;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      mesh.raycast = function () {};
      scene.add(mesh);
      layer = { mesh, geo, mat, pos: posA.array, col: colA.array, posA, colA };
    } catch (e) {
      console.error('sparks: trail layer unavailable', e);
      retry();
      return;
    }
    const SP = S.sparks = {
      running: true, layer, scene,
      state: { active: [], bag: [], bagCycle: 0 },
      ctx: { main: [], core: [], reach: [], fresh: new Set(), byNode: new Map(), rng: Math.random,
        cap: SPARKS_MAX_ACTIVE, coreShare: CORE_SHARE, reachShare: REACH_SHARE, freshShare: FRESH_SHARE },
      hub: [], keys: new Set(), nodes: new Map(),
      reachable: new Set(), unreachable: 0, sparked: new Set(), cycleSeen: 0,
      spokes: [], relByNode: new Map(), nodeDate: new Map(), prevParticles: null,
      strikeSparks: [], glowEdges: new Map(), glowNodes: new Map(), glowLast: 0, glowDirty: false, haloPrev: new Set(),
      strikeAt: BOLT_GAP_MIN_MS + Math.random() * (BOLT_GAP_MAX_MS - BOLT_GAP_MIN_MS), strikesRun: 0, boltsRun: 0, boltEvents: 0,
      liveCap: SPARKS_MAX_ACTIVE, trailSegs: SPARKS_TRAIL_SEGS,
      clock: 0, last: 0, ema: 16, slow: 0, fast: 0, raf: 0, timer: 0, shimTimer: 0, pub: 0, pubAt: 0,
    };
    SP.onVis = () => { if (!document.hidden && SP.running && !SP.raf) { SP.last = 0; SP.raf = requestAnimationFrame(sparksFrame); } };
    document.addEventListener('visibilitychange', SP.onVis);
    SP.timer = setInterval(sparksTick, SPARKS_TICK_MS);
    SP.shimTimer = setInterval(sparksShimmerTick, SHIMMER_DIGEST_MS);
    SP.raf = requestAnimationFrame(sparksFrame);
    sparksOnData(S.graph.graphData().links);
    // The construction accessor still gives core highways engine particles; updateFocus
    // re-applies the sparks-aware one (0 while running). Remember the old one for stop.
    SP.prevParticles = S.graph.linkDirectionalParticles();
    updateFocus(); // installs the shimmer over the focus accessor now the layer is live
    S.graph.refresh();
  }

  function sparksPublishIdle() {
    window.__sparks = { active: 0, cap: 0, poolMain: 0, poolCore: 0, poolReach: 0, frameMsEMA: 0,
      nodesSparked: 0, nodesTotal: 0, coveragePct: 0, cycle: 0, boltsRun: 0, strikesRun: 0 };
  }

  function sparksStop(tearDown) {
    const SP = S && S.sparks;
    if (S && S.sparksRetry) { clearTimeout(S.sparksRetry); S.sparksRetry = 0; }
    if (!SP) return;
    SP.running = false;
    if (SP.timer) clearInterval(SP.timer);
    if (SP.shimTimer) clearInterval(SP.shimTimer);
    if (SP.raf) cancelAnimationFrame(SP.raf);
    document.removeEventListener('visibilitychange', SP.onVis);
    try { SP.scene.remove(SP.layer.mesh); SP.layer.geo.dispose(); SP.layer.mat.dispose(); } catch (e) { /* scene gone */ }
    S.sparks = null;
    sparksPublishIdle();
    if (!tearDown && S.graph) { // give the plain lines (or the static reduced-motion shimmer) back
      S.graph.linkVisibility(composeLinkVis(S.s5vis, S.s5keys));
      updateFocus();
      if (typeof SP.prevParticles === 'function') S.graph.linkDirectionalParticles(SP.prevParticles);
      S.graph.refresh();
    }
  }

  function sparksFreshSet() {
    const f = window.__brainFreshEdges;
    return f instanceof Set ? f : EMPTY_FRESH;
  }
  const EMPTY_FRESH = new Set();

  // (The growth-wave director, function sparksWaveTick, is retired: bolts replace it.)

  // ---- lightning ---------------------------------------------------------------
  // Glow entries { until, k, dur } expire individually; a later put never shortens or
  // softens one still burning (until = max, k = max while live); the entry owning the
  // later expiry owns the duration strikeLevel divides by.
  function glowPut(SP, m, id, dur, k) {
    const now = performance.now();
    const old = m.get(id);
    const live = old && old.until > now;
    const until = now + dur;
    if (live && old.until >= until) { if (k > old.k) old.k = k; }
    else m.set(id, { until, dur, k: live ? Math.max(old.k, k) : k });
    SP.glowDirty = true;
  }

  // Peer strike light-up: a node's whole direct network with the shared focus treatment.
  function strikeLight(SP, node, k = 1) {
    for (const e of SP.ctx.byNode.get(node) || []) glowPut(SP, SP.glowEdges, e.source + '|' + e.target + '|' + e.type, STRIKE_GLOW_MS, k);
    glowPut(SP, SP.glowNodes, node, STRIKE_GLOW_MS, k);
    if (SP.reachable.has(node)) SP.sparked.add(node);
  }

  // Bolt: chain a fast spark along each path leg. Every leg re-checks the rendered set at
  // launch; a travelled edge keeps a soft afterglow and the final node flashes (node-only).
  function strikeStart(SP, path, wait) {
    const keyOf = (e) => e.source + '|' + e.target + '|' + e.type;
    const flash = (node) => {
      glowPut(SP, SP.glowNodes, node, BOLT_FLASH_MS, 1);
      if (SP.reachable.has(node)) SP.sparked.add(node);
    };
    const launch = (i, delay) => {
      const e = path[i];
      const key = keyOf(e);
      if (!SP.keys.has(key) || SP.strikeSparks.length >= STRIKE_MAX_SPARKS) {
        if (i > 0) flash(path[i - 1].target); // the chain ends where it got to
        return false;
      }
      SP.strikeSparks.push({ s: e.source, t: e.target, type: e.type, t0: SP.clock, ph: 0, legs: 0, once: true,
        fast: STRIKE_SPEED_X, glow: 1.8, wait: delay, segs: SPARKS_BOLT_TRAIL_SEGS, rgb: sparksHexRgb(SPARKS_CORE_COLOR), key,
        done: () => {
          glowPut(SP, SP.glowEdges, key, BOLT_AFTERGLOW_MS, 0.5);
          if (i + 1 < path.length) launch(i + 1, 0); else flash(e.target);
        } });
      return true;
    };
    return launch(0, wait);
  }

  // Peer strike: a fast bright spark runs a real non-DOMAIN edge; on arrival BOTH endpoints'
  // direct networks light (softer). Rides the strike buffer share, not the scheduler cap.
  function peerStart(SP, plan) {
    const e = plan.edge;
    const both = () => { strikeLight(SP, e.source, STRIKE_PEER_LEVEL); strikeLight(SP, e.target, STRIKE_PEER_LEVEL); };
    const key = e.source + '|' + e.target + '|' + e.type;
    if (!SP.keys.has(key) || SP.strikeSparks.length >= STRIKE_MAX_SPARKS) { both(); return; }
    const flip = SP.ctx.rng() < 0.5; // direction is arbitrary; completion lights both ends
    SP.strikeSparks.push({ s: flip ? e.target : e.source, t: flip ? e.source : e.target, type: e.type, t0: SP.clock,
      ph: 0, legs: 0, once: true, fast: STRIKE_SPEED_X, glow: 1.8, rgb: sparksHexRgb(SPARKS_CORE_COLOR), key, done: both });
  }

  // The single storm director: an event every 600-1200 ms fires 2-3 bolts staggered ~120 ms,
  // a 40% roll adds one peer strike, and every 5th event aims its bolts at a hub's newest fact.
  function sparksStrikeTick(SP) {
    if (SP.clock < SP.strikeAt) return;
    const rng = SP.ctx.rng;
    SP.strikeAt = SP.clock + BOLT_GAP_MIN_MS + rng() * (BOLT_GAP_MAX_MS - BOLT_GAP_MIN_MS);
    if (S.hovered || S.selected || S.focusSet) { SP.strikeAt = SP.clock + 1000; return; } // their focus wins
    const newest = ++SP.boltEvents % BOLT_NEWEST_EVERY === 0;
    const total = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < total; i++) {
      const path = boltPath({ coreEdges: SP.spokes, hubEdges: SP.hub, relByNode: SP.relByNode, nodeDate: SP.nodeDate,
        rng, preferNewest: newest, isQualified: sparksQualified });
      if (path.length && strikeStart(SP, path, i * BOLT_STAGGER_MS)) { SP.boltsRun++; SP.strikesRun++; }
    }
    if (rng() < BOLT_PEER_P) {
      const p = peerPlan({ links: SP.ctx.main, rng });
      if (p) peerStart(SP, p);
    }
  }

  // Prune expired glow entries and re-digest the colours/halos while anything is lit.
  // Timestamp-only gate: nothing resets it. Heavy frames stretch the cadence (refresh only;
  // the storm itself is never gated).
  function sparksGlowRefresh(SP, now) {
    if (!SP.glowEdges.size && !SP.glowNodes.size && !SP.glowDirty) return;
    if (now - SP.glowLast < (SP.ema > 30 ? GLOW_REFRESH_SLOW_MS : GLOW_REFRESH_MS)) return;
    SP.glowLast = now;
    SP.glowDirty = false;
    for (const m of [SP.glowEdges, SP.glowNodes]) for (const [id, g] of m) if (g.until <= now) m.delete(id);
    if (S.graph && S.shimBase && !S.s5dim) S.graph.linkColor(sparksShimmerAccessor(S.shimBase));
    if (S.live && S.live.on) return; // the per-frame live painter owns the halos
    // Halos: only nodes lit now or lit at the previous pass can have changed.
    const ids = new Set(SP.haloPrev);
    for (const id of SP.glowNodes.keys()) ids.add(id);
    const nodes = [];
    for (const id of ids) { const n = SP.nodes.get(id); if (n) nodes.push(n); }
    SP.haloPrev = new Set(SP.glowNodes.keys());
    applyRestHalos(nodes, S.hovered ? DIM_HOVER : DIM);
  }

  function sparksTick() {
    const SP = S && S.sparks;
    if (!SP || !SP.running || document.hidden) return;
    if (sparksReducedMotion()) { sparksStop(); return; }
    // rAF stall watchdog: the frame clears SP.raf on entry and re-arms on exit, so an armed
    // raf with a stale SP.last means the loop is stuck; cancel it first so it cannot double-arm.
    if (SP.raf && SP.last && performance.now() - SP.last > 600) {
      cancelAnimationFrame(SP.raf);
      SP.raf = 0;
      SP.last = 0;
      sparksFrame();
    }
    const act = SP.state.active;
    let w = 0; // drop sparks whose edge left the rendered set
    for (let i = 0; i < act.length; i++) {
      if (SP.keys.has(act[i].s + '|' + act[i].t + '|' + act[i].type)) act[w++] = act[i];
    }
    act.length = w;
    const ss = SP.strikeSparks;
    w = 0;
    for (let i = 0; i < ss.length; i++) {
      if (!ss[i].dead && SP.keys.has(ss[i].key)) ss[w++] = ss[i];
    }
    ss.length = w;
    sparksStrikeTick(SP);
    SP.ctx.cap = SP.liveCap;
    SP.ctx.fresh = sparksFreshSet();
    sparksStep(SP.state, SP.ctx);
    if (SP.state.bagCycle !== SP.cycleSeen) { SP.cycleSeen = SP.state.bagCycle; SP.sparked.clear(); }
    for (const a of act) {
      if (a.t0 !== undefined) continue;
      a.t0 = SP.clock;
      a.ph = 0;
      a.legs = 0;
      a.glow = SP.ctx.fresh.has(a.s + '|' + a.t + '|' + a.type) ? 1.6 : 1;
      a.rgb = sparksHexRgb(a.pool === 'core' ? SPARKS_CORE_COLOR : (TYPE_COLORS[a.type] || FALLBACK_LINK));
    }
  }

  // Writes one spark's trail into the buffers; returns the new float offset.
  // Every completed traversal leg marks its ARRIVAL node as sparked (honest coverage).
  function sparksDraw(SP, a, env, dt, segs, o) {
    const pos = SP.layer.pos, col = SP.layer.col;
    const A = SP.nodes.get(a.s), B = SP.nodes.get(a.t);
    if (!A || !B || A.x === undefined || B.x === undefined) return o;
    if (o + segs * 6 > pos.length) return o;
    if (a.wait > 0) { a.wait -= dt; return o; } // staggered bolt: not launched yet
    const dx = B.x - A.x, dy = (B.y || 0) - (A.y || 0), dz = (B.z || 0) - (A.z || 0);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-3) return o;
    const D = Math.min(2000, Math.max(500, (len / SPARKS_SPEED) * 1000)) / (a.fast || 1);
    a.ph += dt / D;
    const legs = Math.floor(a.ph);
    while (a.legs < legs) { a.legs++; SP.sparked.add(a.legs & 1 ? a.t : a.s); if (a.once) { a.dead = true; if (a.done) { const d = a.done; a.done = null; d(); } } }
    if (a.dead) return o;
    const m = a.ph % 2;
    const f = m < 1 ? m : 2 - m;
    const dir = m < 1 ? 1 : -1;
    const span = Math.min(0.45, SPARKS_TRAIL_WORLD / len);
    const gain = env * a.glow;
    const r = a.rgb[0] * gain, g = a.rgb[1] * gain, b = a.rgb[2] * gain;
    let p0 = f;
    let k0 = 1;
    for (let k = 0; k < segs; k++) {
      let p1 = f - dir * ((k + 1) / segs) * span;
      p1 = p1 < 0 ? 0 : (p1 > 1 ? 1 : p1);
      const k1 = 1 - (k + 1) / segs;
      pos[o] = A.x + dx * p0; pos[o + 1] = (A.y || 0) + dy * p0; pos[o + 2] = (A.z || 0) + dz * p0;
      col[o] = r * k0 * k0; col[o + 1] = g * k0 * k0; col[o + 2] = b * k0 * k0;
      o += 3;
      pos[o] = A.x + dx * p1; pos[o + 1] = (A.y || 0) + dy * p1; pos[o + 2] = (A.z || 0) + dz * p1;
      col[o] = r * k1 * k1; col[o + 1] = g * k1 * k1; col[o + 2] = b * k1 * k1;
      o += 3;
      p0 = p1;
      k0 = k1;
    }
    return o;
  }

  function sparksFrame() {
    const SP = S && S.sparks;
    if (!SP || !SP.running) return;
    SP.raf = 0;
    if (document.hidden) { SP.last = 0; return; } // onVis restarts the loop
    const now = performance.now();
    const raw = SP.last ? now - SP.last : 16;
    SP.last = now;
    const dt = Math.min(raw, 50);
    SP.clock += dt;
    SP.ema += (Math.min(raw, 200) - SP.ema) * 0.05;
    // Sustained slowness: lower the live cap toward the floor, then shorten trails.
    if (SP.ema > 24) { SP.slow++; SP.fast = 0; } else if (SP.ema < 19) { SP.fast++; SP.slow = 0; } else { SP.slow = 0; SP.fast = 0; }
    if (SP.slow > 90) {
      SP.slow = 0;
      if (SP.liveCap > SPARKS_MIN_ACTIVE) SP.liveCap--;
      else if (SP.trailSegs > 6) SP.trailSegs--;
    } else if (SP.fast > 120) {
      SP.fast = 0;
      if (SP.trailSegs < SPARKS_TRAIL_SEGS) SP.trailSegs++;
      else if (SP.liveCap < SPARKS_MAX_ACTIVE) SP.liveCap++;
    }
    const act = SP.state.active;
    const lifeMs = SPARKS_TICK_MS;
    let o = 0;
    for (let i = 0; i < act.length; i++) {
      const a = act[i];
      if (a.t0 === undefined) continue;
      const u = (SP.clock - a.t0) / (a.life * lifeMs);
      if (u >= 1) continue;
      o = sparksDraw(SP, a, Math.min(1, u / 0.1, (1 - u) / 0.18), dt, SP.trailSegs, o);
    }
    for (let i = 0; i < SP.strikeSparks.length; i++) { // may grow while drawing (next legs launch)
      const a = SP.strikeSparks[i];
      o = sparksDraw(SP, a, Math.min(1, (a.ph + 0.15) / 0.1), dt, a.segs || SP.trailSegs, o);
    }
    sparksGlowRefresh(SP, now);
    SP.layer.geo.setDrawRange(0, o / 3);
    SP.layer.posA.needsUpdate = true;
    SP.layer.colA.needsUpdate = true;
    if (now - SP.pubAt > 1000) {
      SP.pubAt = now;
      let sparked = 0;
      for (const id of SP.sparked) if (SP.reachable.has(id)) sparked++;
      const total = SP.reachable.size;
      window.__sparks = { active: act.length, cap: SP.liveCap, poolMain: SP.ctx.main.length,
        poolCore: SP.ctx.core.length, poolReach: SP.ctx.reach.length,
        frameMsEMA: Math.round(SP.ema * 10) / 10,
        nodesSparked: sparked, nodesTotal: total, nodesUnreachable: SP.unreachable,
        coveragePct: total ? Math.round((sparked / total) * 1000) / 10 : 0,
        cycle: SP.state.bagCycle, boltsRun: SP.boltsRun, strikesRun: SP.strikesRun };
    }
    SP.raf = requestAnimationFrame(sparksFrame);
  }
  // ==== U2-SPARKS:end ====
})();
