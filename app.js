const API_BASE = "https://gpstracking.kirkjlemon.workers.dev";
const API_BASE = "https://YOUR-WORKER-URL.workers.dev";

const TILE_URLS = [
"https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
"https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
"https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"
];

const TILE_ATTR = "© OpenStreetMap contributors";

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const trackInfoEl = $("trackInfo");
const journeyStatsEl = $("journeyStats");
const groupInfoEl = $("groupInfo");

const emailEl = $("email");
const btnLogin = $("btnLogin");
const btnLogout = $("btnLogout");

const btnStart = $("btnStart");
const btnStop = $("btnStop");
const btnStopHere = $("btnStopHere");
const btnCenter = $("btnCenter");
const hiAcc = $("hiAcc");
const sendIntervalEl = $("sendInterval");

const btnExportJson = $("btnExportJson");
const btnExportGpx = $("btnExportGpx");

const groupCodeEl = $("groupCode");
const btnCreateGroup = $("btnCreateGroup");
const btnJoinGroup = $("btnJoinGroup");

let map;
let watchId = null;
let wakeLock = null;

let sessionId = null;
let lastSessionId = null;
let groupId = null;

let latestPoint = null;
let points = [];
let stops = [];

let jwt = null;
let deviceKeyPair = null;

let lastSendAt = 0;

function setStatus(msg){ statusEl.textContent = msg; }
function nowMs(){ return Date.now(); }

function authHeaders(){
  return jwt ? { "Authorization": `Bearer ${jwt}` } : {};
}

async function api(path, opts = {}){
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(opts.headers || {})
    }
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function initMap(){
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: TILE_URLS,
          tileSize: 256,
          attribution: TILE_ATTR
        }
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }]
    },
    center: [-0.1276, 51.5072],
    zoom: 12
  });

  map.addControl(new maplibregl.NavigationControl({ showZoom: true }), "bottom-right");

  map.on("load", () => {
    map.addSource("route", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } }
    });

    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      paint: { "line-width": 4, "line-opacity": 0.9 }
    });
  });
}

function updateRouteOnMap(){
  if (!map?.getSource("route")) return;
  const coords = points.map(p => [p.lng, p.lat]);
  map.getSource("route").setData({
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords }
  });
}

function centerMap(){
  if (!latestPoint || !map) return;
  map.easeTo({ center: [latestPoint.lng, latestPoint.lat], zoom: Math.max(map.getZoom(), 15) });
}

async function requestWakeLock(){
  try {
    if (!("wakeLock" in navigator)) return;
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
}

async function releaseWakeLock(){
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && watchId !== null) await requestWakeLock();
});

function geoSupported(){ return "geolocation" in navigator; }

function haversineMeters(a, b){
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat/2) ** 2;
  const s2 = Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * (Math.sin(dLng/2) ** 2);
  return 2 * R * Math.asin(Math.sqrt(s1 + s2));
}

async function startSession(){
  if (!geoSupported()) { alert("Geolocation not supported."); return; }

  points = [];
  stops = [];
  latestPoint = null;
  updateRouteOnMap();

  btnStart.disabled = true;
  btnStop.disabled = false;
  btnStopHere.disabled = false;

  await requestWakeLock();

  watchId = navigator.geolocation.watchPosition(
    onPosition,
    (err) => setStatus(`GPS error: ${err.message}`),
    { enableHighAccuracy: !!hiAcc.checked, maximumAge: 5000, timeout: 10000 }
  );

  setStatus("Tracking…");
}

async function stopSession(){
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;

  await releaseWakeLock();

  btnStart.disabled = false;
  btnStop.disabled = true;
  btnStopHere.disabled = true;

  setStatus("Stopped");
}

function onPosition(pos){
  const c = pos.coords;

  const p = {
    lat: c.latitude,
    lng: c.longitude,
    acc: c.accuracy,
    spd: c.speed ?? null,
    alt: c.altitude ?? null,
    t: pos.timestamp
  };

  latestPoint = p;
  points.push(p);

  updateRouteOnMap();

  trackInfoEl.textContent = `Points: ${points.length} | Acc: ${Math.round(p.acc)}m`;

  if (points.length === 1) centerMap();
}

btnStart.addEventListener("click", startSession);
btnStop.addEventListener("click", stopSession);
btnCenter.addEventListener("click", centerMap);

initMap();
setStatus("Idle");
