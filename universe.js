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

  // ---- Palettes ---------------------------------------------------------------
  // Domains: Okabe-Ito colorblind-safe palette (the dark blue and black are
  // skipped; they vanish on a dark background).
  const DOMAIN_COLORS = {
    people: '#CC79A7',
    projects: '#56B4E9',
    topics: '#009E73',
    places: '#F0E442',
    patterns: '#E69F00',
    library: '#D55E00',
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

  function escHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // f = focus factor (1 = normal, DIM = outside the focused neighborhood).
  function nodeColor(n, f) {
    const c = DOMAIN_COLORS[n.domain] || FALLBACK_NODE;
    const a = (n.status === 'superseded' ? 0.35 : 1) * (f == null ? 1 : f);
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
    for (const n of Array.isArray(data && data.nodes) ? data.nodes : []) {
      if (!n || n.id == null) continue;
      const id = String(n.id);
      if (byId.has(id)) continue;
      const c = centers[n.domain] || { x: 0, y: 0, z: 0 };
      const node = {
        id,
        name: String(n.label == null ? id : n.label),
        val: Math.max(1, Number(n.size) || 1),
        color: DOMAIN_COLORS[n.domain] || FALLBACK_NODE,
        domain: String(n.domain || ''),
        status: String(n.status || ''),
        date: String(n.date || ''),
        cmt: String(n.cmt || ''), // fact.v2 share-time comment; not rendered yet
        x: c.x + (hash01(id + ':x') - 0.5) * SEED_J,
        y: c.y + (hash01(id + ':y') - 0.5) * SEED_J,
        z: c.z + (hash01(id + ':z') - 0.5) * SEED_J,
      };
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
    return { nodes, byId, edges, adj };
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
    if (!S.selected || !S.visible.has(S.selected)) return null;
    const set = new Map([[S.selected, 0]]);
    let frontier = [S.selected];
    for (let hop = 1; hop <= S.focusDepth; hop++) {
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

  function updateFocus() {
    if (!S || !S.graph) return;
    S.focusSet = computeFocusSet();
    // Re-setting an accessor makes the lib re-digest node/link materials.
    S.graph
      .nodeColor((n) => nodeColor(n, focusOpacity(n.id)))
      .linkColor((l) => {
        const f = !S.focusSet || (S.focusSet.has(idOf(l.source)) && S.focusSet.has(idOf(l.target))) ? 1 : DIM;
        return f === 1 ? l.color : hexToRgba(l.color, f);
      });
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

  // Clears selection, closes the panel, restores full opacity.
  function closePanel() {
    if (!S) return;
    S.selected = null;
    S.focusDepth = 1;
    S.panelNode = null;
    S.panel.hidden = true;
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
      fitOnStop: true, paused: false,
    };

    container.textContent = '';
    const stage = h('div', 'u-stage');
    container.append(stage);
    S.stage = stage;

    // Overlay UI
    const ui = h('div', 'u-ui');
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
    S.pauseBtn = h('button', 'u-btn', 'Pause');
    S.pauseBtn.type = 'button';
    S.pauseBtn.addEventListener('click', () => {
      S.paused = !S.paused;
      if (S.paused) S.graph.pauseAnimation(); else S.graph.resumeAnimation();
      S.pauseBtn.textContent = S.paused ? 'Resume' : 'Pause';
    });
    const reheat = h('button', 'u-btn', 'Reheat');
    reheat.type = 'button';
    reheat.addEventListener('click', () => {
      if (S.paused) { S.paused = false; S.graph.resumeAnimation(); S.pauseBtn.textContent = 'Pause'; }
      S.graph.d3ReheatSimulation();
    });
    S.resetBtn = h('button', 'u-btn', 'Reset');
    S.resetBtn.type = 'button';
    S.resetBtn.hidden = true;
    S.resetBtn.addEventListener('click', resetIsolation);
    const fit = h('button', 'u-btn', 'Fit');
    fit.type = 'button';
    fit.addEventListener('click', () => S.graph.zoomToFit(600, 40));
    controls.append(S.pauseBtn, reheat, fit, S.resetBtn);

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
      .backgroundColor(BG)
      .showNavInfo(false)
      .nodeId('id')
      .nodeVal('val')
      .nodeColor('color')
      .nodeRelSize(4)
      .nodeOpacity(0.92)
      .nodeResolution(10)
      .nodeLabel((n) => escHtml(n.name)) // tooltip is rendered as HTML: escape untrusted text
      .linkColor('color')
      .linkOpacity(0.55)
      .linkWidth(0.6)
      .linkLabel(() => '') // we render our own tooltip
      .cooldownTime(15000)
      .enableNodeDrag(false) // P2-T3: node micro-drags swallowed taps (clickAfterDrag defaults false); orbit/pan unaffected, nothing uses onNodeDrag
      .onNodeClick(onNodeClick)
      .onBackgroundClick(onBackgroundClick)
      .onLinkHover((link) => {
        if (!S) return;
        if (link) {
          S.tip.textContent = link.type;
          S.tip.hidden = false;
        } else {
          S.tip.hidden = true;
        }
        S.stage.style.cursor = link ? 'pointer' : '';
      })
      .onLinkClick((link) => { if (S && link) renderEdgePanel(link); })
      .onEngineStop(() => {
        if (!S) return;
        updateFocus(); // re-apply dimming once the layout settles
        if (S.fitOnStop) {
          S.fitOnStop = false;
          S.graph.zoomToFit(800, 40);
        }
      });

    S.onResize = onResize;
    window.addEventListener('resize', S.onResize);
    S.onKey = onKeyDown;
    document.addEventListener('keydown', S.onKey);
    container.addEventListener('pointermove', onPointerMove);
    if (typeof ResizeObserver === 'function') {
      S.ro = new ResizeObserver(onResize);
      S.ro.observe(container);
    }

    applyData();
  }

  function destroy() {
    if (!S) return;
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

  window.BrainUniverse = {
    init,
    destroy,
    selectNode: (id) => tapNode(id),
    clearSelection: () => closePanel(),
    getOpacity: (id) => focusOpacity(id),
    getSelectedId: () => (S ? S.selected : null),
    getPanelRows,
  };
})();
