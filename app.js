let map
let watchID=null

let route=[]
let totalDistance=0
let lastPoint=null

map = new maplibregl.Map({

container:"map",

style:{
version:8,

sources:{
osm:{
type:"raster",
tiles:[
"https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
"https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
"https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"
],
tileSize:256,
attribution:"© OpenStreetMap"
}
},

layers:[
{
id:"osm-layer",
type:"raster",
source:"osm"
}
]

},

center:[0,0],
zoom:2

})

map.on("load",()=>{

map.addSource("route",{
type:"geojson",
data:{
type:"Feature",
geometry:{
type:"LineString",
coordinates:[]
}
}
})

map.addLayer({
id:"route",
type:"line",
source:"route",
paint:{
"line-color":"#00ff88",
"line-width":4
}
})

})

function startTracking(){

if(watchID) return

watchID = navigator.geolocation.watchPosition(position=>{

const lat = position.coords.latitude
const lng = position.coords.longitude
const speed = position.coords.speed || 0

document.getElementById("speed").innerText=(speed*3.6).toFixed(1)

updateRoute(lng,lat)

map.setCenter([lng,lat])
map.setZoom(16)

},{enableHighAccuracy:true})

}

function stopTracking(){

navigator.geolocation.clearWatch(watchID)
watchID=null

saveJourney()

}

function updateRoute(lng,lat){

route.push([lng,lat])

if(lastPoint){

totalDistance+=distanceBetween(lastPoint,[lng,lat])

document.getElementById("distance").innerText=(totalDistance/1000).toFixed(2)

}

lastPoint=[lng,lat]

const source = map.getSource("route")

if(source){

source.setData({

type:"Feature",

geometry:{
type:"LineString",
coordinates:route
}

})

}

}

function distanceBetween(a,b){

const R=6371000

const lat1=a[1]*Math.PI/180
const lat2=b[1]*Math.PI/180

const dLat=(b[1]-a[1])*Math.PI/180
const dLng=(b[0]-a[0])*Math.PI/180

const x=Math.sin(dLat/2)*Math.sin(dLat/2)+
Math.cos(lat1)*Math.cos(lat2)*
Math.sin(dLng/2)*Math.sin(dLng/2)

const y=2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))

return R*y

}

function saveJourney(){

const journeys = JSON.parse(localStorage.getItem("journeys")||"[]")

journeys.push({
date:Date.now(),
distance:totalDistance,
route:route
})

localStorage.setItem("journeys",JSON.stringify(journeys))

}

function exportJourney(){

const data = JSON.stringify(route)

const blob = new Blob([data],{type:"application/json"})

const url = URL.createObjectURL(blob)

const a = document.createElement("a")

a.href=url
a.download="journey.json"
a.click()

}
