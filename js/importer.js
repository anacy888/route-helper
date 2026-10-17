// 把認字結果整理成清單上的件。只處理文字，不碰圖片也不連網路。
// parse(一張截圖認出的文字) 交回這張的卡片：
//   [{ orderNo, address, timeWindow, type, partial }]，partial 是看不到訂單編號（截圖頂端被切掉）的半張卡片。
// merge([每張的卡片]) 交回 { items, duplicates, noOrder, noAddress }：
//   重複截到的用訂單編號去掉，半張卡片用地址對回完整的那張。
(function (root) {
  'use strict';

  var TW = /TW[0-9A-Za-z]{12,14}/;
  var TIMES = /(\d{1,2}):(\d{2})\s*[-~－～]\s*(\d{1,2}):(\d{2})/;
  var DEFAULT_TIMES = { '全天': '08:00-22:00', '白天': '08:00-18:00', '僅白天': '08:00-18:00' };

  function compact(text) {
    return String(text || '').replace(/\s+/g, '');
  }

  // 訂單編號：TW 後面除了最後一碼都是數字，把認成英文字母的 O、I、l 換回數字。
  function cleanOrderNo(raw) {
    var text = compact(raw).toUpperCase();
    var body = text.slice(2, -1).replace(/O/g, '0').replace(/[IL]/g, '1');
    return 'TW' + body + text.slice(-1);
  }

  // 認字常見的錯：「北」認成「此」。臺灣的路名幾乎沒有「○此路」，直接改回來。
  function cleanAddress(raw) {
    var text = compact(raw);
    // 地址前面的定位圖示常被認成「9」「0」「@」之類的符號；開頭是 3 到 6 碼的郵遞區號才留著。
    var lead = text.match(/^[^一-鿿]*/)[0];
    if (!/^\d{3,6}$/.test(lead)) text = text.slice(lead.length);
    return text.replace(/此路/g, '北路');
  }

  function looksLikeAddress(line) {
    return /號/.test(line) && /[路街道巷段]/.test(line) && !/可收|配送|導航|地圖/.test(line);
  }

  function timeWindowOf(line) {
    var label = /僅白天/.test(line) ? '僅白天' : /全天/.test(line) ? '全天' : /白天/.test(line) ? '白天' : '';
    if (!label) return '';
    var m = line.match(TIMES);
    var times = m && m[4].length === 2 ? pad(m[1]) + ':' + m[2] + '-' + pad(m[3]) + ':' + m[4] : DEFAULT_TIMES[label];
    return label + ' ' + times;
  }

  function pad(hour) {
    return hour.length === 1 ? '0' + hour : hour;
  }

  function parse(text) {
    var cards = [];
    var current = null;
    String(text || '').split(/\r?\n/).forEach(function (rawLine) {
      var line = compact(rawLine);
      if (!line) return;
      var tw = line.match(TW);
      if (tw) {
        current = { orderNo: cleanOrderNo(tw[0]), address: '', timeWindow: '', type: 'home', partial: false };
        cards.push(current);
        return;
      }
      if (looksLikeAddress(line)) {
        // 卡片的順序是編號、地址、時段。還沒看到編號，或這張卡已經有地址或時段了，
        // 這個地址就屬於另一張卡（截圖頂端被切掉的半張卡片）。
        if (!current || current.address || current.timeWindow) {
          current = { orderNo: '', address: '', timeWindow: '', type: 'home', partial: true };
          cards.push(current);
        }
        current.address = cleanAddress(line);
        return;
      }
      if (!current) return;
      if (/可收/.test(line) && !current.timeWindow) {
        current.timeWindow = timeWindowOf(line);
        return;
      }
      if (/^off[il1]ce$/i.test(line) || /^0ff[il1]ce$/i.test(line)) current.type = 'office';
    });
    return cards;
  }

  function fill(target, from) {
    if (!target.address && from.address) target.address = from.address;
    if (!target.timeWindow && from.timeWindow) target.timeWindow = from.timeWindow;
    if (from.type === 'office') target.type = 'office';
  }

  function merge(pages) {
    var items = [];
    var byOrder = {};
    var duplicates = 0;
    var partials = [];
    pages.forEach(function (cards) {
      cards.forEach(function (card) {
        if (card.partial) {
          partials.push(card);
          return;
        }
        if (byOrder[card.orderNo]) {
          duplicates += 1;
          fill(byOrder[card.orderNo], card);
          return;
        }
        var copy = { orderNo: card.orderNo, address: card.address, timeWindow: card.timeWindow, type: card.type };
        byOrder[card.orderNo] = copy;
        items.push(copy);
      });
    });
    var noOrder = [];
    partials.forEach(function (card) {
      var match = items.filter(function (item) { return item.address && item.address === card.address; })[0];
      if (match) {
        duplicates += 1;
        fill(match, card);
        return;
      }
      var again = noOrder.filter(function (item) { return item.address === card.address; })[0];
      if (again) {
        duplicates += 1;
        fill(again, card);
        return;
      }
      var copy = { orderNo: '', address: card.address, timeWindow: card.timeWindow, type: card.type };
      noOrder.push(copy);
    });
    var noAddress = items.filter(function (item) { return !item.address; }).map(function (item) { return item.orderNo; });
    return {
      items: items.filter(function (item) { return item.address; }).concat(noOrder),
      duplicates: duplicates,
      noOrder: noOrder.map(function (item) { return item.address; }),
      noAddress: noAddress
    };
  }

  var api = { parse: parse, merge: merge, cleanAddress: cleanAddress, cleanOrderNo: cleanOrderNo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RouteImport = api;
})(this);
