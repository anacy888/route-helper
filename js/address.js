// 把清單上的地址整理成拿去查位置的字串。只處理寫法，不連網路。
(function () {
  'use strict';

  var CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  // 開頭兩個字加上「市」或「縣」，例如臺北市、新北市、新竹縣。
  var CITY_PATTERN = /^[一-鿿]{2}[市縣]/;

  function toHalfWidth(text) {
    return text.replace(/[！-～]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    });
  }

  function findCity(address) {
    var match = toHalfWidth(address).replace(/\s+/g, '').match(CITY_PATTERN);
    return match ? match[0].replace(/^台/, '臺') : '';
  }

  // 例：「範例街2段80號5樓之4」配上預設城市「臺北市」，得到「臺北市範例街二段80號」。
  function buildQuery(address, defaultCity) {
    var text = toHalfWidth(address).replace(/\s+/g, '')
      .replace(/^\d{3,6}(?=[\u4e00-\u9fff])/, ''); // 開頭的郵遞區號，例如 108
    var numberEnd = text.indexOf('號');
    if (numberEnd >= 0) text = text.slice(0, numberEnd + 1); // 樓層、之幾樓、店名都在「號」後面
    text = text.replace(/(\d+)-(\d+)號$/, '$1之$2號');
    text = text.replace(/(\d)段/g, function (all, digit) { return CN_DIGITS[Number(digit)] + '段'; });
    var city = findCity(text);
    var rest = city ? text.slice(city.length) : text;
    // 區後面的「某某里」「幾鄰」查位置用不到，而且會讓查詢服務找不到路名。
    var district = (rest.match(/^[\u4e00-\u9fff]{2}區(?=[\u4e00-\u9fff])/) || [''])[0];
    rest = district + rest.slice(district.length)
      .replace(/^[\u4e00-\u9fff]{1,3}里(?=[\u4e00-\u9fff\d])/, '')
      .replace(/^\d+鄰/, '');
    return (city || defaultCity) + rest;
  }

  // 併站用：路、巷、弄、號一樣就得到同一個字串。樓層、樓層的之幾、區、里、鄰都不算，
  // 門牌的之（124之2號）照算。沒寫縣市的當成預設城市，避免別的縣市同名路被併在一起。
  // 例：「台北市萬華區範甲街2段80號5樓之4」和「範甲街二段80號6樓之4」都得到「臺北市範甲街二段80號」。
  function stopKey(address, defaultCity) {
    var query = buildQuery(address, defaultCity);
    var city = findCity(query);
    return city + query.slice(city.length).replace(/^[一-鿿]{2}區(?=[一-鿿])/, '');
  }

  // 併起來的站要顯示的名稱：去掉縣市，例如「範甲街二段80號」。
  function stopLabel(address, defaultCity) {
    var key = stopKey(address, defaultCity);
    return key.slice(findCity(key).length) || key;
  }

  var ZHUYIN = /[\u3105-\u312f\u31a0-\u31bf\u02ca\u02c7\u02cb\u02d9]/;
  // 地址裡可以出現的字：中文、數字、之、-、括號、頓號逗號。其他的算奇怪的符號。
  var NORMAL_CHAR = /[\u4e00-\u9fff0-9\-()（）、，,]/;

  // 看地址像不像打錯字，回傳原因列表，沒問題回傳空陣列。
  // 只檢查「號」前面的部分，後面的樓層、店名（例如 10F）不管。
  function suspicious(address) {
    var text = toHalfWidth(address || '').replace(/\s+/g, '');
    var reasons = [];
    if (ZHUYIN.test(text)) reasons.push('有注音符號');
    var end = text.indexOf('號');
    if (end < 0) {
      reasons.push('找不到「號」');
      return reasons;
    }
    var before = text.slice(0, end);
    if (!/[0-9一二三四五六七八九十]$/.test(before)) reasons.push('號前面沒有門牌號碼');
    if (/[A-Za-z]/.test(before)) reasons.push('號前面有英文字母');
    var odd = before.split('').some(function (ch) {
      return !NORMAL_CHAR.test(ch) && !ZHUYIN.test(ch) && !/[A-Za-z]/.test(ch);
    });
    if (odd) reasons.push('號前面有奇怪的符號');
    return reasons;
  }

  // 地址裡的路名，去掉段、巷、門牌。例：「台北市萬華區範甲街2段80號」得到「範甲街」。
  function roadOf(address, defaultCity) {
    var key = stopKey(address, defaultCity);
    var rest = key.slice(findCity(key).length).replace(/\d.*$/, '').replace(/號$/, '');
    return rest.replace(/[一二三四五六七八九十]+段$/, '');
  }

  // 比對打的路名和 Google 認定的路名。不一樣回傳 { typed, google }，一樣或沒辦法比回傳 null。
  function roadMismatch(address, defaultCity, googleRoute) {
    if (!googleRoute) return null;
    var google = toHalfWidth(googleRoute).replace(/\s+/g, '').replace(/\d+[巷弄].*$/, '')
      .replace(/(\d+|[一二三四五六七八九十]+)段$/, '');
    var typed = roadOf(address, defaultCity);
    if (!google || !typed) return null;
    if (typed === google || typed.indexOf(google) === 0 || google.indexOf(typed) === 0) return null;
    return { typed: typed, google: google, close: editDistance(typed, google) <= 1 };
  }

  // 兩個字串差幾個字（換、加、刪各算一個）。
  function editDistance(a, b) {
    var row = [];
    for (var j = 0; j <= b.length; j += 1) row.push(j);
    for (var i = 1; i <= a.length; i += 1) {
      var prev = row[0];
      row[0] = i;
      for (var k = 1; k <= b.length; k += 1) {
        var keep = row[k];
        row[k] = Math.min(row[k] + 1, row[k - 1] + 1, prev + (a[i - 1] === b[k - 1] ? 0 : 1));
        prev = keep;
      }
    }
    return row[b.length];
  }

  window.RouteAddress = {
    buildQuery: buildQuery, findCity: findCity, stopKey: stopKey, stopLabel: stopLabel,
    suspicious: suspicious, roadOf: roadOf, roadMismatch: roadMismatch
  };
})();
