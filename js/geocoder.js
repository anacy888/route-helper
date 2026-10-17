// 地址找位置。這一塊可以整塊換掉：
// geocode(查詢字串) 交回 { lat, lng, precision: 'house' | 'street', route: Google 認定的路名或 null }，找不到交回 null，
// 今天次數用完丟出 error.limit = true 的錯誤，其他連線或服務問題丟出一般錯誤。
// usage() 交回 { used, limit }，讀不到就丟出錯誤。
//
// 實際去問的是我們自己的中繼伺服器（設定在 js/config.js 的 relayUrl），
// 中繼伺服器再拿藏在 Cloudflare 的金鑰去問 Google，並限制每天最多查幾次。
// 依 Google 規定，查到的位置最多只能留 30 天，超過就當成沒查過。
// 每次中繼伺服器回報今天用了幾次，就在 window 發出 route-usage 事件（detail 是 { used, limit }）。
(function () {
  'use strict';

  var CACHE_KEY = 'shopee-route.geocache.v3'; // v3：改用 Google，每筆記下查詢時間
  var KEEP_MS = 30 * 24 * 60 * 60 * 1000;
  var queue = Promise.resolve();

  // 舊版（開放地圖）的查詢結果用不到了，清掉。
  try {
    window.localStorage.removeItem('shopee-route.geocache.v2');
  } catch (error) {
    // 清不掉也沒關係。
  }

  function relayUrl() {
    var config = window.ROUTE_CONFIG || {};
    return typeof config.relayUrl === 'string' ? config.relayUrl.replace(/\/+$/, '') : '';
  }

  function readCache() {
    try {
      return JSON.parse(window.localStorage.getItem(CACHE_KEY)) || {};
    } catch (error) {
      return {};
    }
  }

  function writeCache(cache) {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (error) {
      // 存不進去就算了，下次再查。
    }
  }

  function expired(entry, now) {
    return !entry || typeof entry.savedAt !== 'number' || now - entry.savedAt > KEEP_MS;
  }

  // 只用 30 天內的結果，過期的順便刪掉。
  function cached(query) {
    var cache = readCache();
    if (!Object.prototype.hasOwnProperty.call(cache, query)) return { hit: false };
    var entry = cache[query];
    // 舊版查到的結果沒有路名，重查一次補上（找不到的不用）。
    var noRoute = entry && entry.result && !Object.prototype.hasOwnProperty.call(entry.result, 'route');
    if (noRoute || expired(entry, Date.now())) {
      delete cache[query];
      writeCache(cache);
      return { hit: false };
    }
    return { hit: true, value: cache[query].result };
  }

  function remember(query, result) {
    var cache = readCache();
    var now = Date.now();
    Object.keys(cache).forEach(function (key) {
      if (expired(cache[key], now)) delete cache[key];
    });
    cache[query] = { result: result, savedAt: now };
    writeCache(cache);
  }

  function announce(data) {
    if (!data || !isFinite(data.used) || !isFinite(data.limit) || data.used === null || data.limit === null) return;
    try {
      window.dispatchEvent(new CustomEvent('route-usage', { detail: { used: Number(data.used), limit: Number(data.limit) } }));
    } catch (error) {
      // 發不出事件就算了，不影響查詢。
    }
  }

  function getJson(path) {
    var base = relayUrl();
    if (!base) return Promise.reject(new Error('沒有設定中繼伺服器網址'));
    return window.fetch(base + path, { headers: { Accept: 'application/json' } }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { ok: response.ok, httpStatus: response.status, data: data || {} };
      });
    });
  }

  function ask(query) {
    return getJson('/geocode?address=' + encodeURIComponent(query)).then(function (reply) {
      var data = reply.data;
      announce(data);
      if (data.status === 'limit' || reply.httpStatus === 429) {
        var limitError = new Error('今天的查詢次數已用完');
        limitError.limit = true;
        throw limitError;
      }
      if (reply.ok && data.status === 'ok' && isFinite(data.lat) && isFinite(data.lng)) {
        return {
          lat: Number(data.lat),
          lng: Number(data.lng),
          precision: data.precision === 'house' ? 'house' : 'street',
          route: typeof data.route === 'string' && data.route ? data.route : null
        };
      }
      if (reply.ok && data.status === 'notfound') return null;
      throw new Error('查詢服務回應 ' + reply.httpStatus + ' ' + (data.reason || ''));
    });
  }

  function geocode(query) {
    var early = cached(query);
    if (early.hit) return Promise.resolve(early.value);
    // 一筆一筆排隊送出；排隊期間同一個地址被查過，就直接用查過的結果。
    var job = queue.then(function () {
      var again = cached(query);
      if (again.hit) return again.value;
      return ask(query).then(function (result) {
        remember(query, result); // 找到、找不到都記住；失敗和次數用完不記，下次再查
        return result;
      });
    });
    queue = job.catch(function () {});
    return job;
  }

  function usage() {
    return getJson('/usage').then(function (reply) {
      var data = reply.data;
      if (!reply.ok || !isFinite(data.used) || !isFinite(data.limit) || data.used === null) throw new Error('讀不到今天的次數');
      announce(data);
      return { used: Number(data.used), limit: Number(data.limit) };
    });
  }

  window.RouteGeocoder = { geocode: geocode, usage: usage };
})();
