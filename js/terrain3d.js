(() => {
  let DATA = null;
  let distArr = [];
  let map3d = null;
  let navControl = null;
  let initialized = false;
  let mapReady = false;
  let pendingWalkEnter = false;
  let currentExaggeration = 1;
  let savedExaggeration = 1;
  let currentView = "2d";
  const CURSOR_SRC = "kora-cursor";
  const LOOKAHEAD_KM = 0.1;
  const FULL_LOOP_SECONDS = 120;
  // View-angle slider (0-100) interpolates between these two, both verified
  // to render cleanly everywhere on the loop, including the steep switchbacks
  // at Dolma La — MapLibre has no minimum-altitude camera API, so pushing
  // past the "ground-level" end starts clipping through terrain.
  const WALK_ZOOM_MIN = 12, WALK_ZOOM_MAX = 15;
  const WALK_PITCH_MIN = 55, WALK_PITCH_MAX = 82;
  const WALK_ANGLE_DEFAULT = 55;

  function setData(d) {
    DATA = d;
    distArr = DATA.trail.map(p => p.dist);
  }
  // app.js dispatches this synchronously now that data loads from an inline
  // <script> instead of fetch(), so it can fire before this script (loaded
  // after app.js) has even registered a listener — check for data that's
  // already there first, and only fall back to the event if it isn't yet.
  if (window.KORA_DATA) setData(window.KORA_DATA);
  else document.addEventListener("kora-data-ready", (e) => setData(e.detail));

  const wrap = document.getElementById("map-wrap");
  const toggle = document.getElementById("view-toggle");
  const exagCtrl = document.getElementById("exaggeration-control");
  const exagSlider = document.getElementById("exaggeration-slider");
  const exagVal = document.getElementById("exaggeration-val");
  const walkCtrl = document.getElementById("walk-control");
  const walkSlider = document.getElementById("walk-slider");
  const walkPlayBtn = document.getElementById("walk-play-btn");
  const walkStepBackBtn = document.getElementById("walk-step-back-btn");
  const walkStepFwdBtn = document.getElementById("walk-step-fwd-btn");
  const walkSpeedSel = document.getElementById("walk-speed");
  const walkDistLabel = document.getElementById("walk-dist-label");
  const walkPlaceLabel = document.getElementById("walk-place-label");
  const walkAngleSlider = document.getElementById("walk-angle-slider");
  const resetViewBtn = document.getElementById("reset-view-btn");

  toggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".view-btn");
    if (!btn) return;
    const view = btn.dataset.view;
    if (view === currentView) return;
    toggle.querySelectorAll(".view-btn").forEach(b => b.classList.toggle("active", b === btn));

    if (currentView === "walk") exitWalkMode();

    if (view === "2d") {
      wrap.classList.remove("mode-3d", "mode-walk");
      exagCtrl.hidden = true;
      walkCtrl.hidden = true;
    } else {
      wrap.classList.add("mode-3d");
      if (!initialized) initMap3D();
      else map3d.resize();

      if (view === "3d") {
        wrap.classList.remove("mode-walk");
        exagCtrl.hidden = false;
        walkCtrl.hidden = true;
      } else if (view === "walk") {
        wrap.classList.add("mode-walk");
        exagCtrl.hidden = true;
        walkCtrl.hidden = false;
        enterWalkMode();
      }
    }
    currentView = view;
  });

  resetViewBtn.addEventListener("click", () => {
    if (currentView === "2d") {
      if (window.__koraApp) window.__koraApp.resetView();
    } else if (currentView === "3d") {
      currentExaggeration = 1;
      exagSlider.value = 1;
      exagVal.textContent = "1.0×";
      if (map3d && map3d.getTerrain()) map3d.setTerrain({ source: "terrain-dem", exaggeration: 1 });
      if (map3d) fitToTrail();
    } else if (currentView === "walk") {
      stopWalk();
      walkSlider.value = 0;
      walkAngleSlider.value = WALK_ANGLE_DEFAULT;
      updateWalkCamera(0);
    }
  });

  exagSlider.addEventListener("input", () => {
    currentExaggeration = parseFloat(exagSlider.value);
    exagVal.textContent = `${currentExaggeration.toFixed(1)}×`;
    if (map3d && map3d.getTerrain()) {
      map3d.setTerrain({ source: "terrain-dem", exaggeration: currentExaggeration });
    }
  });

  function initMap3D() {
    initialized = true;
    if (!DATA) {
      initialized = false;
      document.addEventListener("kora-data-ready", initMap3D, { once: true });
      return;
    }

    map3d = new maplibregl.Map({
      container: "map3d",
      style: {
        version: 8,
        sources: {
          satellite: {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics"
          },
          "terrain-dem": {
            type: "raster-dem",
            tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
            tileSize: 256,
            encoding: "terrarium",
            maxzoom: 15
          }
        },
        layers: [{ id: "satellite", type: "raster", source: "satellite" }],
        terrain: { source: "terrain-dem", exaggeration: 1 },
        sky: {
          "sky-color": "#8ec8e8",
          "sky-horizon-blend": 0.5,
          "horizon-color": "#e8d9c0",
          "horizon-fog-blend": 0.5,
          "fog-color": "#cfd9e0",
          "fog-ground-blend": 0.3
        }
      },
      center: [81.312, 31.03],
      zoom: 11.3,
      pitch: 60,
      bearing: -20,
      maxPitch: 85,
      dragRotate: true,
      touchPitch: true,
      attributionControl: false
    });

    navControl = new maplibregl.NavigationControl({ visualizePitch: true });
    map3d.addControl(navControl, "top-right");
    map3d.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    map3d.on("load", () => {
      map3d.setTerrain({ source: "terrain-dem", exaggeration: currentExaggeration });
      addTrailLayer();
      addWaypointLayer();
      addCursorLayer();
      fitToTrail();
      mapReady = true;
      walkSlider.max = DATA.stats.total_distance_km.toFixed(2);
      if (pendingWalkEnter) enterWalkMode();
    });

    window.__kora3dMap = map3d;
  }

  function addTrailLayer() {
    const trail = DATA.trail;
    const eles = trail.map(p => p.ele);
    const minE = Math.min(...eles), maxE = Math.max(...eles);
    const features = [];
    for (let i = 0; i < trail.length - 1; i++) {
      const a = trail[i], b = trail[i + 1];
      const mid = (a.ele + b.ele) / 2;
      features.push({
        type: "Feature",
        properties: { color: elevationColor((mid - minE) / (maxE - minE)) },
        geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] }
      });
    }
    map3d.addSource("kora-trail", { type: "geojson", data: { type: "FeatureCollection", features } });
    map3d.addLayer({
      id: "kora-trail-line",
      type: "line",
      source: "kora-trail",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 3.5, "line-opacity": 0.95 }
    });
  }

  function addWaypointLayer() {
    const features = DATA.waypoints.map(wp => ({
      type: "Feature",
      properties: { name: wp.name, desc: wp.desc, ele: wp.trail_ele },
      geometry: { type: "Point", coordinates: [wp.lon, wp.lat] }
    }));
    map3d.addSource("kora-waypoints", { type: "geojson", data: { type: "FeatureCollection", features } });
    map3d.addLayer({
      id: "kora-waypoints-circle",
      type: "circle",
      source: "kora-waypoints",
      paint: {
        "circle-radius": 7,
        "circle-color": "#6fb8d9",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#16202c"
      }
    });

    map3d.on("click", "kora-waypoints-circle", (e) => {
      const f = e.features[0];
      const [lon, lat] = f.geometry.coordinates;
      new maplibregl.Popup({ closeButton: true })
        .setLngLat([lon, lat])
        .setHTML(
          `<h3>${f.properties.name}</h3><p>${f.properties.desc}</p><span class="ele-badge">${Math.round(f.properties.ele)} m</span>`
        )
        .addTo(map3d);
    });
    map3d.on("mouseenter", "kora-waypoints-circle", () => { map3d.getCanvas().style.cursor = "pointer"; });
    map3d.on("mouseleave", "kora-waypoints-circle", () => { map3d.getCanvas().style.cursor = ""; });
  }

  function addCursorLayer() {
    map3d.addSource(CURSOR_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map3d.addLayer({
      id: "kora-cursor-circle",
      type: "circle",
      source: CURSOR_SRC,
      paint: {
        "circle-radius": 8,
        "circle-color": "#e8a33d",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff"
      }
    });
  }

  function fitToTrail() {
    const lats = DATA.trail.map(p => p.lat), lons = DATA.trail.map(p => p.lon);
    const bounds = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
    map3d.fitBounds(bounds, { padding: 60, pitch: 60, bearing: -20, duration: 0 });
  }

  // ---------- first-person walkthrough ----------

  let walkPlaying = false;
  let walkAnimId = null;
  let lastFrameTime = null;

  function enterWalkMode() {
    if (!map3d || !mapReady) {
      pendingWalkEnter = true;
      return;
    }
    pendingWalkEnter = false;
    savedExaggeration = currentExaggeration;
    if (map3d.getTerrain()) map3d.setTerrain({ source: "terrain-dem", exaggeration: 1 });
    updateWalkCamera(parseFloat(walkSlider.value) || 0);
    // Starts paused: leave drag/rotate/zoom enabled so the user can look
    // around from that spot. They get locked out only while playback is
    // actively driving the camera (see startWalk/stopWalk).
  }

  function exitWalkMode() {
    stopWalk();
    enableInteractions();
    if (map3d && map3d.getTerrain()) {
      map3d.setTerrain({ source: "terrain-dem", exaggeration: savedExaggeration });
    }
    if (map3d) fitToTrail();
  }

  let navControlAdded = true;

  function disableInteractions() {
    map3d.dragPan.disable();
    map3d.dragRotate.disable();
    map3d.scrollZoom.disable();
    map3d.doubleClickZoom.disable();
    map3d.touchZoomRotate.disable();
    map3d.touchPitch.disable();
    map3d.keyboard.disable();
    if (navControl && navControlAdded) {
      map3d.removeControl(navControl);
      navControlAdded = false;
    }
  }

  function enableInteractions() {
    map3d.dragPan.enable();
    map3d.dragRotate.enable();
    map3d.scrollZoom.enable();
    map3d.doubleClickZoom.enable();
    map3d.touchZoomRotate.enable();
    map3d.touchPitch.enable();
    map3d.keyboard.enable();
    if (navControl && !navControlAdded) {
      map3d.addControl(navControl, "top-right");
      navControlAdded = true;
    }
  }

  walkSlider.addEventListener("input", () => {
    stopWalk();
    updateWalkCamera(parseFloat(walkSlider.value));
  });

  walkAngleSlider.addEventListener("input", () => {
    updateWalkCamera(parseFloat(walkSlider.value));
  });

  walkPlayBtn.addEventListener("click", () => {
    if (walkPlaying) stopWalk(); else startWalk();
  });

  walkStepBackBtn.addEventListener("click", () => stepWalk(-1));
  walkStepFwdBtn.addEventListener("click", () => stepWalk(1));

  function stepWalk(dir) {
    if (!mapReady || !DATA) return;
    stopWalk();
    const idx = nearestIndexByDist(parseFloat(walkSlider.value));
    const n = DATA.trail.length;
    const nextIdx = (idx + dir + n) % n;
    const dist = DATA.trail[nextIdx].dist;
    walkSlider.value = dist;
    updateWalkCamera(dist);
  }

  function startWalk() {
    if (!mapReady) return;
    walkPlaying = true;
    walkPlayBtn.textContent = "⏸";
    disableInteractions();
    lastFrameTime = null;
    walkAnimId = requestAnimationFrame(walkTick);
  }

  function stopWalk() {
    walkPlaying = false;
    walkPlayBtn.textContent = "▶";
    if (walkAnimId) cancelAnimationFrame(walkAnimId);
    walkAnimId = null;
    if (map3d && currentView === "walk") enableInteractions();
  }

  function walkTick(now) {
    if (!walkPlaying) return;
    if (lastFrameTime == null) lastFrameTime = now;
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    const total = DATA.stats.total_distance_km;
    const speed = parseFloat(walkSpeedSel.value) || 1;
    const kmPerSec = (total / FULL_LOOP_SECONDS) * speed;
    let d = parseFloat(walkSlider.value) + kmPerSec * dt;
    if (d > total) d -= total;
    walkSlider.value = d.toFixed(3);
    updateWalkCamera(d);
    walkAnimId = requestAnimationFrame(walkTick);
  }

  function updateWalkCamera(distKm) {
    const idx = nearestIndexByDist(distKm);
    const p = DATA.trail[idx];
    const total = DATA.stats.total_distance_km;
    let targetDist = p.dist + LOOKAHEAD_KM;
    if (targetDist > total) targetDist -= total;
    const t = DATA.trail[nearestIndexByDist(targetDist)];

    const bearing = bearingBetween(p.lat, p.lon, t.lat, t.lon);
    // MapLibre GL has no FreeCameraOptions (Mapbox-only API), so there's no
    // way to pin the camera to an exact eye-level altitude without it
    // clipping through steep terrain (verified: near-90 pitch + tight zoom
    // renders a blank frame around Dolma La and even occasionally on flatter
    // ground). Zoom and pitch move together along a range that stays
    // reliable everywhere on the loop; the angle slider picks a point on it.
    const angleT = parseFloat(walkAngleSlider.value) / 100;
    const zoom = WALK_ZOOM_MIN + angleT * (WALK_ZOOM_MAX - WALK_ZOOM_MIN);
    const pitch = WALK_PITCH_MIN + angleT * (WALK_PITCH_MAX - WALK_PITCH_MIN);
    map3d.jumpTo({ center: [p.lon, p.lat], zoom, pitch, bearing });

    walkDistLabel.textContent = `${p.dist.toFixed(2)} km`;
    walkPlaceLabel.textContent = nearestPlaceLabel(p.dist);

    if (window.__kora3d) window.__kora3d.setCursor(p);
    if (window.__koraApp) window.__koraApp.moveCursorToDist(p.dist, false);
  }

  function nearestPlaceLabel(distKm) {
    let best = null, bestD = Infinity;
    DATA.waypoints.forEach(wp => {
      if (wp.trail_dist_km == null) return;
      const d = Math.abs(wp.trail_dist_km - distKm);
      if (d < bestD) { bestD = d; best = wp; }
    });
    if (!best) return "";
    return bestD < 0.5 ? `At ${best.name}` : `${bestD.toFixed(1)} km from ${best.name}`;
  }

  function nearestIndexByDist(dist) {
    let lo = 0, hi = distArr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (distArr[mid] < dist) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function bearingBetween(lat1, lon1, lat2, lon2) {
    const toRad = d => (d * Math.PI) / 180;
    const toDeg = r => (r * 180) / Math.PI;
    const phi1 = toRad(lat1), phi2 = toRad(lat2), dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function elevationColor(t) {
    t = Math.max(0, Math.min(1, t));
    const stops = [[0.0, [79, 157, 110]], [0.5, [232, 163, 61]], [1.0, [200, 90, 76]]];
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
    }
    const span = b[0] - a[0] || 1;
    const localT = (t - a[0]) / span;
    const rgb = a[1].map((c, i) => Math.round(c + (b[1][i] - c) * localT));
    return `rgb(${rgb.join(",")})`;
  }

  window.__kora3d = {
    setCursor(p) {
      if (!map3d || !map3d.getSource(CURSOR_SRC)) return;
      map3d.getSource(CURSOR_SRC).setData({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [p.lon, p.lat] } }]
      });
    }
  };
})();
