// extract-buildings.js
// Выгружает контуры зданий (препятствия) из output/osm-cache.json в output/obstacles.json.
// Проекция та же, что в generate-city.js (метры, +X восток, +Z юг).
import * as fs from 'node:fs/promises';
import path from 'node:path';

const MODEL_LAT = 56.3382925;
const MODEL_LON = 43.9393135;
const MODEL_COS = Math.cos((MODEL_LAT * Math.PI) / 180);

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const inFile = args.in || './output/osm-cache.json';
  const outFile = args.out || './output/obstacles.json';
  const raw = JSON.parse(await fs.readFile(inFile, 'utf8'));
  const elements = raw.elements || raw;
  const ways = elements.filter(
    (e) => e.type === 'way' && e.tags?.building && e.geometry?.length >= 3
  );
  console.log(`🏢 Зданий: ${ways.length}`);

  const polys = [];
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const w of ways) {
    const pts = [];
    for (const p of w.geometry) {
      const x = +((p.lon - MODEL_LON) * 111320 * MODEL_COS).toFixed(2);
      const z = +(-((p.lat - MODEL_LAT) * 110540)).toFixed(2);
      pts.push([x, z]);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    // убираем дублирующую последнюю точку (замкнутый контур OSM)
    if (pts.length > 1) {
      const a = pts[0], b = pts[pts.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) pts.pop();
    }
    if (pts.length < 3) continue;
    // bbox полигона для быстрого отсечения
    let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9;
    for (const [x, z] of pts) {
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
    }
    polys.push({ b: [+bx0.toFixed(1), +bz0.toFixed(1), +bx1.toFixed(1), +bz1.toFixed(1)], p: pts });
  }

  const out = { meta: { bounds: [x0, z0, x1, z1], count: polys.length }, polys };
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(out));
  console.log(`✅ Препятствия: ${polys.length} -> ${outFile} (${(JSON.stringify(out).length / 1024).toFixed(0)} КБ)`);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
