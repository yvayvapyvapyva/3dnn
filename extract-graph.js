// extract-graph.js
// Строит граф дорог для автосима из output/osm-cache.json.
// Запуск: node extract-graph.js [--in=./output/osm-cache.json] [--out=./output/road-graph.json]
// Свободное руление в пределах ширины дороги: храним ОСЕВУЮ + ширину,
// рекомендованная правая полоса — только смещение laneOff от оси.
import * as fs from 'node:fs/promises';
import path from 'node:path';

const MODEL_LAT = 56.3382925;
const MODEL_LON = 43.9393135;
const MODEL_COS = Math.cos((MODEL_LAT * Math.PI) / 180);

function project(lat, lon) {
  return { x: (lon - MODEL_LON) * 111320 * MODEL_COS, z: -((lat - MODEL_LAT) * 110540) };
}

// Только то, по чему реально ездят машины
const DRIVABLE = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

function parseLanes(tags) {
  const l = parseInt(tags?.lanes, 10);
  if (Number.isFinite(l) && l > 0 && l <= 8) return l;
  const h = tags?.highway;
  if (h === 'motorway') return 4;
  if (h === 'trunk' || h === 'primary') return 4;
  if (h === 'secondary') return 2;
  if (h === 'tertiary') return 2;
  return 2;
}

function roadWidth(tags, lanes) {
  const w = parseFloat(String(tags?.width ?? '').replace(',', '.'));
  if (Number.isFinite(w) && w > 0 && w < 60) return w;
  return lanes * 3.5;
}

function parseMaxspeed(tags) {
  const s = String(tags?.maxspeed ?? '').trim();
  const m = s.match(/(\d+)/);
  if (m) {
    const v = parseInt(m[1], 10);
    if (v >= 5 && v <= 130) return v;
  }
  if (s.includes('living') || tags?.highway === 'living_street') return 20;
  if (tags?.highway === 'service') return 20;
  if (tags?.highway === 'residential') return 40;
  return 60; // RU:urban по умолчанию
}

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Сдвиг точек вправо от направления движения на offset (метры)
function offsetRight(pts, offset) {
  const res = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    // нормаль вправо от направления: (dz, -dx) / len
    res.push({ x: p.x + (dz / len) * offset, z: p.z + (-dx / len) * offset });
  }
  return res;
}

function key(lat, lon) {
  return lat.toFixed(6) + ',' + lon.toFixed(6);
}

async function main() {
  const args = parseArgs();
  const inFile = args.in || './output/osm-cache.json';
  const outFile = args.out || './output/road-graph.json';
  const raw = JSON.parse(await fs.readFile(inFile, 'utf8'));
  const elements = raw.elements || raw;
  const ways = elements.filter((e) => e.type === 'way' && e.tags?.highway && DRIVABLE.has(e.tags.highway) && e.geometry?.length >= 2);
  console.log(`🛣️ Кандидатов: ${ways.length}`);

  const nodes = new Map(); // key -> {id,x,z,lat,lon}
  const edges = [];
  let edgeId = 0;
  const getNode = (lat, lon) => {
    const k = key(lat, lon);
    let n = nodes.get(k);
    if (!n) {
      const p = project(lat, lon);
      n = { id: nodes.size, x: +p.x.toFixed(2), z: +p.z.toFixed(2), lat, lon };
      nodes.set(k, n);
    }
    return n;
  };

  for (const w of ways) {
    const tags = w.tags;
    const oneway = tags.oneway === 'yes' || tags.highway === 'motorway' || tags.junction === 'roundabout';
    const lanesTotal = parseLanes(tags);
    const width = roadWidth(tags, lanesTotal);
    const maxspeed = parseMaxspeed(tags);
    const geom = w.geometry;
    const center = geom.map((p) => ({ ...project(p.lat, p.lon), lat: p.lat, lon: p.lon }));
    let len = 0;
    for (let i = 1; i < center.length; i++) len += Math.hypot(center[i].x - center[i - 1].x, center[i].z - center[i - 1].z);
    if (len < 5) continue;

    const mkEdge = (dirCenter, fromNode, toNode, laneOff) => {
      const pts = dirCenter.map((p) => [+p.x.toFixed(2), +p.z.toFixed(2)]);
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      edges.push({
        id: edgeId++, osmId: w.id, highway: tags.highway,
        name: tags.name || '', maxspeed, oneway: oneway ? 1 : 0,
        from: fromNode.id, to: toNode.id,
        length: +L.toFixed(1), pts,
        width: +width.toFixed(1), laneOff: +laneOff.toFixed(2),
      });
    };

    const nA = getNode(geom[0].lat, geom[0].lon);
    const nB = getNode(geom[geom.length - 1].lat, geom[geom.length - 1].lon);
    if (nA.id === nB.id) continue;

    if (oneway) {
      // правая полоса по ходу (рекомендация, не рельса)
      const off = Math.max(width / 2 - 1.75, 0);
      mkEdge(center, nA, nB, off);
    } else {
      // встречные направления делят одну ось; у каждого своя правая сторона
      const perDir = Math.max(1, Math.round(lanesTotal / 2));
      const wDir = perDir * 3.5;
      const off = Math.max(wDir / 2, 1.75);
      mkEdge(center, nA, nB, off);
      mkEdge([...center].reverse(), nB, nA, off);
    }
  }

  // Смежность для роутинга
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.id);
  }

  const out = {
    meta: { modelLat: MODEL_LAT, modelLon: MODEL_LON, rightHand: true, freeWidth: true, builtAt: new Date().toISOString() },
    nodes: [...nodes.values()],
    edges,
  };
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(out));
  const kb = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`✅ Граф: узлов ${out.nodes.length}, рёбер ${edges.length} -> ${outFile} (${kb} КБ)`);
  // связность: доля узлов с исходящими
  let withOut = 0;
  for (const n of out.nodes) if (adj.has(n.id)) withOut++;
  console.log(`🔗 Узлов с выездом: ${withOut}/${out.nodes.length}`);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
