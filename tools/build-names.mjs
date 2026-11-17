// Собирает названия остановок: у табло есть действие StopName (по одной остановке).
// Результат вписывается прямо в base/base.json полем "name" у каждой остановки.
//
// Запуск: node build-names.mjs [--delay 250]

import fs from 'node:fs';
import { stopName } from './minsktrans.mjs';

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const DELAY = Number(getArg('delay', '250'));
const DIR = process.env.BASE_DIR ? process.env.BASE_DIR : './base';
const BASE_PATH = DIR + '/base.json';
const NAMES_PATH = DIR + '/stop-names.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = JSON.parse(fs.readFileSync(BASE_PATH, 'utf8'));
const ids = Object.keys(base.stops);

const names = fs.existsSync(NAMES_PATH)
  ? JSON.parse(fs.readFileSync(NAMES_PATH, 'utf8'))
  : {};

let done = 0;
let failed = 0;
const started = Date.now();

for (const id of ids) {
  if (names[id]) continue;
  let saved = false;
  for (let attempt = 1; attempt <= 3 && !saved; attempt += 1) {
    try {
      const response = await stopName(id);
      const name = response?.Name;
      if (name) {
        names[id] = name;
        saved = true;
      }
    } catch {
      await sleep(500 * attempt);
    }
  }
  if (!saved) failed += 1;
  done += 1;
  if (done % 50 === 0) {
    const left = ids.length - done;
    const perItem = (Date.now() - started) / done;
    console.log(`  ${done}/${ids.length}, без имени ${failed}, осталось ~${Math.round((left * perItem) / 60000)} мин`);
    fs.writeFileSync(NAMES_PATH, JSON.stringify(names), 'utf8');
  }
  await sleep(DELAY);
}

fs.writeFileSync(NAMES_PATH, JSON.stringify(names), 'utf8');

let merged = 0;
for (const id of ids) {
  const name = names[id];
  if (!name) continue;
  if (base.stops[id].name !== name) {
    base.stops[id].name = name;
    merged += 1;
  }
}

base.namesBuiltAt = new Date().toISOString();
fs.writeFileSync(BASE_PATH, JSON.stringify(base), 'utf8');

console.log(`\nготово: имён ${Object.keys(names).length}, вписано ${merged}`);
console.log(`без имени: ${failed} (id вида ${ids.filter((id) => !names[id]).slice(0, 5).join(', ')})`);
console.log(`база: ${BASE_PATH} (${(fs.statSync(BASE_PATH).size / 1024 / 1024).toFixed(2)} МБ)`);
