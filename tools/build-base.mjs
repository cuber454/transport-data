// Сбор базовой базы: все маршруты города, их остановки в обе стороны, координаты.
// Один проход, дальше берётся из кэша в base/routes/*.json.
//
// Запуск: node build-base.mjs            (соберёт чего не хватает)
//         node build-base.mjs --delay 400

import fs from 'node:fs';
import path from 'node:path';
import { routeList, routeInfo } from './minsktrans.mjs';

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DELAY = Number(getArg('delay', 250));
const TYPES = ['trolleybus', 'bus', 'tram'];
const OUT = process.env.BASE_DIR ? path.resolve(process.env.BASE_DIR) : path.join(process.cwd(), 'base');
const ROUTES_DIR = path.join(OUT, 'routes');
fs.mkdirSync(ROUTES_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cacheFile = (tt, num) => path.join(ROUTES_DIR, `${tt}-${encodeURIComponent(num)}.json`);

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

async function main() {
  let fetched = 0;
  let cached = 0;
  const failures = [];
  const routes = [];

  for (const tt of TYPES) {
    const list = await withRetry(() => routeList(tt));
    const items = list?.Routes ?? [];
    console.log(`${tt}: ${items.length} маршрутов`);

    for (const item of items) {
      const number = String(item.Number ?? '').trim();
      if (!number) continue;
      const file = cacheFile(tt, number);
      let data = null;

      if (fs.existsSync(file)) {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
        cached += 1;
      } else {
        try {
          data = await withRetry(() => routeInfo(tt, number));
          fs.writeFileSync(file, JSON.stringify(data), 'utf8');
          fetched += 1;
          if (fetched % 20 === 0) console.log(`  скачано ${fetched} (${tt} ${number})`);
          await sleep(DELAY);
        } catch (err) {
          failures.push(`${tt} ${number}: ${err.message}`);
          continue;
        }
      }
      routes.push({ tt, number, data });
    }
  }

  // Собираем базу
  const stops = new Map();
  const base = { builtAt: new Date().toISOString(), source: 'minsktrans.by/lookout_yard', routes: [], stats: {} };

  for (const { tt, number, data } of routes) {
    const trips = data?.Trips ?? {};
    const dirs = [];
    for (const suffix of ['A', 'B']) {
      const list = trips[`Stops${suffix}`];
      if (!Array.isArray(list) || list.length < 2) continue;
      const ids = [];
      for (const s of list) {
        ids.push(s.Id);
        if (!stops.has(s.Id)) {
          stops.set(s.Id, { lat: s.Latitude, lon: s.Longitude, bearing: s.Bearing ?? null });
        }
      }
      dirs.push({
        suffix,
        end: (trips[`EndStop${suffix}`] ?? '').replace(/''/g, '"').replace(/\s*\([^)]*\)\s*/g, ' ').trim(),
        name: (trips[`Name${suffix}`] ?? '').replace(/''/g, '"').trim(),
        stops: ids,
      });
    }
    if (dirs.length === 0) continue;
    base.routes.push({ tt, number, dirs });
  }

  base.stops = Object.fromEntries(stops);
  base.stats = {
    routes: base.routes.length,
    stops: stops.size,
    fetched,
    cached,
    failures: failures.length,
  };

  const file = path.join(OUT, 'base.json');
  fs.writeFileSync(file, JSON.stringify(base), 'utf8');
  fs.writeFileSync(path.join(OUT, 'failures.txt'), failures.join('\n'), 'utf8');

  const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
  console.log(`\nготово: маршрутов ${base.stats.routes}, остановок ${stops.size}`);
  console.log(`скачано ${fetched}, из кэша ${cached}, сбоев ${failures.length}`);
  console.log(`база: ${file} (${mb} МБ)`);
}

main().catch((err) => {
  console.error('сломалось:', err.message);
  process.exit(1);
});
