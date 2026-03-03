const API_BASE = "https://gpstracking.kirkjlemon.workers.dev";

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

/* remainder of file unchanged */

initMap();
setStatus("Idle");

(async () => {
  try {
    const idb = await openIdb();
    const s = await idbGet(idb, "state", "auth");
    if (s?.email) emailEl.value = s.email;
  } catch {}
})();
