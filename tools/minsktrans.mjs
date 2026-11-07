// Клиент неофициального JSON «Виртуального табло» Минсктранса.
// Только то, что реально нужно: сессия с токеном, борта, остановки, маршруты, расписание.

const BASE = 'https://minsktrans.by/lookout_yard';
const PAGE = `${BASE}/Home/Index/minsk`;
const UA = 'minsktransport-voice/0.1 (personal, non-commercial, accessibility helper)';

let cookies = [];
let token = null;
let tokenTime = 0;

function cookieHeader() {
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

// Сервер объявляет в заголовке windows-1251, а отдаёт UTF-8: res.text() в таком
// случае читает кириллицу как cp1251 и получается «РЎС‚Р°РЅС†РёСЏ». Поэтому байты
// декодируем сами, всегда как UTF-8.
async function readUtf8(res) {
  const buf = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder('utf-8').decode(buf);
}

function storeCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const pair = line.split(';')[0];
    const name = pair.split('=')[0];
    cookies = cookies.filter((c) => c.split('=')[0] !== name);
    cookies.push(pair);
  }
}

async function refreshSession() {
  cookies = [];
  const res = await fetch(PAGE, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    redirect: 'follow',
  });
  storeCookies(res);
  const html = await readUtf8(res);
  const m = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!m) throw new Error('не нашёл токен на странице табло');
  token = m[1];
  tokenTime = Date.now();
  return token;
}

async function post(action, params, { retry = true } = {}) {
  if (!token) await refreshSession();
  const body = new URLSearchParams({ ...params, __RequestVerificationToken: token });
  const res = await fetch(`${BASE}/Data/${action}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: PAGE,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      ...(cookies.length ? { Cookie: cookieHeader() } : {}),
    },
    body: body.toString(),
    redirect: 'follow',
  });
  storeCookies(res);
  if (res.status === 204) return null;
  if (!res.ok) {
    if (retry) {
      await refreshSession();
      return post(action, params, { retry: false });
    }
    throw new Error(`${action}: HTTP ${res.status}`);
  }
  const text = await readUtf8(res);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${action}: ответ не JSON (${text.slice(0, 80)})`);
  }
}

export const REGION = 'minsk';

export function vehicles(transportType, routeNumber, region = REGION) {
  return post('Vehicles', { p: region, tt: transportType, r: routeNumber });
}

export function nearestStops(lat, lon, region = REGION) {
  return post('NearestStops', { p: region, lat: String(lat), lon: String(lon) });
}

export function routeList(transportType, region = REGION) {
  return post('RouteList', { p: region, tt: transportType });
}

export function routeInfo(transportType, routeNumber, region = REGION) {
  return post('Route', { p: region, tt: transportType, r: routeNumber });
}

export function schedulesByStop(stopId, region = REGION) {
  return post('SchedulesByStop', { place: region, lang: 'ru', stopId: String(stopId) });
}

export function stopName(stopId) {
  return post('StopName', { stopid: String(stopId) });
}

export async function warmup() {
  await refreshSession();
}

export function sessionAge() {
  return token ? Date.now() - tokenTime : null;
}

// --- геометрия ---

export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearingWord(deg) {
  if (deg == null || deg < 0) return null;
  const dirs = ['север', 'северо-восток', 'восток', 'юго-восток', 'юг', 'юго-запад', 'запад', 'северо-запад'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
