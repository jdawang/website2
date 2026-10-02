// Edmonton small-scale infill map. Data is built by _build/build_data.R.
(() => {
  'use strict';

  const SCRIPT_URL = document.currentScript && document.currentScript.src;
  const $ = (id) => document.getElementById(id);

  // ---- palette (validated all-pairs for CVD and normal vision, see plan) -------
  const PALETTE = {
    light: {
      types: ['#2a78d6', '#eb6834', '#1baf7a'],
      ring: '#ffffff',
      // Diverging, gold (decline) to purple (growth) with a white midpoint. Not green, which
      // would collide with the aqua Fiveplex dots. Ordered by increasing population change.
      div: ['#a8701a', '#d9a441', '#f3d98c', '#ffffff', '#c2a5cf', '#9970ab', '#762a83'],
      nodata: '#b5b5b5',
      fillOpacity: 0.65,
      line: '#8a7886',
      sel: '#663f5f',
      lrt: '#2b2b2b',
      bus: '#6b5b4b',
      halo: '#ffffff',
    },
    dark: {
      types: ['#3987e5', '#d95926', '#199e70'],
      ring: '#1b1b1b',
      div: ['#c4ad1f', '#e6cf5a', '#f3e3a0', '#ffffff', '#cfa8de', '#a86bc4', '#8a3fa8'],
      nodata: '#555555',
      fillOpacity: 0.7,
      line: '#8f7c8b',
      sel: '#c79dbf',
      lrt: '#f0f0ee',
      bus: '#c9bba9',
      halo: '#f0f0ee', // light halo so the official route colours stay visible on the dark basemap
    },
  };
  const STYLES = {
    light: [
      'https://tiles.openfreemap.org/styles/positron',
      'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    ],
    dark: [
      'https://tiles.openfreemap.org/styles/dark',
      'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    ],
  };
  const isDark = () => document.body.classList.contains('quarto-dark');
  const pal = () => (isDark() ? PALETTE.dark : PALETTE.light);

  // ---- helpers ----------------------------------------------------------------
  const nf = new Intl.NumberFormat('en-CA');
  const fmtInt = (n) => nf.format(Math.round(n));
  const fmtPct = (x, d = 1) => {
    if (x == null || Number.isNaN(x)) return 'n/a';
    if (x > 0 && x < 0.0005) return '<0.1%';
    return (x * 100).toFixed(d) + '%';
  };
  const fmtSigned = (x) =>
    x == null ? 'n/a' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(1) + '%';

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  function showError(msg) {
    const box = $('jd-error');
    box.textContent = msg;
    box.hidden = false;
  }

  async function loadJSON(name) {
    const res = await fetch(new URL(name, SCRIPT_URL));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return res.json();
  }

  // Population change 1971 to 2021 as a fraction: class edges for the diverging shading.
  // The middle class, -5% to +5%, is the white midpoint.
  const POP_BREAKS = [-0.35, -0.2, -0.05, 0.05, 0.25, 1];
  const popEdge = (b) => `${b < 0 ? '−' : '+'}${Math.round(Math.abs(b) * 100)}%`;
  const POP_LABELS = [
    `< ${popEdge(POP_BREAKS[0])}`,
    ...POP_BREAKS.slice(0, -1).map((b, i) => `${popEdge(b)} to ${popEdge(POP_BREAKS[i + 1])}`),
    `≥ ${popEdge(POP_BREAKS[POP_BREAKS.length - 1])}`,
  ];

  // ---- state -------------------------------------------------------------------
  const DEFAULT_RADII = [800];
  const DEFAULT_TYPES = [2]; // Fiveplex to Eightplex only, until the user ticks more
  const state = {
    month: 0, // last month shown; set to the final month after load
    step: 'month', // slider granularity: 'month' | 'year'
    mode: 'cum', // 'cum' (everything so far) | 'only' (just this month or year)
    types: new Set(DEFAULT_TYPES),
    occ: false, // only permits with occupancy granted (completed buildings)
    lrt: true,
    fbus: true, // frequent bus network (routes 1-9)
    fbusR: true, // its 400 m distance ring
    radii: new Set(DEFAULT_RADII), // subset of {400, 800}
    tab: 'map', // 'map' | 'table'
    sel: null, // pinned neighbourhood id
    hover: null,
  };
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  let map;
  let D; // loaded data + derived structures
  let styleReady = false;
  let usedFallback = false;
  let playTimer = null;
  let popup = null;
  let sortState = { key: 'p', dir: -1 };
  const tableFilter = { q: '', type: '' };

  // ---- data derivation ---------------------------------------------------------
  function derive(permits, facts, nbhd, lrt, fbus) {
    const meta = permits.meta;
    const M = meta.n_months;
    const T = meta.types.length;
    const feats = nbhd.features;
    const N = feats.length;
    const idIndex = new Map(feats.map((f, i) => [f.properties.id, i]));

    const at = (n, t, m) => (n * T + t) * M + m;
    // Prefix sums over months, per neighbourhood and type. `cols` names the three fact
    // columns (permits, homes, mapped permits) to accumulate.
    const buildCube = (cols) => {
      const cube = { p: new Int32Array(N * T * M), u: new Int32Array(N * T * M), pm: new Int32Array(N * T * M) };
      for (let r = 0; r < facts.id.length; r++) {
        const n = idIndex.get(facts.id[r]);
        if (n === undefined) continue;
        const k = at(n, facts.t[r], facts.m[r]);
        cube.p[k] += facts[cols[0]][r];
        cube.u[k] += facts[cols[1]][r];
        cube.pm[k] += facts[cols[2]][r];
      }
      for (let n = 0; n < N; n++)
        for (let t = 0; t < T; t++)
          for (let m = 1; m < M; m++) {
            const k = at(n, t, m);
            cube.p[k] += cube.p[k - 1];
            cube.u[k] += cube.u[k - 1];
            cube.pm[k] += cube.pm[k - 1];
          }
      return cube;
    };
    const cum = buildCube(['p', 'u', 'pm']);
    const cumOcc = buildCube(['po', 'uo', 'pmo']); // permits with occupancy granted

    // Permit points as GeoJSON, built once from the column arrays.
    const pts = [];
    for (let i = 0; i < permits.t.length; i++) {
      pts.push({
        type: 'Feature',
        properties: { t: permits.t[i], m: permits.m[i], u: permits.u[i], o: permits.o[i], i: permits.i[i], q: permits.q[i], a: permits.a[i] },
        geometry: { type: 'Point', coordinates: [permits.x0 + permits.x[i] / permits.s, permits.y0 + permits.y[i] / permits.s] },
      });
    }

    const months = Array.from({ length: M }, (_, m) => new Date(2024, m, 1));

    return {
      meta, M, T, N, feats, idIndex, cum, cumOcc, at, months,
      permitsFC: { type: 'FeatureCollection', features: pts },
      nbhdFC: nbhd,
      lrtFC: lrt,
      fbusFC: fbus,
      rsTotal: feats.reduce((s, f) => s + f.properties.rs, 0),
    };
  }

  // YYYYMM integer (as stored in permits.json) to "Mar 2026".
  const monthYearFromYm = (ym) => new Date(Math.floor(ym / 100), (ym % 100) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const monthShort = (m) => D.months[m].toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  // ---- time window -------------------------------------------------------------
  // The window is [rangeStart(), state.month]. In year step state.month is always a
  // year-end (Dec, or the last month of data), so "only" covers that whole year.
  const yearEndMonth = (yearIndex) => Math.min(D.M - 1, yearIndex * 12 + 11);
  const snapToYearEnd = (m) => yearEndMonth(Math.floor(m / 12));
  function rangeStart() {
    if (state.mode === 'cum') return 0;
    return state.step === 'year' ? Math.floor(state.month / 12) * 12 : state.month;
  }
  const isPartialYear = (m) => m === D.M - 1 && m % 12 !== 11;
  const yearNumber = (m) => 2024 + Math.floor(m / 12);
  const monthName = (m) => D.months[m].toLocaleDateString('en-US', { month: 'short' });
  // "2025", or "2026 (Jan–Sep)" for the year the data stops in.
  const yearLabel = (m) => (isPartialYear(m) ? `${yearNumber(m)} (Jan–${monthName(m)})` : String(yearNumber(m)));

  // Human-readable description of the window, plus a short phrase for the panel.
  function periodInfo() {
    const m = state.month;
    if (state.mode === 'cum') {
      const end = state.step === 'year' && !isPartialYear(m) ? String(yearNumber(m)) : monthShort(m);
      return { label: `Cumulative through ${end}`, scope: `through ${end}` };
    }
    const only = state.step === 'year' ? yearLabel(m) : monthShort(m);
    return { label: `${only} only`, scope: `in ${only}` };
  }

  // Sum over active types for one neighbourhood (index n), from the prefix-sum cube.
  function nbAgg(n, types = state.types) {
    const start = rangeStart();
    const cube = state.occ ? D.cumOcc : D.cum;
    let p = 0, u = 0, pm = 0;
    for (const t of types) {
      const k = D.at(n, t, state.month);
      p += cube.p[k];
      u += cube.u[k];
      pm += cube.pm[k];
      if (start > 0) {
        const k0 = D.at(n, t, start - 1);
        p -= cube.p[k0];
        u -= cube.u[k0];
        pm -= cube.pm[k0];
      }
    }
    return { p, u, pm };
  }

  // ---- map overlay -------------------------------------------------------------
  function permitFilter() {
    return [
      'all',
      ['>=', ['get', 'm'], rangeStart()],
      ['<=', ['get', 'm'], state.month],
      ['in', ['get', 't'], ['literal', [...state.types]]],
      ...(state.occ ? [['>', ['get', 'o'], 0]] : []),
    ];
  }

  // Colour by the neighbourhood's 1971-2021 population change (a fixed property, so the
  // shading does not move with the slider or the filters). No 1971 count = grey.
  function fillColorExpr(p) {
    const pg = ['get', 'pg'];
    const steps = ['step', pg, p.div[0]];
    POP_BREAKS.forEach((b, i) => steps.push(b, p.div[i + 1]));
    return ['case', ['==', ['typeof', pg], 'number'], steps, p.nodata];
  }

  function firstSymbolId() {
    const layer = map.getStyle().layers.find((l) => l.type === 'symbol');
    return layer && layer.id;
  }

  // The first basemap layer above ALL of its roads, fills and lines (i.e. the lowest
  // label layer that has no drawn layers above it). Some styles put road layers above
  // their first label layer, so inserting there would leave roads painted over the LRT.
  // Returns undefined when nothing sits above, meaning "add on top".
  function aboveBasemapDrawingId() {
    const layers = map.getStyle().layers;
    let last = -1;
    layers.forEach((l, i) => { if (l.type !== 'symbol') last = i; });
    return layers[last + 1] && layers[last + 1].id;
  }

  function addOverlay() {
    const p = pal();
    const before = firstSymbolId();
    const beforeTop = aboveBasemapDrawingId();
    const sel = ['boolean', ['feature-state', 'selected'], false];
    const hov = ['boolean', ['feature-state', 'hover'], false];

    map.addSource('jd-nbhd', { type: 'geojson', data: D.nbhdFC, promoteId: 'id' });
    map.addLayer({
      id: 'jd-nbhd-fill', type: 'fill', source: 'jd-nbhd',
      paint: { 'fill-color': fillColorExpr(p), 'fill-opacity': ['case', sel, Math.min(1, p.fillOpacity + 0.2), hov, Math.min(1, p.fillOpacity + 0.12), p.fillOpacity] },
    }, before);
    map.addLayer({
      id: 'jd-nbhd-line', type: 'line', source: 'jd-nbhd',
      paint: {
        'line-color': ['case', sel, p.sel, p.line],
        'line-width': ['case', sel, 2.5, hov, 1.5, 0.6],
        'line-opacity': ['case', sel, 1, 0.75],
      },
    }, before);

    // Frequent bus sits under the LRT layers: ring, route line, then stops (zoomed in only).
    map.addSource('jd-fbus-buffers', { type: 'geojson', data: D.fbusFC.buffers });
    map.addSource('jd-fbus-lines', { type: 'geojson', data: D.fbusFC.lines });
    map.addSource('jd-fbus', { type: 'geojson', data: D.fbusFC.stops });
    map.addLayer({
      id: 'jd-fbus-buf-halo', type: 'line', source: 'jd-fbus-buffers',
      layout: { 'line-join': 'round' }, paint: { 'line-color': p.ring, 'line-width': 4, 'line-opacity': 0.7 },
    }, beforeTop);
    map.addLayer({
      id: 'jd-fbus-buf', type: 'line', source: 'jd-fbus-buffers',
      paint: { 'line-color': p.bus, 'line-width': 1.5, 'line-opacity': 0.95 },
    }, beforeTop);
    map.addLayer({
      id: 'jd-fbus-line-casing', type: 'line', source: 'jd-fbus-lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.halo, 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 15, 5.5] },
    }, beforeTop);
    map.addLayer({
      id: 'jd-fbus-line', type: 'line', source: 'jd-fbus-lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.bus, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.25, 15, 3] },
    }, beforeTop);
    map.addLayer({
      id: 'jd-fbus-stop', type: 'circle', source: 'jd-fbus', minzoom: 12,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 15, 3],
        'circle-color': p.bus,
        'circle-stroke-color': p.halo,
        'circle-stroke-width': 0.75,
      },
    }, beforeTop);

    // LRT: radii, then the line (casing under it), then stops. Layers go before the
    // basemap's labels, in this order, so later ones sit on top of earlier ones.
    map.addSource('jd-lrt-buffers', { type: 'geojson', data: D.lrtFC.buffers });
    map.addSource('jd-lrt-lines', { type: 'geojson', data: D.lrtFC.lines });
    map.addSource('jd-lrt', { type: 'geojson', data: D.lrtFC.stops });
    // Radii: a surface-colour halo under each ring keeps it legible over the busy
    // choropleth, especially the dark ramp.
    const ringPaint = { 'line-color': p.lrt, 'line-width': 1.75, 'line-opacity': 0.95 };
    const ringHalo = { 'line-color': p.ring, 'line-width': 4, 'line-opacity': 0.7 };
    for (const r of [800, 400]) {
      map.addLayer({
        id: `jd-lrt-buf-${r}-halo`, type: 'line', source: 'jd-lrt-buffers', filter: ['==', ['get', 'r'], r],
        layout: { 'line-join': 'round' }, paint: ringHalo,
      }, beforeTop);
      map.addLayer({
        id: `jd-lrt-buf-${r}`, type: 'line', source: 'jd-lrt-buffers', filter: ['==', ['get', 'r'], r],
        paint: r === 800 ? { ...ringPaint, 'line-dasharray': [3, 2] } : ringPaint,
      }, beforeTop);
    }
    const roundLine = { 'line-cap': 'round', 'line-join': 'round' };
    const lineWidth = ['interpolate', ['linear'], ['zoom'], 9, 2, 15, 4.75];
    const haloWidth = ['interpolate', ['linear'], ['zoom'], 9, 3.75, 15, 8.25];
    // Existing lines and under-construction lines share a light halo; construction
    // lines are the same weight, drawn dashed so the halo shows through the gaps.
    for (const [kind, id, dash] of [['existing', 'jd-lrt-line', null], ['construction', 'jd-lrt-line-future', [3, 1.4]]]) {
      map.addLayer({
        id: `${id === 'jd-lrt-line' ? 'jd-lrt-line-casing' : 'jd-lrt-line-future-casing'}`, type: 'line', source: 'jd-lrt-lines',
        filter: ['==', ['get', 'kind'], kind], layout: roundLine,
        paint: { 'line-color': p.halo, 'line-opacity': 0.92, 'line-width': haloWidth },
      }, beforeTop);
      map.addLayer({
        id, type: 'line', source: 'jd-lrt-lines', filter: ['==', ['get', 'kind'], kind],
        layout: dash ? { 'line-join': 'round' } : roundLine,
        // Official route colours (GTFS route_color), carried on each feature.
        paint: dash ? { 'line-color': ['get', 'colour'], 'line-width': lineWidth, 'line-dasharray': dash } : { 'line-color': ['get', 'colour'], 'line-width': lineWidth },
      }, beforeTop);
    }
    map.addLayer({
      id: 'jd-lrt-stop', type: 'circle', source: 'jd-lrt',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 15, 5.5],
        'circle-color': p.lrt,
        'circle-opacity': ['case', ['==', ['get', 'status'], 'future'], 0, 1],
        'circle-stroke-color': p.lrt,
        'circle-stroke-width': 1.5,
      },
    });

    map.addSource('jd-permits', { type: 'geojson', data: D.permitsFC, buffer: 0, tolerance: 0, maxzoom: 14 });
    map.addLayer({
      id: 'jd-permits', type: 'circle', source: 'jd-permits',
      filter: permitFilter(),
      paint: {
        'circle-color': ['match', ['get', 't'], 0, p.types[0], 1, p.types[1], 2, p.types[2], '#888888'],
        // One size for every permit; dot size does not encode homes added.
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.25, 15, 4],
        'circle-opacity': 0.9,
        'circle-stroke-color': p.ring,
        'circle-stroke-width': 0.75,
      },
    });

    map.addSource('jd-hi', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'jd-permits-hi', type: 'circle', source: 'jd-hi',
      paint: {
        'circle-color': 'rgba(0,0,0,0)',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 15, 7.5],
        'circle-stroke-color': p.sel,
        'circle-stroke-width': 2.5,
      },
    });

    applyTransit();
    if (state.sel != null) map.setFeatureState({ source: 'jd-nbhd', id: state.sel }, { selected: true });
    if (state.hover != null) map.setFeatureState({ source: 'jd-nbhd', id: state.hover }, { hover: true });
  }

  // Show or hide the LRT layers. Radii only show while the LRT checkbox is on.
  function applyTransit() {
    if (!map || !map.getLayer('jd-lrt-stop')) return;
    const vis = (on) => (on ? 'visible' : 'none');
    for (const id of ['jd-fbus-line-casing', 'jd-fbus-line', 'jd-fbus-stop']) map.setLayoutProperty(id, 'visibility', vis(state.fbus));
    for (const id of ['jd-fbus-buf', 'jd-fbus-buf-halo']) map.setLayoutProperty(id, 'visibility', vis(state.fbus && state.fbusR));
    for (const id of ['jd-lrt-stop', 'jd-lrt-line-casing', 'jd-lrt-line', 'jd-lrt-line-future-casing', 'jd-lrt-line-future']) {
      map.setLayoutProperty(id, 'visibility', vis(state.lrt));
    }
    for (const r of [400, 800]) {
      for (const id of [`jd-lrt-buf-${r}`, `jd-lrt-buf-${r}-halo`]) {
        map.setLayoutProperty(id, 'visibility', vis(state.lrt && state.radii.has(r)));
      }
    }
  }

  // ---- UI updates --------------------------------------------------------------
  let rafPending = false;
  let announceTimer = null;
  function scheduleUpdate(announce = false) {
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        update();
      });
    }
    if (announce && playTimer == null) {
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => {
        const t = totals();
        $('jd-live').textContent = `${$('jd-month-label').textContent}: ${fmtInt(t.p)} permits, ${fmtInt(t.u)} homes.`;
      }, 600);
    }
  }

  function totals() {
    let p = 0, u = 0, pm = 0, withPermit = 0;
    for (let n = 0; n < D.N; n++) {
      const a = nbAgg(n);
      p += a.p; u += a.u; pm += a.pm;
      if (a.p > 0) withPermit++;
    }
    return { p, u, pm, withPermit };
  }

  function update() {
    if (map && map.getLayer('jd-permits')) {
      map.setFilter('jd-permits', permitFilter());
    }
    const yearStep = state.step === 'year';
    $('jd-slider').value = yearStep ? Math.floor(state.month / 12) : state.month;
    $('jd-month-label').textContent = periodInfo().label;
    $('jd-slider').setAttribute('aria-valuetext', yearStep ? yearLabel(state.month) : monthShort(state.month));

    const t = totals();
    const tiles = [
      [fmtInt(t.p), `permits (of ${fmtInt(D.meta.n_total)})`],
      [fmtInt(t.u), `homes (of ${fmtInt(D.meta.units_total)})`],
      [fmtInt(t.withPermit), 'neighbourhoods with a permit'],
      [fmtPct(t.p / D.rsTotal, 2), 'of RS lots redeveloped'],
    ];
    const box = $('jd-tiles');
    box.replaceChildren(...tiles.map(([v, l]) => el('div', { class: 'jd-tile' }, el('div', { class: 'jd-tile-v', text: v }), el('div', { class: 'jd-tile-l', text: l }))));
    const unmapped = t.p - t.pm;
    $('jd-disclosure').textContent = unmapped > 0
      ? `${fmtInt(unmapped)} of these ${fmtInt(t.p)} permits have no usable location. They are counted in the totals and neighbourhood stats but not plotted.`
      : '';

    // Per-type counts beside the checkboxes (independent of the type filter).
    for (let ti = 0; ti < D.T; ti++) {
      let c = 0;
      for (let n = 0; n < D.N; n++) c += nbAgg(n, [ti]).p;
      const span = $(`jd-count-${ti}`);
      if (span) span.textContent = fmtInt(c);
    }

    const active = state.hover != null && !state.sel ? state.hover : state.sel;
    if (active != null) renderPanel(active);
    if (state.tab === 'table') renderTable();
    writeHash();
  }

  // ---- neighbourhood panel -----------------------------------------------------
  function renderPanel(id) {
    const n = D.idIndex.get(id);
    if (n === undefined) return;
    const f = D.feats[n].properties;
    const a = nbAgg(n);
    $('jd-panel-title').textContent = f.nm;
    $('jd-panel-sub').textContent = [f.wd, f.ty].filter(Boolean).join(' · ');
    const rows = [
      ['Permits', fmtInt(a.p)],
      ['Homes added', fmtInt(a.u)],
      ['RS properties', fmtInt(f.rs)],
      ['% of RS lots redeveloped', fmtPct(f.rs > 0 ? a.p / f.rs : null, 1)],
      ['Population, 1971', f.p71 == null ? 'n/a' : fmtInt(f.p71)],
      ['Population, 2021', f.p21 == null ? 'n/a' : fmtInt(f.p21)],
      ['Population vs. 1971', fmtSigned(f.pg)],
    ];
    const dl = el('dl');
    for (const [k, v] of rows) dl.append(el('dt', { text: k }), el('dd', { text: v }));
    const byType = el('div');
    D.meta.types.forEach((name, ti) => {
      byType.append(el('div', { class: 'jd-by-type' }, el('span', { class: 'jd-swatch', style: `background:${pal().types[ti]}` }), el('span', { text: name }), el('b', { text: fmtInt(nbAgg(n, [ti]).p) })));
    });
    $('jd-panel-body').replaceChildren(
      dl,
      el('h3', { text: `Permits by type, ${periodInfo().scope}` }),
      byType,
      el('p', { class: 'jd-note', text: 'Headline numbers follow the type filter; the breakdown always shows all three. Both follow the occupancy filter when it is on. Population growth is only available for neighbourhoods counted in 1971.' }),
    );
    $('jd-panel').hidden = false;
    $('jd-app').classList.add('jd-panel-open');
    $('jd-panel-close').hidden = state.sel == null;
  }

  function hidePanel() {
    $('jd-panel').hidden = true;
    $('jd-app').classList.remove('jd-panel-open');
  }

  function setHover(id) {
    if (state.hover === id) return;
    if (state.hover != null) map.setFeatureState({ source: 'jd-nbhd', id: state.hover }, { hover: false });
    state.hover = id;
    if (id != null) map.setFeatureState({ source: 'jd-nbhd', id }, { hover: true });
    if (state.sel == null) {
      if (id != null) renderPanel(id);
      else hidePanel();
    }
  }

  function setSelected(id) {
    if (state.sel != null && map.getSource('jd-nbhd')) map.setFeatureState({ source: 'jd-nbhd', id: state.sel }, { selected: false });
    state.sel = id;
    if (id != null) {
      map.setFeatureState({ source: 'jd-nbhd', id }, { selected: true });
      renderPanel(id);
    } else if (state.hover != null) renderPanel(state.hover);
    else hidePanel();
    writeHash();
  }

  // ---- table view --------------------------------------------------------------
  const COLUMNS = [
    ['nm', 'Neighbourhood'], ['wd', 'Ward'], ['ty', 'Type'], ['p', 'Permits'], ['u', 'Homes'],
    ['rs', 'RS lots'], ['pct', '% redeveloped'], ['p71', 'Pop. 1971'], ['p21', 'Pop. 2021'], ['pg', 'vs. 1971'],
  ];
  const TEXT_COLS = new Set(['nm', 'wd', 'ty']);

  // Rows for the current period, type and occupancy filters, then the search box and
  // type select, sorted by the active column.
  function tableRows() {
    const q = tableFilter.q.trim().toLowerCase();
    const rows = D.feats
      .map((feat, n) => {
        const f = feat.properties;
        const a = nbAgg(n);
        return { id: f.id, nm: f.nm, wd: f.wd, ty: f.ty, p: a.p, u: a.u, rs: f.rs, pct: f.rs > 0 ? a.p / f.rs : null, p71: f.p71, p21: f.p21, pg: f.pg, pt: f.pt };
      })
      .filter((r) => r.pt > 0)
      .filter((r) => !q || r.nm.toLowerCase().includes(q))
      .filter((r) => !tableFilter.type || r.ty === tableFilter.type);
    const { key, dir } = sortState;
    rows.sort((x, y) => {
      const a = x[key], b = y[key];
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return (typeof a === 'string' ? a.localeCompare(b) : a - b) * dir;
    });
    return rows;
  }

  function renderTable() {
    const rows = tableRows();
    const { key, dir } = sortState;
    $('jd-row-count').textContent = `${fmtInt(rows.length)} neighbourhoods`;
    const head = el('tr', {}, ...COLUMNS.map(([k, label]) => {
      const th = el('th', { scope: 'col', 'aria-sort': key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none' });
      th.append(el('button', {
        type: 'button', text: label + (key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''),
        onclick: () => {
          sortState = { key: k, dir: key === k ? -dir : (TEXT_COLS.has(k) ? 1 : -1) };
          renderTable();
        },
      }));
      return th;
    }));
    const body = rows.map((r) => el('tr', {},
      el('td', {}, el('button', { type: 'button', text: r.nm, title: 'Show on the map', onclick: () => selectFromTable(r.id) })),
      el('td', { text: r.wd || '' }),
      el('td', { text: r.ty || '' }),
      el('td', { text: fmtInt(r.p) }),
      el('td', { text: fmtInt(r.u) }),
      el('td', { text: fmtInt(r.rs) }),
      el('td', { text: fmtPct(r.pct, 1) }),
      el('td', { text: r.p71 == null ? 'n/a' : fmtInt(r.p71) }),
      el('td', { text: r.p21 == null ? 'n/a' : fmtInt(r.p21) }),
      el('td', { text: fmtSigned(r.pg) }),
    ));
    $('jd-table-host').replaceChildren(el('table', { id: 'jd-table' }, el('thead', {}, head), el('tbody', {}, ...body)));
  }

  function downloadCsv() {
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const cols = [['nm', 'Neighbourhood'], ['wd', 'Ward'], ['ty', 'Type'], ['p', 'Permits'], ['u', 'Homes added'], ['rs', 'RS properties'], ['pct', 'Share of RS lots redeveloped'], ['p71', 'Population 1971'], ['p21', 'Population 2021'], ['pg', 'Population change vs 1971']];
    const lines = [cols.map(([, h]) => esc(h)).join(',')];
    for (const r of tableRows()) lines.push(cols.map(([k]) => esc(k === 'pct' && r.pct != null ? r.pct.toFixed(4) : r[k])).join(','));
    const types = [...state.types].sort().map((t) => D.meta.types[t]).join(' + ');
    lines.push('', esc(`${periodInfo().label}; ${types}${state.occ ? '; occupancy granted only' : ''}; data as of ${D.meta.as_of}`));
    const a = el('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: 'edmonton-infill-by-neighbourhood.csv' });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function applyView() {
    const table = state.tab === 'table';
    $('jd-app').classList.toggle('jd-view-table', table);
    $('jd-tableview').hidden = !table;
    document.querySelector(`input[name="jd-view"][value="${state.tab}"]`).checked = true;
    if (table) {
      if (popup) popup.remove();
      renderTable();
    } else if (map) {
      map.resize();
      if (state.sel != null) renderPanel(state.sel);
    }
    writeHash();
  }

  function selectFromTable(id) {
    state.tab = 'map';
    applyView();
    setSelected(id);
    const f = D.feats[D.idIndex.get(id)];
    const bb = geometryBounds(f.geometry);
    map.fitBounds(bb, { padding: { top: 90, bottom: 90, left: 340, right: 360 }, maxZoom: 14.5 });
  }

  function geometryBounds(geom) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]);
        y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
      } else c.forEach(walk);
    };
    walk(geom.coordinates);
    return [[x0, y0], [x1, y1]];
  }

  // ---- popups ------------------------------------------------------------------
  function permitPopup(e) {
    const r = 6;
    const box = [[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]];
    const seen = new Set();
    const hits = map.queryRenderedFeatures(box, { layers: ['jd-permits'] }).filter((f) => {
      const k = `${f.properties.a}|${f.properties.m}|${f.properties.u}|${f.properties.t}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!hits.length) return false;
    const shown = hits.slice(0, 5);
    const content = el('div');
    for (const f of shown) {
      const p = f.properties;
      const nb = D.feats[D.idIndex.get(p.i)];
      content.append(el('div', { class: 'jd-popup' },
        el('strong', { text: p.a }),
        el('div', { text: `${D.meta.types[p.t]} · ${p.u} ${p.u === 1 ? 'home' : 'homes'}` }),
        el('div', { class: 'jd-muted', text: `${monthShort(p.m)}${nb ? ' · ' + nb.properties.nm : ''}` }),
        el('div', { class: 'jd-muted', text: p.o > 0 ? `Occupancy granted ${monthYearFromYm(p.o)}` : 'Occupancy not yet granted' }),
        p.q === 1 ? el('div', { class: 'jd-muted', text: 'Location from the property address record (approximate).' }) : null,
      ));
    }
    if (hits.length > shown.length) content.append(el('div', { class: 'jd-muted', text: `+ ${hits.length - shown.length} more here. Zoom in to separate them.` }));
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ maxWidth: '260px', offset: 10 })
      .setLngLat(shown[0].geometry.coordinates)
      .setDOMContent(content)
      .addTo(map);
    map.getSource('jd-hi').setData({ type: 'FeatureCollection', features: shown });
    popup.on('close', () => map.getSource('jd-hi') && map.getSource('jd-hi').setData({ type: 'FeatureCollection', features: [] }));
    return true;
  }

  // ---- URL hash ----------------------------------------------------------------
  let hashTimer = null;
  function writeHash() {
    if (!map) return;
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      const c = map.getCenter();
      const parts = [
        `m=${state.month}`,
        `t=${[...state.types].sort().join(',')}`,
        state.step === 'year' ? 'step=year' : null,
        state.mode === 'only' ? 'mode=only' : null,
        state.occ ? 'occ=1' : null,
        state.lrt ? null : 'lrt=0',
        state.fbus ? null : 'bus=0',
        state.fbus && !state.fbusR ? 'br=0' : null,
        // Only written when it differs from the default; `r=` alone means both rings off.
        [...state.radii].sort().join(',') === DEFAULT_RADII.join(',') ? null : `r=${[...state.radii].sort().join(',')}`,
        state.tab === 'table' ? 'view=table' : null,
        state.sel != null ? `nb=${state.sel}` : null,
        `v=${map.getZoom().toFixed(2)}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`,
      ].filter(Boolean);
      try { history.replaceState(null, '', '#' + parts.join('&')); } catch (_) { /* ignore */ }
    }, 300);
  }

  function readHash() {
    const out = {};
    const h = location.hash.replace(/^#/, '');
    if (!h) return out;
    const params = new URLSearchParams(h);
    const m = parseInt(params.get('m'), 10);
    if (Number.isInteger(m)) out.month = Math.max(0, Math.min(D.M - 1, m));
    if (params.has('t')) {
      const t = params.get('t').split(',').filter((s) => s !== '').map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < D.T);
      if (t.length) out.types = new Set(t); // nothing valid: keep the default of all types
    }
    if (params.get('step') === 'year') out.step = 'year';
    if (params.get('mode') === 'only') out.mode = 'only';
    if (params.get('occ') === '1') out.occ = true;
    if (params.get('lrt') === '0') out.lrt = false;
    if (params.get('bus') === '0') out.fbus = false;
    if (params.get('br') === '0') out.fbusR = false;
    if (params.has('r')) {
      out.radii = new Set(params.get('r').split(',').map(Number).filter((x) => x === 400 || x === 800));
    }
    if (params.get('view') === 'table') out.tab = 'table';
    const nb = parseInt(params.get('nb'), 10);
    if (D.idIndex.has(nb)) out.sel = nb;
    const v = (params.get('v') || '').split('/').map(Number);
    if (v.length === 3 && v.every(Number.isFinite)) out.view = { zoom: Math.max(8, Math.min(18, v[0])), center: [v[2], v[1]] };
    return out;
  }

  // ---- controls ---------------------------------------------------------------
  function buildControls() {
    const list = $('jd-type-list');
    D.meta.types.forEach((name, ti) => {
      const cb = el('input', { type: 'checkbox', 'data-t': ti });
      cb.checked = state.types.has(ti);
      cb.addEventListener('change', () => {
        cb.checked ? state.types.add(ti) : state.types.delete(ti);
        scheduleUpdate(true);
      });
      list.append(el('label', {}, cb, el('span', { class: 'jd-swatch', 'data-swatch': ti }), el('span', { text: name }), el('span', { class: 'jd-count', id: `jd-count-${ti}` })));
    });

    $('jd-slider').addEventListener('input', (e) => {
      const v = +e.target.value;
      state.month = state.step === 'year' ? yearEndMonth(v) : v;
      scheduleUpdate(true);
    });
    document.querySelectorAll('.jd-chip').forEach((b) =>
      b.addEventListener('click', () => {
        stopPlay();
        const year = +b.dataset.year;
        state.month = Math.min(D.M - 1, (year - 2024) * 12 + 11);
        scheduleUpdate(true);
      }));
    $('jd-occ').addEventListener('change', (e) => {
      state.occ = e.target.checked;
      scheduleUpdate(true);
    });
    document.querySelectorAll('input[name="jd-step"]').forEach((r) =>
      r.addEventListener('change', () => {
        stopPlay();
        state.step = r.value;
        if (state.step === 'year') state.month = snapToYearEnd(state.month);
        applyStepUI();
        scheduleUpdate(true);
      }));
    document.querySelectorAll('input[name="jd-mode"]').forEach((r) =>
      r.addEventListener('change', () => {
        state.mode = r.value;
        scheduleUpdate(true);
      }));
    $('jd-lrt').addEventListener('change', (e) => {
      state.lrt = e.target.checked;
      syncTransitControls();
      applyTransit();
      writeHash();
    });
    $('jd-fbus').addEventListener('change', (e) => {
      state.fbus = e.target.checked;
      syncTransitControls();
      applyTransit();
      writeHash();
    });
    $('jd-fbus-r').addEventListener('change', (e) => {
      state.fbusR = e.target.checked;
      applyTransit();
      writeHash();
    });
    document.querySelectorAll('.jd-radius').forEach((cb) =>
      cb.addEventListener('change', () => {
        const r = +cb.value;
        cb.checked ? state.radii.add(r) : state.radii.delete(r);
        applyTransit();
        writeHash();
      }));
    $('jd-play').addEventListener('click', () => (playTimer == null ? startPlay() : stopPlay()));
    $('jd-collapse').addEventListener('click', () => {
      const c = $('jd-controls').classList.toggle('collapsed');
      $('jd-collapse').setAttribute('aria-expanded', String(!c));
      $('jd-collapse').setAttribute('aria-label', c ? 'Expand controls' : 'Collapse controls');
      $('jd-collapse').firstElementChild.textContent = c ? '▴' : '▾';
    });
    $('jd-reset').addEventListener('click', resetAll);
    $('jd-share').addEventListener('click', async () => {
      const b = $('jd-share');
      try {
        await navigator.clipboard.writeText(location.href);
        b.textContent = 'Copied';
      } catch (_) {
        b.textContent = 'Copy failed';
      }
      setTimeout(() => (b.textContent = 'Copy link'), 1500);
    });
    $('jd-panel-close').addEventListener('click', () => setSelected(null));
    document.querySelectorAll('input[name="jd-view"]').forEach((r) =>
      r.addEventListener('change', () => {
        state.tab = r.value;
        applyView();
      }));
    const tf = $('jd-type-filter');
    tf.replaceChildren(el('option', { value: '', text: 'All neighbourhood types' }),
      ...[...new Set(D.feats.map((f) => f.properties.ty).filter(Boolean))].sort().map((t) => el('option', { value: t, text: t })));
    tf.addEventListener('change', () => { tableFilter.type = tf.value; renderTable(); });
    $('jd-search').addEventListener('input', (e) => { tableFilter.q = e.target.value; renderTable(); });
    $('jd-csv').addEventListener('click', downloadCsv);
    if (window.matchMedia('(max-width: 820px)').matches) $('jd-collapse').click();
    buildMethods();
  }

  // Legend for the line colours, read from the data so it can't drift from the map.
  function buildLineKey() {
    const seen = new Map();
    for (const f of D.lrtFC.lines.features) seen.set(f.properties.line, f.properties.colour);
    $('jd-line-key').replaceChildren(...['Capital', 'Metro', 'Valley'].filter((n) => seen.has(n)).map((n) =>
      el('span', {}, el('i', { class: 'jd-line-swatch jd-thick', style: `border-top-color:${seen.get(n)}` }), document.createTextNode(n))));
  }

  // The radius checkboxes only make sense while the LRT layer is on.
  function syncTransitControls() {
    document.querySelectorAll('.jd-radius').forEach((cb) => {
      cb.checked = state.radii.has(+cb.value);
      cb.disabled = !state.lrt;
    });
    $('jd-fbus-r').checked = state.fbusR;
    $('jd-fbus-r').disabled = !state.fbus;
  }

  // Slider range, tick labels, year chips and the "only" label depend on the step size.
  function applyStepUI() {
    const yearStep = state.step === 'year';
    $('jd-slider').max = yearStep ? Math.ceil(D.M / 12) - 1 : D.M - 1;
    $('jd-ticks').hidden = !yearStep;
    $('jd-chips').hidden = yearStep;
    $('jd-only-label').textContent = yearStep ? 'This year only' : 'This month only';
    if (yearStep) {
      $('jd-ticks').replaceChildren(...Array.from({ length: Math.ceil(D.M / 12) }, (_, i) => el('span', { text: yearLabel(yearEndMonth(i)) })));
    }
  }

  function syncControls() {
    document.querySelectorAll('#jd-type-list input').forEach((cb) => (cb.checked = state.types.has(+cb.dataset.t)));
    document.querySelector(`input[name="jd-mode"][value="${state.mode}"]`).checked = true;
    document.querySelector(`input[name="jd-step"][value="${state.step}"]`).checked = true;
    $('jd-lrt').checked = state.lrt;
    $('jd-fbus').checked = state.fbus;
    $('jd-occ').checked = state.occ;
    syncTransitControls();
    applyStepUI();
    $('jd-search').value = tableFilter.q = '';
    $('jd-type-filter').value = tableFilter.type = '';
  }

  function resetAll() {
    stopPlay();
    Object.assign(state, { tab: 'map', month: D.M - 1, step: 'month', mode: 'cum', types: new Set(DEFAULT_TYPES), occ: false, lrt: true, fbus: true, fbusR: true, radii: new Set(DEFAULT_RADII) });
    setSelected(null);
    syncControls();
    applyView();
    applyTransit();
    map.easeTo(defaultView());
    scheduleUpdate(true);
  }

  // Advance one month (or one year in year step). Returns false once at the end.
  function advance() {
    const last = D.M - 1;
    if (state.month >= last) return false;
    state.month = state.step === 'year' ? yearEndMonth(Math.floor(state.month / 12) + 1) : state.month + 1;
    return true;
  }

  function startPlay() {
    const yearStep = state.step === 'year';
    if (state.month >= D.M - 1) state.month = yearStep ? yearEndMonth(0) : 0;
    $('jd-play').textContent = '❚❚';
    $('jd-play').setAttribute('aria-label', 'Pause');
    scheduleUpdate();
    playTimer = setInterval(() => {
      advance();
      scheduleUpdate();
      if (state.month >= D.M - 1) stopPlay();
    }, yearStep ? 900 : 400);
  }
  function stopPlay() {
    if (playTimer != null) clearInterval(playTimer);
    playTimer = null;
    $('jd-play').textContent = '▶';
    $('jd-play').setAttribute('aria-label', 'Play');
    scheduleUpdate(true);
  }

  function buildMethods() {
    const m = D.meta;
    const g = m.geo_src_counts;
    const items = [
      `Scope: ${fmtInt(m.n_total)} residential permits issued from January 2024 to ${m.as_of}, in RS-zoned lots, adding a backyard house, or two to eight homes. Excavation permits are excluded.`,
      `Location: ${fmtInt(g.permit)} permits are plotted at their own coordinates and ${fmtInt(g.address)} are matched by address to the City's property roll (${m.property_snapshot} snapshot). Those sit at the centre of the parcel, so they can be tens of metres off. ${fmtInt(m.n_total - m.n_mapped)} could not be located.`,
      'Neighbourhood totals and every number in the stat strip use all permits, including the ones with no location.',
      'Frequent bus: ETS Frequent Network routes 1 to 9, at stops with scheduled service every 15 minutes or better between 6 am and 9 pm (City of Edmonton transit feed, 2023-11-09 service day). The line is drawn only where it serves those stops, and the 400 m distance is straight-line from each stop.',
      'LRT: existing lines are from the City of Edmonton transit feed. Lines under construction are drawn from OpenStreetMap as mapped, so they are approximate and may differ from the final route. The 400 m and 800 m distances are straight-line from every stop, existing and planned.',
      '% of RS lots redeveloped is permits divided by RS-zoned properties in the neighbourhood. A lot with more than one permit is counted more than once.',
      'Shading and population growth compare the 2021 census with the 1971 census. The 1971 counts only cover established neighbourhoods, so newer ones are grey on the map and show n/a. Very large increases (over 200%) are mostly areas that were farmland or barely built in 1971, so the percentage is large even when the change is modest in absolute terms.',
      `Occupancy granted means the City has recorded an occupancy date for the permit, so the building is complete. That is ${fmtInt(m.n_occ)} of ${fmtInt(m.n_total)} permits (${Math.round((100 * m.n_occ) / m.n_total)}%). The median gap from permit to occupancy is about ${Math.round(m.occ_median_lag_days / 30.4)} months, so recent permits rarely have it yet and the filter understates the newest activity. ${m.occ_before_issue} permits record an occupancy date before their issue date (likely re-issued permits); they count as granted. The time slider still runs on the permit issue date.`,
      `Data as of ${m.as_of}; map built ${m.built}.`,
    ];
    $('jd-method').replaceChildren(...items.map((t) => el('li', { text: t })));
  }

  // ---- theme -------------------------------------------------------------------
  let lastDark = null;
  function applyTheme() {
    if (lastDark === isDark()) return;
    const firstRun = lastDark === null;
    lastDark = isDark();
    const p = pal();
    $('jd-app').style.setProperty('--jd-lrt-ink', p.lrt);
    $('jd-app').style.setProperty('--jd-bus-ink', p.bus);
    p.types.forEach((c, i) => document.querySelectorAll(`[data-swatch="${i}"]`).forEach((s) => (s.style.background = c)));
    const ramp = $('jd-legend-ramp');
    const colours = [...p.div, p.nodata];
    const labels = [...POP_LABELS, 'No 1971 count'];
    ramp.replaceChildren(...labels.map((l, i) => el('span', {}, el('i', { style: `background:${colours[i]}` }), document.createTextNode(l))));
    if (map && !firstRun) {
      styleReady = false;
      map.setStyle(styleUrl(), { diff: false });
    }
  }
  const styleUrl = () => STYLES[isDark() ? 'dark' : 'light'][usedFallback ? 1 : 0];

  // ---- map control buttons -----------------------------------------------------
  class ButtonsControl {
    onAdd() {
      this.el = el('div', { class: 'maplibregl-ctrl maplibregl-ctrl-group' },
        el('button', { type: 'button', class: 'jd-ctrl-btn', title: 'About this map', 'aria-label': 'About this map', text: 'i', onclick: () => $('jd-about').showModal() }),
        el('button', { type: 'button', class: 'jd-ctrl-btn', title: 'View as table', 'aria-label': 'View all neighbourhoods as a table', text: '☰', onclick: () => { state.tab = 'table'; applyView(); } }),
      );
      return this.el;
    }
    onRemove() { this.el.remove(); }
  }

  const defaultView = () => ({
    center: [-113.49, 53.54],
    zoom: window.matchMedia('(max-width: 820px)').matches ? 9.6 : 10.4,
  });

  // ---- boot --------------------------------------------------------------------
  async function init() {
    if (typeof maplibregl === 'undefined') throw new Error('The map library failed to load. Check your connection and reload.');
    const [permits, facts, nbhd, stops, lines, buffers, bStops, bLines, bBuffers] = await Promise.all([
      loadJSON('permits.json'), loadJSON('neighbourhood-facts.json'), loadJSON('neighbourhoods.geojson'),
      loadJSON('lrt.geojson'), loadJSON('lrt-lines.geojson'), loadJSON('lrt-buffers.geojson'),
      loadJSON('fbus-stops.geojson'), loadJSON('fbus-lines.geojson'), loadJSON('fbus-buffers.geojson'),
    ]);
    D = derive(permits, facts, nbhd, { stops, lines, buffers }, { stops: bStops, lines: bLines, buffers: bBuffers });
    state.month = D.M - 1;
    const fromHash = readHash();
    Object.assign(state, fromHash);
    if (state.step === 'year') state.month = snapToYearEnd(state.month);

    const view = fromHash.view || defaultView();
    map = new maplibregl.Map({
      container: 'jd-map',
      style: styleUrl(),
      center: view.center,
      zoom: view.zoom,
      minZoom: 8,
      maxZoom: 18,
      maxBounds: [[-114.3, 53.15], [-112.7, 53.95]],
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Permits: City of Edmonton Open Data' }));
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new ButtonsControl(), 'top-right');
    map.getCanvas().setAttribute('aria-label', 'Map. Use arrow keys to pan and plus or minus to zoom.');

    buildControls();
    buildLineKey();
    syncControls();
    applyView();
    applyTheme();

    map.on('style.load', () => {
      styleReady = true;
      addOverlay();
      scheduleUpdate();
    });
    map.on('error', () => {
      if (!styleReady && !usedFallback) {
        usedFallback = true;
        map.setStyle(styleUrl(), { diff: false });
      }
    });

    map.on('mousemove', (e) => {
      if (!map.getLayer('jd-permits')) return;
      const r = 4;
      const overPermit = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ['jd-permits'] }).length > 0;
      const nbHit = map.queryRenderedFeatures(e.point, { layers: ['jd-nbhd-fill'] })[0];
      map.getCanvas().style.cursor = overPermit || nbHit ? 'pointer' : '';
      if (canHover) setHover(nbHit ? nbHit.id : null);
    });
    map.on('mouseout', () => canHover && setHover(null));
    map.on('click', (e) => {
      if (permitPopup(e)) return;
      const nbHit = map.queryRenderedFeatures(e.point, { layers: ['jd-nbhd-fill'] })[0];
      if (!nbHit) return setSelected(null);
      setSelected(state.sel === nbHit.id ? null : nbHit.id);
    });
    map.on('moveend', writeHash);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || $('jd-about').open) return;
      if (state.tab === 'map' && state.sel != null) setSelected(null);
    });

    new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    const header = $('quarto-header');
    const setNavH = () => {
      $('jd-app').style.setProperty('--jd-nav-h', `${header ? header.offsetHeight : 56}px`);
      map.resize();
    };
    setNavH();
    if (header && 'ResizeObserver' in window) new ResizeObserver(setNavH).observe(header);

    try {
      if (!localStorage.getItem('jd-infill-about-seen')) {
        localStorage.setItem('jd-infill-about-seen', '1');
        $('jd-about').showModal();
      }
    } catch (_) {
      /* storage blocked: skip the first-visit dialog */
    }
  }

  init().catch((err) => {
    console.error(err);
    showError(`Map data failed to load. ${err.message}`);
  });
})();
