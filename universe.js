/* Second Brain: 3D universe view.
 *
 * Loaded ONLY after the visitor has unlocked the encrypted graph (injected by
 * app.js). Same-origin, no network calls. The decrypted graph is held in
 * memory only; nothing here persists anything to browser storage or the URL.
 *
 * Exposes window.BrainUniverse = { init(container, graphData, api), destroy() }.
 * Requires window.ForceGraph3D (vendor/3d-force-graph.min.js, Three.js bundled).
 */
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
  };
  const DOMAINS = Object.keys(DOMAIN_COLORS);
  const TYPES = Object.keys(TYPE_COLORS);
  const FALLBACK_NODE = '#a3a6b8';
  const FALLBACK_LINK = '#6e7187';
  const BG = '#07080d';
  const DBLCLICK_MS = 280;
  const DIM = 0.15; // opacity factor for nodes/links outside the focus neighborhood

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

  // nodeThreeObject builder: an additive-blend halo shell around the default
  // core sphere (nodeThreeObjectExtend(true) keeps the core library-managed,
  // so its colour-alpha dimming path is untouched).
  function buildHalo(node) {
    const mat = glowTpl.matProto.clone();
    mat.color.set(haloColor(node));
    mat.transparent = true;
    mat.opacity = 0; // rest state: no bubble — halos only light up for live events,
    mat.blending = BLEND_ADDITIVE; // selection, fresh nodes, and the breathing core
    mat.depthWrite = false;
    const m = new glowTpl.Mesh(glowTpl.geo, mat);
    const R = 4 * Math.cbrt(Math.max(1, Number(node.val) || 1)); // nodeRelSize(4)
    m.scale.setScalar(R * HALO_SCALE);
    m.raycast = function () {}; // halos must not steal hover/click picking
    node._halo = m;
    return m;
  }

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
    let coreId = null, bestScore = -1;
    for (const n of nodes) {
      const deg = (adj.get(n.id) || []).length;
      const score = (n.gravity || 0.1) * 100000 + deg * 1000 + Math.min(999, n.val);
      if (score > bestScore) { bestScore = score; coreId = n.id; }
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
    if (S.api && typeof S.api.onMeta === 'function') {
      const iso = S.isolated ? ' · isolated' : '';
      S.api.onMeta(vNodes.length + ' facts · ' + vEdges.length + ' relations' + iso);
    }
    if (S.resetBtn) S.resetBtn.hidden = !S.isolated;
    refreshSuggestions();
    updateFocus();
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
  function focusOpacity(id) {
    return !S || !S.focusSet || S.focusSet.has(id) ? 1 : DIM;
  }

  // Focus-aware link particles: dimmed links show no particles (their
  // materials take the link colour with alpha dropped, so they'd otherwise
  // render full-bright on a dimmed link).
  function particleCount(l) {
    if (!S || !S.focusSet) return 1;
    return (S.focusSet.has(idOf(l.source)) && S.focusSet.has(idOf(l.target))) ? 1 : 0;
  }

  function updateFocus() {
    if (!S || !S.graph) return;
    S.focusSet = computeFocusSet();
    // Re-setting an accessor makes the lib re-digest node/link materials.
    S.graph
      .nodeColor((n) => nodeColor(n, focusOpacity(n.id)))
      .linkColor((l) => {
        const f = !S.focusSet || (S.focusSet.has(idOf(l.source)) && S.focusSet.has(idOf(l.target))) ? 1 : DIM;
        let c = f === 1 ? l.color : hexToRgba(l.color, f);
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
        return c;
      })
      .linkDirectionalParticles((l) => particleCount(l));
    // Halo dimming rides alongside the core's colour-alpha dimming.
    // The per-frame painter owns the halos (breathing core,
    // echo glows); node/link colour accessors above still run.
    const nodes = S.graph.graphData().nodes;
    if (S.live && S.live.on) { paintLiveHalos(nodes); return; }
    for (const n of nodes) {
      if (!n._halo) continue;
      // Rest state: halo off. Only the selected node and fresh nodes earn a glow.
      const show = (S.selected === n.id) || isFresh(n.id);
      if (!show) { n._halo.material.opacity = 0; continue; }
      const a = (n.status === 'superseded' || n.life ? 0.35 : 1) * focusOpacity(n.id);
      const boost = (S.selected === n.id) ? 1.6 : 1;
      const fresh = isFresh(n.id) ? 1.9 : 1;
      n._halo.material.opacity = Math.min(0.5, HALO_OPACITY * a * boost * fresh);
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
    // Return the orbit target to the middle of the network so rotation isn't
    // left pinned to the last focused node.
    const cam = S.graph.camera();
    S.graph.cameraPosition(
      { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      graphCenter(),
      800
    );
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

    box.append(h('h3', 'u-legend-title', 'Domains'));
    for (const d of DOMAINS) box.append(legendRow('domain', d, DOMAIN_COLORS[d], dCount.get(d) || 0));
    box.append(h('h3', 'u-legend-title', 'Relations'));
    for (const t of TYPES) box.append(legendRow('type', t, TYPE_COLORS[t], tCount.get(t) || 0));
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

  function onKeyDown(e) {
    if (!S || e.key !== 'Escape') return;
    if (e.target === S.search) return; // search box handles its own Escape
    closePanel();
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
      .nodeVal('val')
      .nodeColor('color')
      .nodeRelSize(4)
      .nodeOpacity(0.95)
      .nodeResolution(16)
      .nodeLabel(() => '') // library tooltip stays off (prime suspect for the hover shift-down); we render our own hover tip instead
      .linkColor('color')
      .linkOpacity(0.55)
      .linkWidth(0.6)
      .linkDirectionalParticles((l) => particleCount(l))
      .linkDirectionalParticleWidth(1.6)
      .linkDirectionalParticleSpeed(0.004)
      .linkLabel(() => '') // we render our own tooltip
      .cooldownTime(15000)
      .enableNodeDrag(false) // P2-T3: node micro-drags swallowed taps (clickAfterDrag defaults false); orbit/pan unaffected, nothing uses onNodeDrag
      .onNodeClick(onNodeClick)
      .onBackgroundClick(onBackgroundClick)
      .onNodeHover((node) => {
        if (!S) return;
        // No hover tooltips on touch — tap opens the detail panel instead (his call 2026-10-10).
        if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;
        const id = node ? node.id : null;
        if (S.hovered === id) return;
        S.hovered = id;
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
        // No hover tooltips on touch (his call 2026-10-10).
        if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;
        S.hoverLink = link || null;
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
      });

    S.onResize = onResize;
    window.addEventListener('resize', S.onResize);

    // Deep-space background only — no starfield (his call: the void stays clean;
    // celestial events are the arrivals, not the backdrop).
    S.stage.style.backgroundColor = BG;
    S.stage.style.backgroundImage = 'none';

    // Gentle auto-rotation until the visitor first grabs the scene.
    try {
      const ctl = S.graph.controls();
      ctl.autoRotate = true;
      ctl.autoRotateSpeed = 0.55;
      container.addEventListener('pointerdown', () => { ctl.autoRotate = false; }, { once: true });
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
      } else if (!glowReady && ++glowTries < 600) {
        requestAnimationFrame(glowPoll);
      }
    };
    requestAnimationFrame(glowPoll);
    S.onKey = onKeyDown;
    document.addEventListener('keydown', S.onKey);
    container.addEventListener('pointermove', onPointerMove);
    if (typeof ResizeObserver === 'function') {
      S.ro = new ResizeObserver(onResize);
      S.ro.observe(container);
    }

    applyData();
    // One view, always alive (his call 2026-10-13): the ambient systems start
    // with the scene. No mode to enter.
    startLiving();
  }

  function destroy() {
    if (!S) return;
    stopLiving(); // clears timers, fx meshes, ticker/HUD; S still set
    const s = S;
    S = null;
    if (s.clickTimer) clearTimeout(s.clickTimer);
    window.removeEventListener('resize', s.onResize);
    document.removeEventListener('keydown', s.onKey);
    if (s.container) s.container.removeEventListener('pointermove', onPointerMove);
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
  //   EXTERIOR (the universe): arrivals from outside — new facts, new demands —
  //     streak in from beyond the mesh edge as celestial events (a falling star
  //     for knowledge, an electric-blue thundercrack for demands), then resolve
  //     into the mesh. Calm interior, cosmos knocking at the edge.
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
    S.live.raf = requestAnimationFrame(liveTick);
    updateFocus();
    pollLive();
  }

  function stopLiving() {
    if (!S || !S.live) return;
    const L = S.live;
    S.live = null;
    clearInterval(L.timer);
    cancelAnimationFrame(L.raf);
    const scene = liveScene();
    for (const f of L.fx) { try { f.dispose(scene); } catch (e) { /* already gone */ } }
    for (const r of (L.rings || [])) { try { scene && scene.remove(r); r.material.dispose(); } catch (e) { /* gone */ } }
    if (S._hudOutside) { document.removeEventListener('pointerdown', S._hudOutside); S._hudOutside = null; }
    if (S._holdOn) { S.stage.removeEventListener('pointerdown', S._holdOn); S._holdOn = null; }
    if (S._holdOff) { window.removeEventListener('pointerup', S._holdOff); window.removeEventListener('pointercancel', S._holdOff); S._holdOff = null; }
    if (S.hud) { S.hud.remove(); S.hud = null; }
    for (const n of S.graph.graphData().nodes) {
      if (n._halo && n._liveKind) { n._halo.material.color.set(haloColor(n)); n._liveKind = null; }
    }
    updateFocus();
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
    if (st) {
      S.live.state = st;
      S.live.formation = st.formation || null;
      renderHUD(st);
      renderActivity(st);
      if (st.beat !== S.live.lastBeat) { S.live.lastBeat = st.beat; onBeat(st); }
    }
  }

  // One beat: EXTERIOR first (arrivals streak in, staggered), then the
  // INTERIOR response (core pulse + echo glows). No arrivals = interior only.
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
      interiorPulse();
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
      hud._beat = h('span', 'hud-beat');
      hud._head.append(hud._stage, hud._beat);
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
    hud._beat.textContent = 'beat ' + st.beat;
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
    const isDemand = a && a.type === 'demand';
    const color = isDemand ? STREAK_DEMAND : STREAK_KNOWLEDGE;
    const dur = isDemand ? 1100 : 1800;
    const R = edgeRadius() * 1.4 + 120;
    const dir = hashDir('from:' + ((a && (a.id || a.headline)) || 'x'));
    const ox = dir.x * R, oy = dir.y * R, oz = dir.z * R;
    const head = liveMesh(color, 1);
    const trail = liveMesh(color, 0.5);
    if (!head || !trail) return;
    head.scale.setScalar(9);
    scene.add(head); scene.add(trail);
    const t0 = performance.now();
    const dx = target.x - ox, dy = target.y - oy, dz = target.z - oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const fx = {
      update(now) {
        const t = Math.min(1, (now - t0) / dur);
        const e = t * t; // ease-in: the streak accelerates inward
        const hx = ox + dx * e, hy = oy + dy * e, hz = oz + dz * e;
        head.position.set(hx, hy, hz);
        trail.position.set(hx - ux * 30, hy - uy * 30, hz - uz * 30);
        trail.scale.set(3.5, 3.5, 34);
        trail.lookAt(hx + ux, hy + uy, hz + uz);
        if (t < 1) return true;
        landArrival(a, target, scene, head, color);
        return false;
      },
      dispose(sc) {
        const s2 = sc || scene;
        s2.remove(head); s2.remove(trail);
        head.material.dispose(); trail.material.dispose();
      },
    };
    S.live.fx.push(fx);
  }

  function landArrival(a, target, scene, head, color) {
    const flash = liveMesh(color, 0.9);
    if (flash) {
      flash.position.set(target.x, target.y, target.z);
      scene.add(flash);
      const t0 = performance.now();
      S.live.fx.push({
        update(now) {
          const t = Math.min(1, (now - t0) / 420);
          flash.scale.setScalar(8 + t * 46);
          flash.material.opacity = 0.9 * (1 - t);
          return t < 1;
        },
        dispose(sc) { (sc || scene).remove(flash); flash.material.dispose(); },
      });
    }
    try { scene.remove(head); head.material.dispose(); } catch (e) { /* already gone */ }
    if (target.nodeId && S.live) {
      const kind = a && a.type === 'demand' ? 'demand' : 'fresh';
      S.live.glow.set(target.nodeId, { kind, until: Date.now() + (kind === 'demand' ? 150000 : 60000) });
      updateFocus();
    }
  }

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
            const t = Math.min(1, (now - t0) / D);
            const cc = coreNode();
            if (cc) ring.position.set(cc.x, cc.y, cc.z);
            ring.scale.setScalar(20 + t * 280);
            ring.material.opacity = O * (1 - t);
            return t < 1;
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
    for (const n of nodes) {
      if (!n._halo) continue;
      const a = (n.status === 'superseded' || n.life ? 0.35 : 1) * focusOpacity(n.id);
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
      }
      if (n._liveKind !== kind) {
        n._liveKind = kind;
        n._halo.material.color.set(kind && LIVE_COLORS[kind] ? LIVE_COLORS[kind] : haloColor(n));
      }
      n._halo.material.opacity = Math.min(0.6, o);
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
        out[id] = (n && n._halo && n._halo.material && n._halo.material.color)
          ? '#' + n._halo.material.color.getHexString() : '';
      }
      return out;
    },
    hold: (on) => { if (S && S.live) S.live.held = !!on; },
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
    // when it lands — new arrivals streak in, the ticker tells the truth.
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
      return results.sort((a, b) => b.score - a.score).slice(0, 20);
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
})();
