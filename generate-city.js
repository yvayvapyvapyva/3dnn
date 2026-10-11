// generate-city.js
// Генерация 3D-модели города (GLB) из OpenStreetMap для прямоугольника Нижнего Новгорода.
// Запуск: node generate-city.js
// С переопределением координат:
//   node generate-city.js --nw-lat=56.35 --nw-lon=43.91 --se-lat=56.32 --se-lon=43.95 [--compress] [--out=./output/city.glb]

import * as fs from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// ---------------------------------------------------------------------------
// Полифилл FileReader для Node.js: GLTFExporter внутри использует FileReader
// (браузерный API), которого нет в Node. Blob.arrayBuffer() в Node 18+ есть.
// ---------------------------------------------------------------------------
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    constructor() {
      this.result = null;
      this.onload = null;
      this.onloadend = null; // именно его ждёт GLTFExporter three.js
      this.onerror = null;
      this._listeners = {};
    }
    addEventListener(type, cb) {
      (this._listeners[type] ??= []).push(cb);
    }
    _fire(type) {
      const ev = { target: this };
      if (type === 'load' && typeof this.onload === 'function') this.onload(ev);
      if (type === 'loadend' && typeof this.onloadend === 'function') this.onloadend(ev);
      for (const cb of this._listeners[type] ?? []) cb(ev);
    }
    readAsArrayBuffer(blob) {
      Promise.resolve()
        .then(() => (blob?.arrayBuffer ? blob.arrayBuffer() : blob))
        .then((buf) => {
          this.result = buf;
          this._fire('load');
          this._fire('loadend');
        })
        .catch((e) => {
          if (typeof this.onerror === 'function') this.onerror(e);
        });
    }
    readAsDataURL(blob) {
      Promise.resolve()
        .then(() => blob.arrayBuffer())
        .then((buf) => {
          const b = Buffer.from(buf);
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${b.toString('base64')}`;
          this._fire('load');
          this._fire('loadend');
        })
        .catch((e) => {
          if (typeof this.onerror === 'function') this.onerror(e);
        });
    }
  };
}

// ---------------------------------------------------------------------------
// Константы по умолчанию: прямоугольник Нижнего Новгорода
// NW = северо-запад (верхний левый), SE = юго-восток (нижний правый)
// ---------------------------------------------------------------------------
const DEFAULT_BBOX = {
  lat_nw: 56.349222,
  lon_nw: 43.918941,
  lat_se: 56.327363,
  lon_se: 43.959686,
};

// Центр проекции модели (совпадает с центром DEFAULT_BBOX)
const MODEL_LAT = 56.3382925;
const MODEL_LON = 43.9393135;
const MODEL_COS = Math.cos((MODEL_LAT * Math.PI) / 180);
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * MODEL_COS;
// Зеркала Overpass API (первое — основное)
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const MAX_RETRIES = 3;      // максимум попыток при 429/504
const RETRY_DELAY_MS = 5000; // задержка между попытками
const BUILDING_WARN_LIMIT = 5000;
const DEFAULT_BUILDING_HEIGHT = 10; // метров

// ---------------------------------------------------------------------------
// Парсинг аргументов командной строки вида --nw-lat=56.34
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a === '--compress') out.compress = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function getBBoxFromArgs() {
  const args = parseArgs();
  return {
    bbox: {
      lat_nw: args['nw-lat'] !== undefined ? Number(args['nw-lat']) : DEFAULT_BBOX.lat_nw,
      lon_nw: args['nw-lon'] !== undefined ? Number(args['nw-lon']) : DEFAULT_BBOX.lon_nw,
      lat_se: args['se-lat'] !== undefined ? Number(args['se-lat']) : DEFAULT_BBOX.lat_se,
      lon_se: args['se-lon'] !== undefined ? Number(args['se-lon']) : DEFAULT_BBOX.lon_se,
    },
    compress: Boolean(args.compress || args['compress']),
    outFile: args.out || args.output || './output/city.glb',
    help: Boolean(args.help),
  };
}

// ---------------------------------------------------------------------------
// Проверка корректности bbox: север должен быть севернее юга, запад — западнее востока
// ---------------------------------------------------------------------------
function validateBBox(bbox) {
  const { lat_nw, lon_nw, lat_se, lon_se } = bbox;
  for (const [k, v] of Object.entries(bbox)) {
    if (!Number.isFinite(v)) throw new Error(`Некорректная координата ${k}: ${v}`);
  }
  if (!(lat_nw > lat_se)) {
    throw new Error(
      `Некорректный bbox: lat_nw (${lat_nw}) должен быть > lat_se (${lat_se}) (север севернее юга).`
    );
  }
  if (!(lon_nw < lon_se)) {
    throw new Error(
      `Некорректный bbox: lon_nw (${lon_nw}) должен быть < lon_se (${lon_se}) (запад западнее востока).`
    );
  }
  if (lat_nw > 90 || lat_se < -90 || lon_nw < -180 || lon_se > 180) {
    throw new Error('Координаты выходят за допустимые пределы lat [-90,90], lon [-180,180].');
  }
}

// ---------------------------------------------------------------------------
// Расстояние по гаверсинусу (км) + размеры прямоугольника
// ---------------------------------------------------------------------------
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function logBBoxSize(bbox) {
  // Ширина — по верхней параллели, высота — по левому меридиану
  const widthKm = haversineKm(bbox.lat_nw, bbox.lon_nw, bbox.lat_nw, bbox.lon_se);
  const heightKm = haversineKm(bbox.lat_nw, bbox.lon_nw, bbox.lat_se, bbox.lon_nw);
  console.log(
    `📐 Прямоугольник: ${widthKm.toFixed(3)} км (В-З) × ${heightKm.toFixed(3)} км (С-Ю) ≈ ${(widthKm * heightKm).toFixed(3)} км²`
  );
  return { widthKm, heightKm };
}

// ---------------------------------------------------------------------------
// Проекция WGS84 -> локальные метры (равнопромежуточная).
// Центр ФИКСИРОВАН на MODEL_LAT/MODEL_LON (НЕ МЕНЯТЬ: к нему привязаны
// вьювер и подложка finalsat). Скачиваемая область (bbox) может быть любой.
// В Three.js: +X — восток, -Z — север. Для Shape используем yNorth.
// ---------------------------------------------------------------------------
function makeProjector() {
  const centerLat = MODEL_LAT;
  const centerLon = MODEL_LON;
  const cosLat = MODEL_COS;
  return {
    centerLat,
    centerLon,
    // -> { x, yNorth } (метры), yNorth растёт на север
    project(lat, lon) {
      const x = (lon - centerLon) * 111320 * cosLat;
      const yNorth = (lat - centerLat) * 110540;
      return { x, yNorth };
    },
    // -> { x, z } в мировых координатах Three.js (z растёт на юг)
    projectWorld(lat, lon) {
      const { x, yNorth } = this.project(lat, lon);
      return { x, z: -yNorth };
    },
  };
}

// ---------------------------------------------------------------------------
// Загрузка данных OSM через Overpass API с retry при 429/504
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Один подзапрос к Overpass (одна категория) с retry при 429/5xx.
// Используем GET: проверено, что POST на overpass-api.de отдаёт 406/504.
// ---------------------------------------------------------------------------
async function fetchOverpassQuery(query, label) {
  let lastError = null;
  // Раундов — MAX_RETRIES (по ТЗ: 3 попытки, задержка 5 c).
  // Внутри раунда пробуем все зеркала по очереди: часть зеркал может лежать
  // (500) или отдавать 504 под нагрузкой — это транзиентно, следующий раунд
  // снова начнёт с основного overpass-api.de.
  for (let round = 1; round <= MAX_RETRIES; round++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        console.log(`🌐 Overpass [${label}]: раунд ${round}/${MAX_RETRIES} -> ${endpoint}`);
        const url = endpoint + '?data=' + encodeURIComponent(query);
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': '3dnn-city-generator/1.0 (local use)',
          },
        });
        if ([429, 500, 502, 503, 504, 406].includes(res.status)) {
          const text = await res.text().catch(() => '');
          lastError = new Error(`Overpass вернул ${res.status} ${res.statusText} ${text.slice(0, 120)}`);
          console.warn(`⚠️ ${lastError.message}`);
          continue; // следующее зеркало
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Overpass ошибка ${res.status}: ${text.slice(0, 300)}`);
        }
        const json = await res.json();
        if (!json.elements) throw new Error('Неожиданный ответ Overpass: нет поля elements');
        return json.elements;
      } catch (err) {
        lastError = err;
        console.warn(`⚠️ Ошибка запроса [${label}]: ${err.message}`);
      }
    }
    if (round < MAX_RETRIES) {
      console.log(`⏳ Все зеркала заняты. Жду ${RETRY_DELAY_MS / 1000} c перед раундом ${round + 1}...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw new Error(`Не удалось скачать "${label}" после ${MAX_RETRIES} раундов: ${lastError?.message}`);
}

// ---------------------------------------------------------------------------
// Загрузка данных OSM через Overpass API.
// Качаем по категориям отдельными запросами: один общий union-запрос на
// плотном городе регулярно упирается в 504 Gateway Timeout, а маленькие
// проходят за секунды. В конце склеиваем и убираем дубли (type+id).
// ---------------------------------------------------------------------------
async function fetchOSMData(bbox) {
  // Overpass ждёт bbox как (юг, запад, север, восток)
  const s = bbox.lat_se, w = bbox.lon_nw, n = bbox.lat_nw, e = bbox.lon_se;
  const parts = [
    { label: 'дороги', q: `way["highway"](${s},${w},${n},${e});` },
    { label: 'здания', q: `way["building"](${s},${w},${n},${e});` },
    { label: 'вода', q: `way["natural"="water"](${s},${w},${n},${e});` },
    { label: 'парки/трава', q: `(way["leisure"="park"](${s},${w},${n},${e});way["landuse"="grass"](${s},${w},${n},${e}););` },
  ];

  const seen = new Set();
  const elements = [];
  for (const part of parts) {
    const query = `[out:json][timeout:180];(${part.q});out geom;`;
    const els = await fetchOverpassQuery(query, part.label);
    let added = 0;
    for (const el of els) {
      const key = el.type + '/' + el.id;
      if (!seen.has(key)) { seen.add(key); elements.push(el); added++; }
    }
    console.log(`📦 ${part.label}: получено ${els.length}, новых ${added}`);
    // Пауза из вежливости к публичному API
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { elements };
}

// Ширина дороги (м): из тега lanes (полоса = 3.5 м), иначе тег width,
// иначе эвристика по типу highway
function roadWidth(tags) {
  const lanes = parseInt(tags?.lanes, 10);
  if (Number.isFinite(lanes) && lanes > 0 && lanes <= 12) return lanes * 3.5;
  const w = parseFloat(String(tags?.width ?? '').replace(',', '.'));
  if (Number.isFinite(w) && w > 0 && w < 60) return w;
  const map = {
    motorway: 14, trunk: 10.5, primary: 7, secondary: 7, tertiary: 6,
    unclassified: 5, residential: 5, living_street: 4, service: 3,
    pedestrian: 4, track: 3, footway: 1.5, path: 1.5, cycleway: 1.5, steps: 1.5,
  };
  return map[tags?.highway] ?? 4;
}

// Число полос из тегов (для логов)
function roadLanes(tags, width) {
  const lanes = parseInt(tags?.lanes, 10);
  if (Number.isFinite(lanes) && lanes > 0 && lanes <= 12) return lanes;
  return width >= 10 ? 4 : width >= 6.5 ? 2 : 1; // эвристика для дорог без тега
}

// ---------------------------------------------------------------------------
// Лента вдоль осевой линии: четырёхугольники со сдвигом offset от центра,
// полушириной halfW, на высоте y. dash/gap (м) — пунктир (0 = сплошная).
// pts — уже спроецированные [{x, z}]. Возвращает {positions, indices, count}.
// ---------------------------------------------------------------------------
function ribbonQuads(pts, offset, halfW, y, dash = 0, gap = 0) {
  const positions = [];
  const indices = [];
  let v = 0;
  let s = 0; // пройденная длина вдоль линии (для пунктира)

  const quad = (ax, az, bx, bz, nx, nz) => {
    positions.push(
      ax + nx * (offset - halfW), y, az + nz * (offset - halfW),
      ax + nx * (offset + halfW), y, az + nz * (offset + halfW),
      bx + nx * (offset + halfW), y, bz + nz * (offset + halfW),
      bx + nx * (offset - halfW), y, bz + nz * (offset - halfW)
    );
    indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  };

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const nx = -dz / len, nz = dx / len; // единичная нормаль влево от направления
    if (dash <= 0) {
      quad(a.x, a.z, b.x, b.z, nx, nz);
      s += len;
    } else {
      // Режем сегмент по шаблону dash/gap от глобальной позиции s
      let t0 = 0;
      while (t0 < len) {
        const period = dash + gap;
        const phase = (s + t0) % period;
        let t1;
        if (phase < dash) t1 = Math.min(t0 + (dash - phase), len); // внутри штриха
        else t1 = Math.min(t0 + (period - phase), len); // внутри пропуска — пропускаем
        if (phase < dash && t1 - t0 > 0.05) {
          const f0 = t0 / len, f1 = t1 / len;
          quad(a.x + dx * f0, a.z + dz * f0, a.x + dx * f1, a.z + dz * f1, nx, nz);
        }
        t0 = t1;
      }
      s += len;
    }
  }
  return { positions, indices, count: v };
}

// ---------------------------------------------------------------------------
// Дороги: асфальт плоскими лентами на уровне земли (y=0.08).
// Ширина — из тега lanes (полоса = 3.5 м), иначе width, иначе по типу highway.
// Разметка отключена по просьбе пользователя (не совпадает с реальной).
// ---------------------------------------------------------------------------
function buildRoads(osmData, scene, projector) {
  const ways = osmData.elements.filter((el) => el.type === 'way' && el.tags?.highway && el.geometry);
  console.log(`🛣️ Дорог найдено: ${ways.length}`);

  const Y_ASPHALT = 0.08; // чуть выше земли, чтобы не было z-fighting

  const asp = { positions: [], indices: [], count: 0 };
  const append = (acc, part) => {
    acc.positions.push(...part.positions);
    for (const idx of part.indices) acc.indices.push(idx + acc.count);
    acc.count += part.count;
  };

  let withLanes = 0;
  for (const way of ways) {
    const raw = way.geometry;
    if (!raw || raw.length < 2) continue;
    // Проецируем осевую один раз
    const pts = [];
    for (const p of raw) {
      const w = projector.projectWorld(p.lat, p.lon);
      pts.push(w);
    }
    const width = roadWidth(way.tags);
    if (way.tags?.lanes) withLanes++;

    // Асфальт — сплошная лента по осевой
    append(asp, ribbonQuads(pts, 0, width / 2, Y_ASPHALT));
  }

  if (asp.count === 0) {
    console.log('🛣️ Геометрия дорог пуста — пропускаю.');
    return 0;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(asp.positions, 3));
  geo.setIndex(asp.indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.95, metalness: 0 })
  );
  mesh.name = 'roads';
  scene.add(mesh);
  console.log(`🛣️ Асфальт: вершин ${asp.count}, дорог с тегом lanes: ${withLanes}`);
  return ways.length;
}

// Высота здания из тегов: height / building:levels / значение по умолчанию
function buildingHeight(tags) {
  if (tags?.height) {
    const m = String(tags.height).match(/[\d.,]+/);
    if (m) {
      const h = parseFloat(m[0].replace(',', '.'));
      if (Number.isFinite(h) && h > 0 && h < 500) return h;
    }
  }
  if (tags?.['building:levels']) {
    const lv = parseFloat(String(tags['building:levels']).replace(',', '.'));
    if (Number.isFinite(lv) && lv > 0 && lv < 100) return lv * 3;
  }
  return DEFAULT_BUILDING_HEIGHT;
}

// ---------------------------------------------------------------------------
// Здания: экструзия контуров на высоту
// ---------------------------------------------------------------------------
function buildBuildings(osmData, scene, projector) {
  const ways = osmData.elements.filter((el) => el.type === 'way' && el.tags?.building && el.geometry);
  console.log(`🏢 Зданий найдено: ${ways.length}`);
  if (ways.length > BUILDING_WARN_LIMIT) {
    console.warn(
      `⚠️ Зданий больше ${BUILDING_WARN_LIMIT} (${ways.length})! GLB будет тяжёлым — разбейте карту на тайлы.`
    );
  }

  const mat = new THREE.MeshStandardMaterial({ color: 0xb8a88f, roughness: 0.85, metalness: 0.02 });
  const group = new THREE.Group();
  group.name = 'buildings';
  let built = 0;

  for (const way of ways) {
    const pts = way.geometry;
    if (!pts || pts.length < 3) continue;
    // Контур в координатах Shape (x, yNorth)
    const shape = new THREE.Shape();
    for (let i = 0; i < pts.length; i++) {
      const p = projector.project(pts[i].lat, pts[i].lon);
      if (i === 0) shape.moveTo(p.x, p.yNorth);
      else shape.lineTo(p.x, p.yNorth);
    }
    shape.closePath();
    const h = buildingHeight(way.tags);
    try {
      const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); // ось экструзии Z -> вверх +Y, север окажется на -Z
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `building_${way.id}`;
      group.add(mesh);
      built++;
    } catch {
      // Пропускаем самопересекающиеся/вырожденные контуры
      continue;
    }
  }

  scene.add(group);
  console.log(`🏢 Построено зданий: ${built}`);
  return built;
}

// Общая helper: плоский полигон из way -> Mesh (вода/парки)
function flatPolygonMesh(way, projector, material, yOffset, namePrefix) {
  const pts = way.geometry;
  if (!pts || pts.length < 3) return null;
  const shape = new THREE.Shape();
  for (let i = 0; i < pts.length; i++) {
    const p = projector.project(pts[i].lat, pts[i].lon);
    if (i === 0) shape.moveTo(p.x, p.yNorth);
    else shape.lineTo(p.x, p.yNorth);
  }
  shape.closePath();
  try {
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, yOffset, 0);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `${namePrefix}_${way.id}`;
    return mesh;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Вода: плоские полигоны синего цвета
// ---------------------------------------------------------------------------
function buildWater(osmData, scene, projector) {
  const ways = osmData.elements.filter((el) => el.type === 'way' && el.tags?.natural === 'water' && el.geometry);
  console.log(`💧 Объектов воды найдено: ${ways.length}`);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2f7fd1, roughness: 0.4, metalness: 0.1 });
  const group = new THREE.Group();
  group.name = 'water';
  let n = 0;
  for (const way of ways) {
    const mesh = flatPolygonMesh(way, projector, mat, 0.04, 'water');
    if (mesh) { group.add(mesh); n++; }
  }
  scene.add(group);
  console.log(`💧 Построено полигонов воды: ${n}`);
  return n;
}

// ---------------------------------------------------------------------------
// Парки/трава: плоские полигоны зелёного цвета
// ---------------------------------------------------------------------------
function buildParks(osmData, scene, projector) {
  const ways = osmData.elements.filter(
    (el) =>
      el.type === 'way' &&
      el.geometry &&
      (el.tags?.leisure === 'park' || el.tags?.landuse === 'grass')
  );
  console.log(`🌳 Парков/газонов найдено: ${ways.length}`);
  const mat = new THREE.MeshStandardMaterial({ color: 0x4da64d, roughness: 1, metalness: 0 });
  const group = new THREE.Group();
  group.name = 'parks';
  let n = 0;
  for (const way of ways) {
    const mesh = flatPolygonMesh(way, projector, mat, 0.03, 'park');
    if (mesh) { group.add(mesh); n++; }
  }
  scene.add(group);
  console.log(`🌳 Построено полигонов парков: ${n}`);
  return n;
}

// ---------------------------------------------------------------------------
// Экспорт сцены в GLB (binary glTF) через GLTFExporter
// ---------------------------------------------------------------------------
async function exportGLB(scene, outFile) {
  const exporter = new GLTFExporter();
  console.log('💾 Экспорт сцены в GLB...');
  // parseAsync доступен в three >= r150; binary:true даёт .glb
  const result = await exporter.parseAsync(scene, { binary: true });
  // result — ArrayBuffer (Uint8Array в некоторых версиях)
  const buffer = Buffer.isBuffer(result)
    ? result
    : Buffer.from(result instanceof Uint8Array ? result : new Uint8Array(result));
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, buffer);
  const mb = (buffer.length / 1024 / 1024).toFixed(2);
  console.log(`✅ Сохранено: ${outFile} (${mb} МБ)`);
  return outFile;
}

// Опциональная Draco-компрессия через gltf-pipeline (только при --compress)
async function maybeCompress(outFile) {
  try {
    console.log('🗜️ Пробую Draco-компрессию через gltf-pipeline...');
    const pipeline = await import('gltf-pipeline').catch(() => null);
    if (!pipeline) {
      console.warn('⚠️ gltf-pipeline не установлен. Пропускаю сжатие. Установите: npm i -D gltf-pipeline');
      console.warn(`   Вручную: npx gltf-pipeline -i ${outFile} -o ./output/city-draco.glb -d`);
      return;
    }
    const glb = await fs.readFile(outFile);
    // API v4: processGlb(buffer, options)
    const processGlb = pipeline.processGlb ?? pipeline.default?.processGlb;
    if (typeof processGlb !== 'function') throw new Error('processGlb не найден в gltf-pipeline');
    const res = await processGlb(glb, { dracoOptions: { compressionLevel: 7 } });
    const outDraco = outFile.replace(/\.glb$/i, '-draco.glb');
    await fs.writeFile(outDraco, Buffer.from(res.glb));
    console.log(`✅ Draco GLB сохранён: ${outDraco}`);
  } catch (err) {
    console.warn(`⚠️ Сжатие не удалось: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------
async function main() {
  try {
    const { bbox, compress, outFile, help } = getBBoxFromArgs();
    if (help) {
      console.log(`Использование:
  node generate-city.js
  node generate-city.js --nw-lat=56.35 --nw-lon=43.91 --se-lat=56.32 --se-lon=43.95 [--compress] [--out=./output/city.glb] [--refresh]`);
      return;
    }

    console.log('🏙️ Генерация 3D-города из OSM...');
    console.log(`📍 BBOX: NW(${bbox.lat_nw}, ${bbox.lon_nw}) SE(${bbox.lat_se}, ${bbox.lon_se})`);

    validateBBox(bbox);
    logBBoxSize(bbox);

    // Кэш сырого ответа OSM: повторные запуски не дёргают перегруженный Overpass.
    // Флаг --refresh принудительно перекачивает данные.
    const cacheFile = path.join(path.dirname(outFile), 'osm-cache.json');
    const wantRefresh = Boolean(parseArgs().refresh);
    let osmData = null;
    if (!wantRefresh) {
      try {
        const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
        const cb = cached.bbox || {};
        const same =
          cb.lat_nw === bbox.lat_nw && cb.lon_nw === bbox.lon_nw &&
          cb.lat_se === bbox.lat_se && cb.lon_se === bbox.lon_se &&
          Array.isArray(cached.elements);
        if (same) {
          osmData = { elements: cached.elements };
          console.log(`💽 Кэш найден: ${cacheFile} (${osmData.elements.length} элементов) — качаю заново? добавьте --refresh`);
        }
      } catch { /* кэша нет — качаем */ }
    }
    if (!osmData) {
      osmData = await fetchOSMData(bbox);
      try {
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify({ bbox, elements: osmData.elements }));
        console.log(`💽 Кэш сохранён: ${cacheFile}`);
      } catch (e) {
        console.warn(`⚠️ Не удалось сохранить кэш: ${e.message}`);
      }
    }
    console.log(`📦 Загружено OSM-элементов: ${osmData.elements?.length ?? 0}`);

    const projector = makeProjector();

    // Сцена: свет + земля-подложка по размеру bbox
    const scene = new THREE.Scene();
    scene.name = 'NizhnyNovgorod';

    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(100, 200, 50);
    // glTF хранит направление света через target: делаем его ребёнком света,
    // иначе GLTFExporter теряет направление (warning "Light direction may be lost").
    // AmbientLight не входит в glTF-стандарт — его не добавляем, вьюверы
    // (Godot / three.js) всё равно дают своё базовое освещение.
    sun.target.position.set(0, 0, -1);
    sun.add(sun.target);
    scene.add(sun);

    // Подложка-земля (размер из проекции углов bbox)
    const pNW = projector.project(bbox.lat_nw, bbox.lon_nw);
    const pSE = projector.project(bbox.lat_se, bbox.lon_se);
    const sizeX = Math.abs(pSE.x - pNW.x);
    const sizeZ = Math.abs(pSE.yNorth - pNW.yNorth);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(sizeX, sizeZ),
      new THREE.MeshStandardMaterial({ color: 0x8a8f7a, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.name = 'ground';
    scene.add(ground);
    console.log(`🟫 Подложка: ${sizeX.toFixed(1)} м × ${sizeZ.toFixed(1)} м`);

    // Построение слоёв
    const nRoads = buildRoads(osmData, scene, projector);
    const nBuildings = buildBuildings(osmData, scene, projector);
    const nWater = buildWater(osmData, scene, projector);
    const nParks = buildParks(osmData, scene, projector);

    console.log(`📊 Итог: дороги=${nRoads} здания=${nBuildings} вода=${nWater} парки=${nParks}`);

    const saved = await exportGLB(scene, outFile);
    if (compress) await maybeCompress(saved);
    console.log('🎉 Готово!');
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    process.exit(1);
  }
}

main();
