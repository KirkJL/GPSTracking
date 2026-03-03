const API_BASE = "https://YOUR-WORKER-URL.workers.dev";
const TILE_URL = "https://{a,b,c}.tile.openstreetmap.org/{z}/{x}/{y}.png";
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
          tiles: [TILE_URL],
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
  map.getSource("route").setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords } });
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

async function openIdb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("waytrace", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("keys", { keyPath: "id" });
      db.createObjectStore("state", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(db, store, key){
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const req = st.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(db, store, value){
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const st = tx.objectStore(store);
    const req = st.put(value);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

function b64url(bytes){
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

async function getOrCreateDeviceKeys(){
  const idb = await openIdb();
  const existing = await idbGet(idb, "keys", "device");
  if (existing?.jwkPriv && existing?.jwkPub) {
    const priv = await crypto.subtle.importKey("jwk", existing.jwkPriv, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const pub = await crypto.subtle.importKey("jwk", existing.jwkPub, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    return { privateKey: priv, publicKey: pub };
  }

  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwkPriv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const jwkPub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  await idbPut(idb, "keys", { id: "device", jwkPriv, jwkPub });
  return kp;
}

async function signChallenge(challengeStr){
  const enc = new TextEncoder();
  const data = enc.encode(challengeStr);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, deviceKeyPair.privateKey, data);
  return b64url(new Uint8Array(sig));
}

async function loginOrRegister(){
  const email = (emailEl.value || "").trim().toLowerCase();
  if (!email) { alert("Enter an email."); return; }

  deviceKeyPair = await getOrCreateDeviceKeys();
  const pubJwk = await crypto.subtle.exportKey("jwk", deviceKeyPair.publicKey);

  setStatus("Auth: challenge…");
  const ch = await api("/api/auth/challenge", { method: "POST", body: JSON.stringify({ email, pubJwk }) });

  const signature = await signChallenge(ch.challenge);

  setStatus("Auth: verify…");
  const v = await api("/api/auth/verify", { method: "POST", body: JSON.stringify({ email, signature }) });

  jwt = v.jwt;

  btnLogout.disabled = false;
  btnStart.disabled = false;
  btnCreateGroup.disabled = false;
  btnJoinGroup.disabled = false;

  setStatus("Authed");

  const idb = await openIdb();
  await idbPut(idb, "state", { id: "auth", email });
}

async function logout(){
  jwt = null;
  sessionId = null;
  groupId = null;

  btnLogout.disabled = true;
  btnStart.disabled = true;
  btnStop.disabled = true;
  btnStopHere.disabled = true;
  btnCreateGroup.disabled = true;
  btnJoinGroup.disabled = true;

  btnExportJson.disabled = true;
  btnExportGpx.disabled = true;

  journeyStatsEl.textContent = "No journey yet.";
  setStatus("Logged out");

  const idb = await openIdb();
  await idbPut(idb, "state", { id: "auth", email: "" });
}

async function startSession(){
  if (!geoSupported()) { alert("Geolocation not supported."); return; }
  if (!jwt) { alert("Login first."); return; }

  points = [];
  stops = [];
  latestPoint = null;
  updateRouteOnMap();

  btnExportJson.disabled = true;
  btnExportGpx.disabled = true;
  journeyStatsEl.textContent = "Tracking…";

  const resp = await api("/api/sessions/start", { method: "POST", body: JSON.stringify({ groupId }) });
  sessionId = resp.sessionId;

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

  if (sessionId) {
    try { await flushPoints(true); } catch {}
    await api("/api/sessions/stop", { method: "POST", body: JSON.stringify({ sessionId }) });

    lastSessionId = sessionId;
    sessionId = null;

    await loadJourneyStats(lastSessionId);

    btnExportJson.disabled = false;
    btnExportGpx.disabled = false;

    setStatus("Stopped");
  } else {
    setStatus("Stopped");
  }
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

  if (p.acc && p.acc > 80) return;

  if (points.length > 0) {
    const last = points[points.length - 1];
    const d = haversineMeters({ lat: last.lat, lng: last.lng }, { lat: p.lat, lng: p.lng });
    if (d < 4) return;
  }

  latestPoint = p;
  points.push(p);
  updateRouteOnMap();

  trackInfoEl.textContent = `Points: ${points.length} | Acc: ${Math.round(p.acc)}m`;
  if (points.length === 1) centerMap();

  void flushPoints(false);
}

async function flushPoints(force){
  if (!sessionId || points.length === 0) return;

  const intervalSec = parseInt(sendIntervalEl.value, 10) || 8;
  const minGap = intervalSec * 1000;
  const t = nowMs();
  if (!force && (t - lastSendAt) < minGap) return;

  lastSendAt = t;

  const batch = points.slice(-25);
  await api("/api/points/batch", { method: "POST", body: JSON.stringify({ sessionId, points: batch }) });
}

async function addStopHere(){
  if (!sessionId || !latestPoint) return;

  const stop = { lat: latestPoint.lat, lng: latestPoint.lng, t: latestPoint.t, label: `Stop ${stops.length + 1}` };
  stops.push(stop);

  new maplibregl.Marker({ color: "#ff4d4d" })
    .setLngLat([stop.lng, stop.lat])
    .setPopup(new maplibregl.Popup().setText(stop.label))
    .addTo(map);

  await api("/api/stops/add", { method: "POST", body: JSON.stringify({ sessionId, stop }) });
}

async function createGroup(){
  const resp = await api("/api/groups/create", { method: "POST", body: JSON.stringify({}) });
  groupId = resp.groupId;
  groupCodeEl.value = resp.code;
  groupInfoEl.textContent = `Group: ${resp.code}`;
}

async function joinGroup(){
  const code = (groupCodeEl.value || "").trim().toUpperCase();
  if (!code) { alert("Enter a group code."); return; }
  const resp = await api("/api/groups/join", { method: "POST", body: JSON.stringify({ code }) });
  groupId = resp.groupId;
  groupInfoEl.textContent = `Joined group: ${code}`;
}

function fmtMeters(m){
  if (!Number.isFinite(m)) return "0 m";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m/1000).toFixed(2)} km`;
}

function fmtDuration(sec){
  sec = Math.max(0, sec|0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtSpeedMps(mps){
  if (!Number.isFinite(mps)) return "0.0 km/h";
  const kmh = mps * 3.6;
  return `${kmh.toFixed(1)} km/h`;
}

async function loadJourneyStats(id){
  try {
    const data = await api(`/api/sessions/${id}?format=json`, { method: "GET" });
    const s = data.session;

    journeyStatsEl.textContent =
      `Distance: ${fmtMeters(s.total_distance_m || 0)} | ` +
      `Duration: ${fmtDuration(s.duration_seconds || 0)} | ` +
      `Avg: ${fmtSpeedMps(s.avg_speed_mps || 0)} | ` +
      `Max: ${fmtSpeedMps(s.max_speed_mps || 0)} | ` +
      `Points: ${s.point_count || 0}`;

  } catch (e) {
    journeyStatsEl.textContent = `Could not load stats: ${e.message}`;
  }
}

async function exportSession(format){
  if (!lastSessionId) { alert("No session to export yet."); return; }

  const url = `${API_BASE}/api/sessions/${lastSessionId}?format=${encodeURIComponent(format)}`;

  const res = await fetch(url, { headers: { ...authHeaders() } });
  if (!res.ok) {
    const t = await res.text();
    alert(`Export failed: ${t}`);
    return;
  }

  const blob = await res.blob();
  const a = document.createElement("a");
  const ext = format === "gpx" ? "gpx" : "json";
  a.href = URL.createObjectURL(blob);
  a.download = `journey-${lastSessionId}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

btnLogin.addEventListener("click", () => loginOrRegister().catch(e => alert(e.message)));
btnLogout.addEventListener("click", () => logout().catch(() => {}));
btnStart.addEventListener("click", () => startSession().catch(e => alert(e.message)));
btnStop.addEventListener("click", () => stopSession().catch(e => alert(e.message)));
btnStopHere.addEventListener("click", () => addStopHere().catch(e => alert(e.message)));
btnCenter.addEventListener("click", centerMap);
btnCreateGroup.addEventListener("click", () => createGroup().catch(e => alert(e.message)));
btnJoinGroup.addEventListener("click", () => joinGroup().catch(e => alert(e.message)));
btnExportJson.addEventListener("click", () => exportSession("json").catch(e => alert(e.message)));
btnExportGpx.addEventListener("click", () => exportSession("gpx").catch(e => alert(e.message)));

initMap();
setStatus("Idle");

(async () => {
  try {
    const idb = await openIdb();
    const s = await idbGet(idb, "state", "auth");
    if (s?.email) emailEl.value = s.email;
  } catch {}
})();
