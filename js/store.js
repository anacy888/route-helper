// 一趟的資料存放處：存在這台裝置的瀏覽器裡，不會傳到別的地方。
(function () {
  'use strict';
  var KEY = 'shopee-route.trip.v1';

  // pending 查詢中、house 找到門牌、street 只找到大概位置、manual 手動指定、notfound 找不到、
  // failed 連線失敗、limit 今天查詢次數用完
  var GEO_STATUSES = ['pending', 'house', 'street', 'manual', 'notfound', 'failed', 'limit'];
  var SETTINGS_KEY = 'shopee-route.settings.v1';
  var ROUTE_KEY = 'shopee-route.route.v1';

  // 一件的欄位只在這裡定義一次。讀舊資料、存新資料都走這裡。
  function normalizeItem(raw, fallbackId) {
    if (!raw || typeof raw.address !== 'string' || !raw.address.trim()) return null;
    // 舊版把可送達時段存在 window 這個名字底下，讀進來時轉成 timeWindow。
    var timeWindow = typeof raw.timeWindow === 'string' ? raw.timeWindow : raw.window;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
      address: raw.address.trim(),
      type: raw.type === 'office' ? 'office' : 'home',
      timeWindow: typeof timeWindow === 'string' ? timeWindow.trim() : '',
      orderNo: typeof raw.orderNo === 'string' ? raw.orderNo.trim() : '',
      // 位置：由地址查詢或手動指定填入。
      lat: isFinite(raw.lat) && raw.lat !== null ? Number(raw.lat) : null,
      lng: isFinite(raw.lng) && raw.lng !== null ? Number(raw.lng) : null,
      geoStatus: GEO_STATUSES.indexOf(raw.geoStatus) >= 0 ? raw.geoStatus : 'pending',
      // 地址查詢找到位置的時間。Google 規定查到的位置最多留 30 天，過期要重查。
      geoAt: typeof raw.geoAt === 'number' && isFinite(raw.geoAt) ? raw.geoAt : null,
      // Google 認定的路名：'' 是 Google 沒給，null 是還沒有資料（舊版查的）。
      geoRoute: typeof raw.geoRoute === 'string' ? raw.geoRoute : null,
      // 路名跟 Google 的不一樣，但使用者按了「路名沒錯」。
      roadOk: raw.roadOk === true
    };
  }

  function clean(raw) {
    if (!raw || !Array.isArray(raw.items)) return [];
    return raw.items
      .map(function (item, index) { return normalizeItem(item, 'item-' + index); })
      .filter(Boolean);
  }

  window.TripStore = {
    normalizeItem: normalizeItem,
    loadSettings: function () {
      var settings = { defaultCity: '臺北市' };
      try {
        var saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY));
        if (saved && typeof saved.defaultCity === 'string' && saved.defaultCity) settings.defaultCity = saved.defaultCity;
        if (saved && saved.lastStart && isFinite(saved.lastStart.lat) && isFinite(saved.lastStart.lng) &&
          saved.lastStart.lat !== null && saved.lastStart.lng !== null) {
          settings.lastStart = { lat: Number(saved.lastStart.lat), lng: Number(saved.lastStart.lng) };
        }
        // 智取店的位置如果在地圖上手動調整過，記在這裡。
        if (saved && saved.storePoint && isFinite(saved.storePoint.lat) && isFinite(saved.storePoint.lng) &&
          saved.storePoint.lat !== null && saved.storePoint.lng !== null) {
          settings.storePoint = { lat: Number(saved.storePoint.lat), lng: Number(saved.storePoint.lng) };
        }
      } catch (error) {
        // 讀不到就用預設值。
      }
      return settings;
    },
    saveSettings: function (settings) {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        return true;
      } catch (error) {
        return false;
      }
    },
    // 排好的路線：站的順序（每站用併站的比對字串記）和起點。還沒排過回傳 null。
    loadRoute: function () {
      try {
        var saved = JSON.parse(window.localStorage.getItem(ROUTE_KEY));
        if (!saved || !Array.isArray(saved.order)) return null;
        var start = saved.start && isFinite(saved.start.lat) && isFinite(saved.start.lng) && saved.start.lat !== null
          ? { lat: Number(saved.start.lat), lng: Number(saved.start.lng) } : null;
        return { order: saved.order.filter(function (key) { return typeof key === 'string'; }), start: start, manual: saved.manual === true };
      } catch (error) {
        return null;
      }
    },
    saveRoute: function (route) {
      try {
        if (route) window.localStorage.setItem(ROUTE_KEY, JSON.stringify(route));
        else window.localStorage.removeItem(ROUTE_KEY);
        return true;
      } catch (error) {
        return false;
      }
    },
    load: function () {
      try {
        return clean(JSON.parse(window.localStorage.getItem(KEY)));
      } catch (error) {
        return [];
      }
    },
    // 存成功回傳 true。存不進去（例如無痕視窗或空間滿了）回傳 false。
    save: function (items) {
      try {
        window.localStorage.setItem(KEY, JSON.stringify({ items: clean({ items: items }) }));
        return true;
      } catch (error) {
        return false;
      }
    }
  };
})();
