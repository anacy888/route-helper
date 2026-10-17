// 送貨路線小幫手的中繼伺服器（放在 Cloudflare Workers）。
//
// 做三件事：
// 1. 只接受從 https://anacy888.github.io 打開的網頁來的請求。
// 2. 記錄臺灣時間今天查了幾次，每天最多 DAILY_LIMIT 次，超過就不再查。
// 3. 拿存在 Cloudflare 設定裡的金鑰（GOOGLE_GEOCODING_KEY）去問 Google 地址查詢，把位置回傳。
//
// 這個檔案裡不放任何金鑰。需要的 Cloudflare 設定：
// - 祕密變數 GOOGLE_GEOCODING_KEY：地址查詢用的 Google 金鑰
// - 資料存放（KV）綁定，名稱 COUNTER：記錄每天查了幾次

const ALLOWED_ORIGIN = 'https://anacy888.github.io';
const DAILY_LIMIT = 300;
const MAX_ADDRESS_LENGTH = 200;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, corsHeaders())
  });
}

// 臺灣時間的日期，例如 2026-10-13。
function taipeiDate(now) {
  return new Date(now + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

async function usedToday(env, now) {
  const value = await env.COUNTER.get('count:' + taipeiDate(now));
  const count = parseInt(value, 10);
  return isFinite(count) ? count : 0;
}

// Google 認定的路名，例如「範例路」。網頁拿來比對使用者有沒有打錯路名。
function routeOf(result) {
  var parts = result.address_components || [];
  for (var i = 0; i < parts.length; i += 1) {
    if (parts[i].types && parts[i].types.indexOf('route') >= 0) return parts[i].long_name;
  }
  return null;
}

// Google 回答的精確程度：找到那一棟（或門牌區間）算 house，其他算 street。
function precisionOf(result) {
  const type = result.geometry && result.geometry.location_type;
  if (result.partial_match) return 'street';
  return type === 'ROOFTOP' || type === 'RANGE_INTERPOLATED' ? 'house' : 'street';
}

export async function handle(request, env, now, fetchImpl) {
  const fetcher = fetchImpl || fetch;
  if (request.headers.get('Origin') !== ALLOWED_ORIGIN) {
    return new Response('Forbidden', { status: 403 });
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET') return reply(405, { status: 'error', reason: 'method' });

  if (!env.COUNTER) return reply(500, { status: 'error', reason: 'missing-counter' });
  const url = new URL(request.url);
  if (url.pathname === '/usage') {
    return reply(200, { status: 'usage', used: await usedToday(env, now), limit: DAILY_LIMIT });
  }
  if (url.pathname !== '/geocode') return reply(404, { status: 'error', reason: 'not-found' });

  const address = (url.searchParams.get('address') || '').trim();
  if (!address || address.length > MAX_ADDRESS_LENGTH) return reply(400, { status: 'error', reason: 'bad-address' });
  if (!env.GOOGLE_GEOCODING_KEY) return reply(500, { status: 'error', reason: 'missing-key' });

  const used = await usedToday(env, now);
  if (used >= DAILY_LIMIT) return reply(429, { status: 'limit', used: used, limit: DAILY_LIMIT });
  const nowUsed = used + 1;
  // 先記次數再查，查失敗也算一次，避免被重複嘗試繞過上限。保留三天後自動刪除。
  await env.COUNTER.put('count:' + taipeiDate(now), String(nowUsed), { expirationTtl: 3 * 24 * 60 * 60 });

  const google = 'https://maps.googleapis.com/maps/api/geocode/json' +
    '?address=' + encodeURIComponent(address) +
    '&language=zh-TW&region=tw&components=' + encodeURIComponent('country:TW') +
    '&key=' + encodeURIComponent(env.GOOGLE_GEOCODING_KEY);
  let data;
  try {
    const response = await fetcher(google);
    data = await response.json();
  } catch (error) {
    return reply(502, { status: 'error', reason: 'google-unreachable' });
  }

  if (data.status === 'OK' && data.results && data.results.length) {
    const first = data.results[0];
    const body = {
      status: 'ok',
      lat: first.geometry.location.lat,
      lng: first.geometry.location.lng,
      precision: precisionOf(first),
      used: nowUsed,
      limit: DAILY_LIMIT
    };
    const route = routeOf(first);
    if (route) body.route = route;
    if (first.formatted_address) body.formatted = first.formatted_address;
    return reply(200, body);
  }
  if (data.status === 'ZERO_RESULTS') return reply(200, { status: 'notfound', used: nowUsed, limit: DAILY_LIMIT });
  return reply(502, { status: 'error', reason: String(data.status || 'unknown') });
}

export default {
  fetch(request, env) {
    return handle(request, env, Date.now());
  }
};
