(() => {
  let DATA = null;
  let map3d = null;
  let initialized = false;
  let currentExaggeration = 1;
  const CURSOR_SRC = "kora-cursor";

  document.addEventListener("kora-data-ready", (e) => { DATA = e.detail; });

  const wrap = document.getElementById("map-wrap");
  const toggle = document.getElementById("view-toggle");
  const exagCtrl = document.getElementById("exaggeration-control");
  const exagSlider = document.getElementById("exaggeration-slider");
  const exagVal = document.getElementById("exaggeration-val");

  toggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".view-btn");
    if (!btn) return;
    const view = btn.dataset.view;
    toggle.querySelectorAll(".view-btn").forEach(b => b.classList.toggle("active", b === btn));

    if (view === "3d") {
      wrap.classList.add("mode-3d");
      exagCtrl.hidden = false;
      if (!initialized) initMap3D();
      else map3d.resize();
    } else {
      wrap.classList.remove("mode-3d");
      exagCtrl.hidden = true;
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

    map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map3d.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    map3d.on("load", () => {
      map3d.setTerrain({ source: "terrain-dem", exaggeration: currentExaggeration });
      addTrailLayer();
      addWaypointLayer();
      addCursorLayer();
      fitToTrail();
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
