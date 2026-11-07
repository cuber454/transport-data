#!/usr/bin/env node
/**
 * Публикация базы расписаний.
 *
 * Что делает:
 *  1. Берёт четыре файла из assets (те же, что попадают в APK — расхождений быть не должно):
 *     база, пригород, загородные рейсы и метро.
 *  2. Считает размер и sha256 каждого.
 *  3. Кладёт их вместе с version.json в папку репозитория данных (data-repo).
 *  4. С --push заливает в GitHub по токену из .github-token (или GITHUB_TOKEN).
 *
 * Примеры:
 *   node scripts/publish-data.mjs                 # только подготовить файлы
 *   node scripts/publish-data.mjs --version 2026-11-03
 *   node scripts/publish-data.mjs --push          # подготовить и залить в GitHub
 *
 * Приложение проверяет version.json раз в сутки по Wi-Fi и скачивает файлы,
 * сверяя размер и контрольную сумму. Поэтому версия здесь — единственный источник правды.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = process.env.ASSETS_DIR ? join(process.cwd(), process.env.ASSETS_DIR) : join(root, 'app', 'app', 'src', 'main', 'assets');
const repoDir = process.env.DATA_DIR ? join(process.cwd(), process.env.DATA_DIR) : join(root, 'data-repo');
const files = ['base.json', 'suburban.json', 'extras.json', 'metro.json', 'addresses.json'];

const args = process.argv.slice(2);
const push = args.includes('--push');
const versionArg = args.indexOf('--version');
const version = versionArg >= 0 ? args[versionArg + 1] : today();

const OWNER = 'cuber454';
const REPO = 'transport-data';
const BRANCH = 'main';

function today() {
  const now = new Date();
  const moscow = new Date(now.getTime() + 3 * 60 * 60 * 1000); // Минск, UTC+3
  return moscow.toISOString().slice(0, 10);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return null;
  }
}

/** Простая проверка: файл читается как JSON и в нём есть то, что мы ждём. */
function sanity(name, path) {
  const json = readJson(path);
  if (json == null) throw new Error(`${name}: не читается как JSON`);
  if (name === 'base.json') {
    const routes = Array.isArray(json.routes) ? json.routes.length : 0;
    const stops = json.stops ? Object.keys(json.stops).length : 0;
    if (routes < 300) throw new Error(`base.json: подозрительно мало маршрутов (${routes})`);
    if (stops < 2000) throw new Error(`base.json: подозрительно мало остановок (${stops})`);
    return `маршрутов ${routes}, остановок ${stops}`;
  }
  if (name === 'suburban.json') {
    const routes = Array.isArray(json.routes) ? json.routes.length : 0;
    if (routes < 10) throw new Error(`suburban.json: подозрительно мало маршрутов (${routes})`);
    return `маршрутов ${routes}`;
  }
  if (name === 'metro.json') {
    const lines = Array.isArray(json.lines) ? json.lines.length : 0;
    const stations = Array.isArray(json.stations) ? json.stations.length : 0;
    if (lines < 3) throw new Error(`metro.json: подозрительно мало линий (${lines})`);
    if (stations < 30) throw new Error(`metro.json: подозрительно мало станций (${stations})`);
    const linked = json.stations.filter((station) => (station.links || []).length > 0).length;
    if (linked < stations - 2) throw new Error(`metro.json: станции без остановок рядом (${stations - linked})`);
    return `линий ${lines}, станций ${stations}, с подходами ${linked}`;
  }
  if (name === 'addresses.json') {
    // Адреса устроены иначе: не маршруты, а места, улицы и дома.
    const places = Array.isArray(json.places) ? json.places.length : 0;
    const streets = Array.isArray(json.streets) ? json.streets.length : 0;
    const houses = Array.isArray(json.houses) ? json.houses.length : 0;
    if (places < 100) throw new Error(`addresses.json: подозрительно мало мест (${places})`);
    if (streets < 500) throw new Error(`addresses.json: подозрительно мало улиц (${streets})`);
    if (houses < 5000) throw new Error(`addresses.json: подозрительно мало домов (${houses})`);
    return `мест ${places}, улиц ${streets}, домов ${houses}, собрано ${json.built ?? '—'}`;
  }
  const routes = Array.isArray(json.routes) ? json.routes.length : 0;
  if (routes < 100) throw new Error(`extras.json: подозрительно мало маршрутов (${routes})`);
  return `маршрутов ${routes}, собрано ${json.checked ?? '—'}`;
}

function main() {
  if (!existsSync(assets)) throw new Error(`нет папки assets: ${assets}`);
  mkdirSync(repoDir, { recursive: true });

  const versionJson = { version, builtAt: new Date().toISOString(), files: {} };
  console.log(`Версия: ${version}`);
  for (const name of files) {
    const source = join(assets, name);
    if (!existsSync(source)) throw new Error(`нет файла ${source}`);
    const description = sanity(name, source);
    const target = join(repoDir, name);
    copyFileSync(source, target);
    const size = readFileSync(target).length;
    versionJson.files[name] = { size, sha256: sha256(target) };
    console.log(`  ${name}: ${size} байт, ${description}`);
  }
  const versionPath = join(repoDir, 'version.json');
  // Блок про программу пишет publish-app.mjs — при пересборке данных его не теряем.
  let previous = null;
  if (existsSync(versionPath)) {
    try {
      previous = JSON.parse(readFileSync(versionPath, 'utf8'));
      if (previous.app) versionJson.app = previous.app;
    } catch (error) {
      // старый файл битый — не беда: блок вернётся при следующей публикации программы
    }
  }

  // Ничего не поменялось — не плодим коммиты и не гоняем телефоны скачивать то же самое.
  // Так ежемесячная проверка в облаке молча выходит, если расписание не изменилось.
  if (args.includes('--skip-if-same') && previous?.files) {
    const same = files.every((name) => {
      const before = previous.files[name];
      const now = versionJson.files[name];
      return before && now && before.sha256 === now.sha256 && before.size === now.size;
    });
    if (same) {
      console.log('Данные не изменились: никому ничего не отправляю.');
      return;
    }
  }

  writeFileSync(versionPath, JSON.stringify(versionJson, null, 2) + '\n', 'utf8');
  console.log(`version.json записан: ${versionPath}`);

  if (!push) {
    console.log('\nФайлы готовы, но не залиты. Чтобы залить:');
    console.log('  1) положи токен в transport/.github-token (право записи только в репозиторий данных)');
    console.log('  2) node scripts/publish-data.mjs --push');
    return;
  }
  upload(versionJson).catch((error) => {
    console.error('Не удалось залить:', error.message);
    process.exitCode = 1;
  });
}

function token() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const path = join(root, '.github-token');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  throw new Error('нет токена: положи его в .github-token или в переменную GITHUB_TOKEN');
}

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${text.slice(0, 200)}`);
  }
  return response.status === 204 ? null : response.json();
}

/**
 * Заливка по одному файлу через Contents API. Так не нужен git на машине и видна история
 * каждого обновления: отдельный коммит на версию.
 */
async function upload(versionJson) {
  const names = [...files, 'version.json'];
  for (const name of names) {
    const path = join(repoDir, name);
    const content = readFileSync(path).toString('base64');
    const url = `/repos/${OWNER}/${REPO}/contents/${name}`;
    let sha;
    try {
      const current = await api(`${url}?ref=${BRANCH}`);
      sha = current.sha;
    } catch (error) {
      // Файла ещё нет — это нормально для первого раза.
      if (!String(error.message).includes('404')) throw error;
    }
    await api(url, {
      method: 'PUT',
      body: JSON.stringify({
        message: `данные ${versionJson.version}: ${name}`,
        content,
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    console.log(`залито: ${name}`);
  }
  console.log(`\nГотово. Приложение увидит версию ${versionJson.version} в ближайшую проверку по Wi-Fi.`);
}

main();
