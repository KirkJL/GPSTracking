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

const btnPay = $("btnPay");
const btnBypass = $("btnBypass");

const payModal = $("payModal");
const btnPayNow = $("btnPayNow");
const btnPayCancel = $("btnPayCancel");

const btnExportJson = $("btnExportJson");
const btnExportGpx = $("btnExportGpx");

const groupCodeEl = $("groupCode");
const btnCreateGroup = $("btnCreateGroup");
const btnJoinGroup = $("btnJoinGroup");
const stopPostcodeEl = $("stopPostcode");
const btnAddStop = $("btnAddStop");
const stopsListEl = $("stopsList");

let map;
let watchId = null;
let wakeLock = null;

let sessionId = null;
let lastSessionId = null;
let groupId = null;

let latestPoint = null;
let points = [];
let stops = [];
let stopMarkers = [];

let userMarker = null;

let jwt = null;
let deviceKeyPair = null;

let lastSendAt = 0;
let pendingStart = false;

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
      paint: { "line-width": 4, "line-opacity": 0.9, "line-color": "#4ade80" }
    });
  });
}

function updateRouteOnMap(){
  if (!map) return;
  if (!map.getSource("route")) {
    // source may not exist yet; add and return
    map.addSource("route", { type: "geojson", data: { type: "Feature", geometry:{ type:"LineString", coordinates:[] } } });
    return;
  }
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

// Enable start button if geolocation is available
if (geoSupported()) {
  btnStart.disabled = false;
} else {
  setStatus("Geolocation not supported.");
}

function isPaidForJourney(){
  return localStorage.getItem("paidForCurrentJourney") === "1";
}

function markPaidForJourney(){
  localStorage.setItem("paidForCurrentJourney", "1");
  updatePayUI();
}

function clearPaidForJourney(){
  localStorage.removeItem("paidForCurrentJourney");
  updatePayUI();
}

function updatePayUI(){
  if (isPaidForJourney()) {
    btnPay.disabled = true;
  } else {
    btnPay.disabled = false;
  }
}

function isLocalhost(){
  try{
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch(e){
    return false;
  }
}

// Show a bypass button for local testing so devs can test without paying
if (btnBypass) {
  if (isLocalhost()) {
    btnBypass.style.display = 'block';
  } else {
    btnBypass.style.display = 'none';
  }
  btnBypass.addEventListener('click', () => {
    markPaidForJourney();
    startSession();
  });
}

function showPayModal(){
  payModal.setAttribute("aria-hidden", "false");
  payModal.style.display = "block";
}

function hidePayModal(){
  payModal.setAttribute("aria-hidden", "true");
  payModal.style.display = "none";
}

async function simulatePayment(){
  setStatus("Processing payment…");
  btnPayNow.disabled = true;
  await new Promise((r) => setTimeout(r, 1400));
  markPaidForJourney();
  setStatus("Payment received — starting journey.");
  hidePayModal();
  btnPayNow.disabled = false;
  if (pendingStart) {
    pendingStart = false;
    startSession();
  }
}

btnPay?.addEventListener("click", () => {
  showPayModal();
});

btnPayNow?.addEventListener("click", () => simulatePayment());
btnPayCancel?.addEventListener("click", () => { hidePayModal(); pendingStart = false; });

updatePayUI();

// helper: render stops list in UI
function renderStops(){
  if (!stopsListEl) return;
  if (!stops.length) { stopsListEl.textContent = 'No stops added.'; return; }
  stopsListEl.innerHTML = '';
  stops.forEach((s,i) => {
    const div = document.createElement('div');
    div.className = 'stop-row';
    const meta = document.createElement('div'); meta.className = 'meta';
    const label = `${i+1}. ${s.name || s.postcode || (s.lat+','+s.lng)}`;
    let extra = '';
    if (i>0) {
      const prev = stops[i-1];
      const d = haversineMeters(prev, s) * 0.000621371; // miles
      let minSec = '';
      if (prev.t && s.t) {
        const diff = (s.t - prev.t) / 1000; // sec
        const mins = Math.round(diff/60);
        minSec = ` / ${mins}min`;
      }
      extra = ` (${d.toFixed(2)} mi${minSec})`;
    }
    meta.textContent = label + extra;
    const btnUp = document.createElement('button'); btnUp.className='small'; btnUp.textContent='↑';
    const btnDown = document.createElement('button'); btnDown.className='small'; btnDown.textContent='↓';
    const btnRem = document.createElement('button'); btnRem.className='small'; btnRem.textContent='Remove';
    btnUp.addEventListener('click', () => { if (i>0){ [stops[i-1],stops[i]]=[stops[i],stops[i-1]]; rerenderStops(); } });
    btnDown.addEventListener('click', () => { if (i<stops.length-1){ [stops[i+1],stops[i]]=[stops[i],stops[i+1]]; rerenderStops(); } });
    btnRem.addEventListener('click', () => { removeStop(i); });
    div.appendChild(meta); div.appendChild(btnUp); div.appendChild(btnDown); div.appendChild(btnRem);
    stopsListEl.appendChild(div);
  });
}

function rerenderStops(){
  // re-create markers to match order
  stopMarkers.forEach(m=>m.remove()); stopMarkers = [];
  const copy = stops.slice(); stops = [];
  copy.forEach(s => addStopMarker(s));
}

function removeStop(index){
  if (index <0 || index >= stops.length) return;
  stops.splice(index,1);
  const m = stopMarkers[index]; if (m) { m.remove(); stopMarkers.splice(index,1); }
  renderStops();
}

// add a stop marker on the map and store it
function addStopMarker(stop){
  // annotate with time if tracking recent position available
  stop.t = latestPoint?.t || Date.now();
  if (!map) {
    stops.push(stop);
    renderStops();
    return;
  }
  const el = document.createElement('div');
  el.className = 'stop-marker';
  el.style.width='18px'; el.style.height='18px'; el.style.borderRadius='9px'; el.style.background='#4ade80'; el.style.border='2px solid white'; boxShadow(el,'0 2px 6px rgba(0,0,0,0.4)');
  const m = new maplibregl.Marker(el)
    .setLngLat([stop.lng, stop.lat])
    .addTo(map);
  stopMarkers.push(m);
  stops.push(stop);
  renderStops();
}

function boxShadow(el,val){try{el.style.boxShadow=val;}catch(e){}
}

// geocode a UK postcode using Nominatim
async function geocodePostcode(pc){
  const q = encodeURIComponent(pc.trim());
  const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=gb&limit=1&q=${q}`;
  console.debug('geocode request', url);
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      // Nominatim often requires a descriptive User-Agent
      'User-Agent': 'WayTraceGPS/1.0 (example@domain.com)'
    }
  });
  if (!res.ok) {
    console.error('geocode response status', res.status, res.statusText);
    throw new Error(`Geocode failed HTTP ${res.status}`);
  }
  const arr = await res.json();
  if (!arr || !arr.length) {
    console.warn('geocode returned no results for', pc, arr);
    throw new Error('No results');
  }
  const r = arr[0];
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), name: r.display_name, postcode: pc };
}

btnAddStop?.addEventListener('click', async () => {
  const pc = stopPostcodeEl?.value || '';
  if (!pc.trim()) { alert('Enter a postcode'); return; }
  try {
    setStatus('Geocoding…');
    const s = await geocodePostcode(pc);
    addStopMarker(s);
    setStatus('Stop added');
    // center map to stop briefly
    if (map) map.flyTo({ center: [s.lng, s.lat], zoom: 14 });
    stopPostcodeEl.value = '';
  } catch (e) {
    setStatus('Geocode failed');
    alert('Could not find that postcode');
  }
});

renderStops();

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

  // Require per-journey payment
  if (!isPaidForJourney()) {
    // prompt payment, then continue
    pendingStart = true;
    showPayModal();
    return;
  }

  points = [];
    // do NOT clear `stops` here so pre-added stops persist when starting
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

  // Update or create user location marker
  try {
    if (map) {
      if (!userMarker) {
        // create a custom SVG marker with accuracy circle
        const el = document.createElement('div'); el.className='user-marker';
        const svg = `<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
          <circle cx="18" cy="18" r="10" fill="#ff6b6b" stroke="#fff" stroke-width="2" />
        </svg>`;
        el.innerHTML = svg;
        userMarker = new maplibregl.Marker(el).setLngLat([p.lng, p.lat]).addTo(map);
        // accuracy element
        const accEl = document.createElement('div'); accEl.className='user-acc'; accEl.style.position='absolute'; accEl.style.left='50%'; accEl.style.top='50%'; accEl.style.transform='translate(-50%,-50%)'; accEl.style.borderRadius='50%'; accEl.style.background='rgba(255,107,107,0.12)'; accEl.style.pointerEvents='none'; accEl.style.zIndex='-1';
        el.appendChild(accEl);
      } else {
        userMarker.setLngLat([p.lng, p.lat]);
      }
      // update accuracy circle sizing (approximate conversion meters->pixels)
      try {
        const el = userMarker.getElement();
        const accEl = el.querySelector('.user-acc');
        if (accEl) {
          const meters = p.acc || 30;
          const lat = p.lat;
          const metersPerDeg = 111320;
          const degOffset = meters / metersPerDeg;
          const p2 = map.project([p.lng + degOffset, lat]);
          const p1 = map.project([p.lng, lat]);
          const px = Math.abs(p2.x - p1.x) || 20;
          const size = Math.max(24, px*2);
          accEl.style.width = size + 'px'; accEl.style.height = size + 'px';
          accEl.style.marginLeft = (-size/2) + 'px'; accEl.style.marginTop = (-size/2) + 'px';
        }
      } catch(e){}
    }
  } catch (e) {
    // ignore marker errors (map may not be ready)
  }

  trackInfoEl.textContent = `Points: ${points.length} | Acc: ${Math.round(p.acc)}m`;

  if (points.length === 1) centerMap();
}

btnStart.addEventListener("click", startSession);
btnStop.addEventListener("click", stopSession);
btnCenter.addEventListener("click", centerMap);
btnUiToggle.addEventListener('click', toggleUI);

function toggleUI(){
  const ui = document.getElementById('ui');
  ui.classList.toggle('minimized');
}

// auto collapse on narrow screens
function checkAutoCollapse(){
  const ui = document.getElementById('ui');
  if (window.innerWidth < 600) {
    ui.classList.add('minimized');
  }
}

window.addEventListener('resize', checkAutoCollapse);
checkAutoCollapse();

initMap();
setStatus("Idle");
