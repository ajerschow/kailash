(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";

  let DATA = null;
  let map = null;
  let mapBounds = null;
  let cursorMarker = null;
  let highlightLine = null;
  let chartEl = null;
  let chartDims = null; // {w,h,padL,padR,padT,padB}
  let distArr = [];

  initChartToggle();
  init();

  // ---------- collapsible elevation profile ----------

  function initChartToggle() {
    const btn = document.getElementById("chart-toggle-btn");
    const profilePanelEl = document.getElementById("profile-panel");
    let expanded = false;
    btn.addEventListener("click", () => {
      expanded = !expanded;
      profilePanelEl.classList.toggle("collapsible-hidden", !expanded);
      btn.setAttribute("aria-expanded", String(expanded));
    });
  }

  async function init() {
    // Loaded from data/kora-data.js (a plain <script> assigning
    // window.KORA_DATA) rather than fetch()'d, so the page also works when
    // opened directly as a file:// URL, where fetch() of local files is
    // blocked by browsers.
    DATA = window.KORA_DATA;
    distArr = DATA.trail.map(p => p.dist);

    buildStatsBar();
    buildMap();
    window.__koraApp = { moveCursorToDist, resetView };
    document.dispatchEvent(new CustomEvent("kora-data-ready", { detail: DATA }));

    // Chart layout depends on the panel's real flexbox-resolved size, which
    // isn't available on the first synchronous layout pass — redraw whenever
    // it actually changes (covers first paint, breakpoint switches, and
    // window resizes alike).
    const debouncedBuildChart = debounce(buildChart, 100);
    const chartEl0 = document.getElementById("elevation-chart");
    let lastW = 0, lastH = 0;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (Math.abs(width - lastW) < 1 && Math.abs(height - lastH) < 1) return;
      lastW = width; lastH = height;
      debouncedBuildChart();
    });
    ro.observe(chartEl0);
  }

  // ---------- stats bar ----------

  function buildStatsBar() {
    const s = DATA.stats;
    const bar = document.getElementById("stats-bar");
    const items = [
      ["Distance", `${s.total_distance_km} km`],
      ["Ascent", `+${s.total_ascent_m} m`],
      ["Descent", `−${s.total_descent_m} m`],
      ["High — Dolma La", `${Math.round(s.max_ele_m)} m`],
      ["Low — Darchen", `${Math.round(s.min_ele_m)} m`],
    ];
    bar.innerHTML = items.map(([lab, val]) =>
      `<div class="stat"><span class="val">${val}</span><span class="lab">${lab}</span></div>`
    ).join("");
  }

  // ---------- map ----------

  function buildMap() {
    const trail = DATA.trail;
    const latlngs = trail.map(p => [p.lat, p.lon]);
    // close the loop visually
    latlngs.push(latlngs[0]);

    // Zoom control moves to bottom-left so the top-left corner stays clear
    // for the menu button (top-right is already taken by the layer switcher
    // below, and by MapLibre's nav control when in 3D/walk mode).
    map = L.map("map", { scrollWheelZoom: true, zoomControl: false });
    L.control.zoom({ position: "bottomleft" }).addTo(map);

    const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
    });
    const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 17,
      attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics"
    });

    topo.addTo(map);
    L.control.layers({ "Topographic": topo, "Satellite": satellite }, {}, { position: "topright" }).addTo(map);

    mapBounds = L.latLngBounds(latlngs);

    // The map container can report zero width on first layout pass (flexbox
    // timing), which makes fitBounds pick a bogus zoom. Retry once the
    // container actually has real dimensions.
    let fitted = false;
    function tryFit() {
      const size = map.getSize();
      if (fitted || size.x === 0 || size.y === 0) return;
      fitted = true;
      map.invalidateSize();
      map.fitBounds(mapBounds, { padding: [24, 24] });
      ro.disconnect();
    }
    const ro = new ResizeObserver(tryFit);
    ro.observe(document.getElementById("map"));
    map.fitBounds(mapBounds, { padding: [24, 24] });
    tryFit();

    // elevation-graded polyline: draw as many short segments colored by elevation
    const eles = trail.map(p => p.ele);
    const minE = Math.min(...eles), maxE = Math.max(...eles);
    for (let i = 0; i < trail.length - 1; i++) {
      const a = trail[i], b = trail[i + 1];
      const mid = (a.ele + b.ele) / 2;
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
        color: elevationColor((mid - minE) / (maxE - minE)),
        weight: 4,
        opacity: 0.9,
        lineCap: "round"
      }).addTo(map);
    }
    // closing segment back to Darchen
    const last = trail[trail.length - 1], first = trail[0];
    L.polyline([[last.lat, last.lon], [first.lat, first.lon]], {
      color: "#9db0c0", weight: 3, opacity: 0.6, dashArray: "4,6"
    }).addTo(map);

    // waypoint markers
    DATA.waypoints.forEach(wp => {
      const icon = L.divIcon({
        className: "",
        html: `<div class="wp-icon">${wpEmoji(wp.name)}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      const marker = L.marker([wp.lat, wp.lon], { icon }).addTo(map);
      const distTxt = wp.trail_dist_km != null ? `${wp.trail_dist_km} km along route` : `${(wp.offset_from_trail_m/1000).toFixed(1)} km off route`;
      marker.bindPopup(
        `<h3>${wp.name}</h3><p>${wp.desc}</p><span class="ele-badge">${Math.round(wp.trail_ele)} m &middot; ${distTxt}</span>`
      );
      marker.on("click", () => {
        if (wp.trail_dist_km != null) moveCursorToDist(wp.trail_dist_km, true);
      });
    });

    // cursor marker (hover position)
    cursorMarker = L.marker(latlngs[0], {
      icon: L.divIcon({ className: "", html: '<div class="cursor-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
      interactive: false
    }).addTo(map);
  }

  function resetView() {
    if (map && mapBounds) map.fitBounds(mapBounds, { padding: [24, 24] });
  }

  function wpEmoji(name) {
    if (/summit/i.test(name)) return "⛰";
    if (/darchen/i.test(name)) return "⌂";
    if (/gompa/i.test(name)) return "☯";
    if (/la$|pass/i.test(name)) return "▲";
    return "●";
  }

  function elevationColor(t) {
    // t in [0,1], low -> green, mid -> amber, high -> red
    t = Math.max(0, Math.min(1, t));
    const stops = [
      [0.0, [79, 157, 110]],
      [0.5, [232, 163, 61]],
      [1.0, [200, 90, 76]]
    ];
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
    }
    const span = b[0] - a[0] || 1;
    const localT = (t - a[0]) / span;
    const rgb = a[1].map((c, i) => Math.round(c + (b[1][i] - c) * localT));
    return `rgb(${rgb.join(",")})`;
  }

  // ---------- elevation chart ----------

  function buildChart() {
    chartEl = document.getElementById("elevation-chart");
    const rect = chartEl.getBoundingClientRect();
    const w = Math.max(200, rect.width);
    const h = Math.max(120, rect.height);
    const padL = 46, padR = 14, padT = 34, padB = 26;
    chartDims = { w, h, padL, padR, padT, padB };

    chartEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
    chartEl.innerHTML = "";

    const trail = DATA.trail;
    const totalDist = DATA.stats.total_distance_km;
    const eMin = Math.floor((DATA.stats.min_ele_m - 40) / 50) * 50;
    const eMax = Math.ceil((DATA.stats.max_ele_m + 40) / 50) * 50;

    const xScale = d => padL + (d / totalDist) * (w - padL - padR);
    const yScale = e => padT + (1 - (e - eMin) / (eMax - eMin)) * (h - padT - padB);
    chartDims.xScale = xScale;
    chartDims.yScale = yScale;
    chartDims.eMin = eMin;
    chartDims.eMax = eMax;

    // gridlines + y labels (elevation)
    const eStep = niceStep(eMax - eMin, 4);
    for (let e = Math.ceil(eMin / eStep) * eStep; e <= eMax; e += eStep) {
      const y = yScale(e);
      addLine(chartEl, padL, y, w - padR, y, "gridline");
      addText(chartEl, padL - 8, y + 3, `${e}`, "axis-label y-label");
    }

    // x labels (distance)
    const dStep = niceStep(totalDist, 6);
    for (let d = 0; d <= totalDist; d += dStep) {
      const x = xScale(d);
      addText(chartEl, x, h - padB + 16, `${Math.round(d)}`, "axis-label x-label");
    }
    addText(chartEl, w - padR, h - 4, "km", "axis-label x-unit");

    // filled area
    let areaPath = `M ${xScale(trail[0].dist)} ${yScale(trail[0].ele)} `;
    trail.forEach(p => { areaPath += `L ${xScale(p.dist)} ${yScale(p.ele)} `; });
    areaPath += `L ${xScale(trail[trail.length - 1].dist)} ${yScale(eMin)} L ${xScale(trail[0].dist)} ${yScale(eMin)} Z`;

    const defs = document.createElementNS(SVG_NS, "defs");
    defs.innerHTML = `<linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.03"/>
    </linearGradient>`;
    chartEl.appendChild(defs);

    const area = document.createElementNS(SVG_NS, "path");
    area.setAttribute("d", areaPath);
    area.setAttribute("fill", "url(#fillGrad)");
    area.setAttribute("stroke", "none");
    chartEl.appendChild(area);

    let linePath = `M ${xScale(trail[0].dist)} ${yScale(trail[0].ele)} `;
    trail.forEach(p => { linePath += `L ${xScale(p.dist)} ${yScale(p.ele)} `; });
    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("d", linePath);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "var(--accent)");
    line.setAttribute("stroke-width", "2");
    chartEl.appendChild(line);

    // waypoint markers on chart — stagger labels across two rows (by
    // sequence along the route) so adjacent stops don't overlap
    const onRoute = DATA.waypoints
      .filter(wp => wp.trail_dist_km != null)
      .sort((a, b) => a.trail_dist_km - b.trail_dist_km);
    onRoute.forEach((wp, i) => {
      const x = xScale(wp.trail_dist_km);
      const y = yScale(wp.trail_ele);
      addLine(chartEl, x, padT, x, h - padB, "wp-gridline");
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", 4);
      dot.setAttribute("fill", "var(--accent-2)");
      dot.setAttribute("stroke", "var(--panel)");
      dot.setAttribute("stroke-width", "1.5");
      chartEl.appendChild(dot);
      const labelY = i % 2 === 0 ? 10 : 22;
      addText(chartEl, x, labelY, wp.name, "wp-label", x > w * 0.85 ? "end" : (x < w * 0.15 ? "start" : "middle"));
    });

    // crosshair group (hidden until hover)
    highlightLine = document.createElementNS(SVG_NS, "g");
    highlightLine.setAttribute("class", "crosshair");
    highlightLine.style.display = "none";
    const chLine = document.createElementNS(SVG_NS, "line");
    chLine.setAttribute("y1", padT); chLine.setAttribute("y2", h - padB);
    chLine.setAttribute("stroke", "var(--text-dim)");
    chLine.setAttribute("stroke-width", "1");
    chLine.setAttribute("stroke-dasharray", "3,3");
    const chDot = document.createElementNS(SVG_NS, "circle");
    chDot.setAttribute("r", 5);
    chDot.setAttribute("fill", "var(--accent-2)");
    chDot.setAttribute("stroke", "#fff");
    chDot.setAttribute("stroke-width", "1.5");
    highlightLine.appendChild(chLine);
    highlightLine.appendChild(chDot);
    chartEl.appendChild(highlightLine);
    highlightLine._line = chLine;
    highlightLine._dot = chDot;

    // hit area for pointer events
    const hit = document.createElementNS(SVG_NS, "rect");
    hit.setAttribute("x", padL); hit.setAttribute("y", padT);
    hit.setAttribute("width", w - padL - padR); hit.setAttribute("height", h - padT - padB);
    hit.setAttribute("fill", "transparent");
    hit.addEventListener("pointermove", onChartHover);
    hit.addEventListener("mousemove", onChartHover);
    hit.addEventListener("pointerleave", onChartLeave);
    hit.addEventListener("mouseleave", onChartLeave);
    hit.addEventListener("pointerdown", onChartHover);
    hit.addEventListener("mousedown", onChartHover);
    chartEl.appendChild(hit);

    injectChartCss();
  }

  function injectChartCss() {
    if (document.getElementById("chart-inline-style")) return;
    const style = document.createElement("style");
    style.id = "chart-inline-style";
    style.textContent = `
      .gridline { stroke: var(--border); stroke-width: 1; }
      .wp-gridline { stroke: var(--accent-2); stroke-width: 1; stroke-dasharray: 2,3; opacity: 0.6; }
      .axis-label { fill: var(--text-dim); font-size: 10px; font-family: var(--font); }
      .y-label { text-anchor: end; }
      .x-label { text-anchor: middle; }
      .x-unit { text-anchor: end; font-style: italic; }
      .wp-label { fill: var(--text); font-size: 10px; font-weight: 600; font-family: var(--font); }
    `;
    document.head.appendChild(style);
  }

  function addLine(svg, x1, y1, x2, y2, cls) {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1);
    l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("class", cls);
    svg.appendChild(l);
    return l;
  }
  function addText(svg, x, y, txt, cls, anchor) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", x); t.setAttribute("y", y);
    t.setAttribute("class", cls);
    if (anchor) t.setAttribute("text-anchor", anchor);
    t.textContent = txt;
    svg.appendChild(t);
    return t;
  }

  function niceStep(range, targetTicks) {
    const raw = range / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm < 1.5) step = 1;
    else if (norm < 3) step = 2;
    else if (norm < 7) step = 5;
    else step = 10;
    return step * mag;
  }

  // ---------- interaction ----------

  function onChartHover(evt) {
    const rect = chartEl.getBoundingClientRect();
    const scaleX = chartDims.w / rect.width;
    const px = (evt.clientX - rect.left) * scaleX;
    const { padL, w, padR } = chartDims;
    const clamped = Math.max(padL, Math.min(w - padR, px));
    const frac = (clamped - padL) / (w - padL - padR);
    const dist = frac * DATA.stats.total_distance_km;
    moveCursorToDist(dist, false);
  }

  function onChartLeave() {
    highlightLine.style.display = "none";
  }

  function moveCursorToDist(dist, panMap) {
    const idx = nearestIndexByDist(dist);
    const p = DATA.trail[idx];

    // The elevation panel starts collapsed, so the chart (and its
    // crosshair) may not have been built yet — only touch it once it has.
    if (chartDims && highlightLine) {
      const x = chartDims.xScale(p.dist);
      const y = chartDims.yScale(p.ele);
      highlightLine.style.display = "";
      highlightLine._line.setAttribute("x1", x);
      highlightLine._line.setAttribute("x2", x);
      highlightLine._dot.setAttribute("cx", x);
      highlightLine._dot.setAttribute("cy", y);
    }

    cursorMarker.setLatLng([p.lat, p.lon]);
    if (panMap) map.panTo([p.lat, p.lon]);
    if (window.__kora3d) window.__kora3d.setCursor(p);

    const grade = instantGrade(idx);
    document.getElementById("readout-dist").textContent = `${p.dist.toFixed(2)} km`;
    document.getElementById("readout-ele").textContent = `${Math.round(p.ele)} m`;
    document.getElementById("readout-grade").textContent = `${grade >= 0 ? "+" : ""}${grade.toFixed(1)}%`;
  }

  function instantGrade(idx) {
    const trail = DATA.trail;
    const lo = Math.max(0, idx - 3);
    const hi = Math.min(trail.length - 1, idx + 3);
    const a = trail[lo], b = trail[hi];
    const dElev = b.ele - a.ele;
    const dDist = (b.dist - a.dist) * 1000; // m
    if (dDist === 0) return 0;
    return (dElev / dDist) * 100;
  }

  function nearestIndexByDist(dist) {
    // binary search distArr (sorted ascending)
    let lo = 0, hi = distArr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (distArr[mid] < dist) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
})();
